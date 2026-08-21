/**
 * MODEL RUNTIME
 *
 * The governed path from a handler's request to a provider's response.
 * Every check here runs BEFORE the provider is called or the result is
 * trusted; none of them run inside the Broker, and none of them decide
 * whether a TOOL may execute — that remains entirely the Broker's job.
 *
 * ── THE BOUNDARY THIS FILE EXISTS TO ENFORCE ────────────────────────────
 *
 * agent → runtime → MODEL RUNTIME → provider → structured result
 *                        │
 *                        └─→ validated, budgeted, bounded
 *
 * agent → runtime → Broker → tool          (unchanged, separate path)
 *
 * invokeModel() has no reference to a Broker, to store's mutation methods
 * (setActiveVersion, setLifecycleState, addFreeze, chargeBudgets on tool
 * budgets), to agents.js, or to anything that grants clearance, approves a
 * version, or authorizes an action. It cannot bypass the Broker because it
 * cannot reach it — this is a structural fact, checked by
 * tests/model-runtime.test.js, not a promise kept by convention.
 *
 * A model's output is data. If a handler chooses to hand that data to
 * callTool() as if it were an instruction, the Broker evaluates it exactly
 * as it would any other payload — on the agent's actual clearance, actual
 * allowlist, actual approval state. The model saying "approved" changes
 * nothing. See tests/model-runtime.test.js's adversarial tests.
 *
 * ── WHAT "TIMEOUT" MEANS HERE, HONESTLY ─────────────────────────────────
 *
 * The mock provider is synchronous. This file measures elapsed time via
 * the injected clock and classifies a call that took longer than the
 * model's configured ceiling as TIMEOUT, after the fact. It does not, and
 * currently cannot, preemptively cancel a call in progress — that requires
 * a genuinely asynchronous, cancellable provider (AbortController or
 * equivalent), which does not exist yet. Do not describe this as
 * preemptive cancellation. See DECISIONS.md D24.
 *
 * Constitution: sections 13, 22, 23.
 */

import { checkContract } from './contracts.js';

export const MODEL_REASON = Object.freeze({
  OK: 'OK',
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNKNOWN_PROVIDER: 'UNKNOWN_PROVIDER',
  UNKNOWN_MODEL: 'UNKNOWN_MODEL',
  INPUT_LIMIT_EXCEEDED: 'INPUT_LIMIT_EXCEEDED',
  OUTPUT_LIMIT_EXCEEDED: 'OUTPUT_LIMIT_EXCEEDED',
  BUDGET_MISSING: 'BUDGET_MISSING',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  TIMEOUT: 'TIMEOUT',
  RETRY_CEILING_EXCEEDED: 'RETRY_CEILING_EXCEEDED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  OUTPUT_CONTRACT_VIOLATION: 'OUTPUT_CONTRACT_VIOLATION',
});

/** No request may ask for more retries than this, however it is configured. */
const MAX_RETRY_CEILING = 3;

function budgetKey(providerId, modelId) {
  return `${providerId}:${modelId}`;
}

/**
 * @param {object} deps
 * @param {{getProvider:Function, getModel:Function}} deps.registry
 * @param {object} deps.audit
 * @param {() => number} deps.clock
 * @param {{provider_id:string, model_id:string, limit:number}[]} [deps.modelBudgets]
 *   Provider/model-level spend ceilings, in COST_UNITS. This is the one
 *   budget dimension M7 implements. Per-task and per-agent model-spend
 *   accounting are not yet wired to this layer — recorded as a limitation
 *   in DECISIONS.md D24, not silently implied by this parameter's name.
 */
export function createModelRuntime({ registry, audit, clock, modelBudgets = [] }) {
  const budgets = new Map(modelBudgets.map((b) => [budgetKey(b.provider_id, b.model_id), { limit: b.limit, spent: 0 }]));

  function invokeModel(request) {
    const startedAt = clock();

    const settle = (status, reason, patch = {}) => {
      const record = {
        event: 'model.invocation',
        at: clock(),
        agent_slug: request?.agent_slug ?? null,
        task_id: request?.task_id ?? null,
        tree_id: request?.tree_id ?? null,
        provider_id: request?.provider_id ?? null,
        model_id: request?.model_id ?? null,
        status,
        reason,
        elapsed_ms: clock() - startedAt,
        ...patch,
      };
      audit.write(record);
      return record;
    };

    // 0 — request shape
    if (!request || typeof request !== 'object') return settle('failed', MODEL_REASON.INVALID_REQUEST, { output: null, error: 'no request' });
    if (typeof request.provider_id !== 'string' || typeof request.model_id !== 'string') {
      return settle('failed', MODEL_REASON.INVALID_REQUEST, { output: null, error: 'provider_id and model_id are required' });
    }
    if (request.input === undefined) {
      return settle('failed', MODEL_REASON.INVALID_REQUEST, { output: null, error: 'input is required' });
    }

    // 1 — provider and model must be registered. Fail closed on either.
    const provider = registry.getProvider(request.provider_id);
    if (!provider) return settle('failed', MODEL_REASON.UNKNOWN_PROVIDER, { output: null });

    const model = registry.getModel(request.provider_id, request.model_id);
    if (!model) return settle('failed', MODEL_REASON.UNKNOWN_MODEL, { output: null });

    // 2 — input size ceiling, before the provider ever sees it
    const inputSize = JSON.stringify(request.input).length;
    if (inputSize > model.max_input_units) {
      return settle('failed', MODEL_REASON.INPUT_LIMIT_EXCEEDED, { output: null, detail: `${inputSize} > ${model.max_input_units}` });
    }

    // 3 — budget pre-check, using the model's declared worst-case cost.
    // Charged for real only after a successful call; a denial spends nothing.
    const key = budgetKey(request.provider_id, request.model_id);
    const budget = budgets.get(key);
    if (!budget) return settle('failed', MODEL_REASON.BUDGET_MISSING, { output: null });
    if (budget.spent + model.max_cost_per_call > budget.limit) {
      return settle('failed', MODEL_REASON.BUDGET_EXCEEDED, {
        output: null,
        detail: `${budget.spent}+${model.max_cost_per_call} > ${budget.limit}`,
      });
    }

    // 4 — bounded retry loop. The ceiling is clamped regardless of what the
    // request or the model config asks for: no caller can request unlimited
    // retries.
    const maxAttempts = 1 + Math.min(
      request.max_retries ?? model.default_max_retries,
      MAX_RETRY_CEILING,
    );

    let attempts = 0;
    let lastReason = null;
    let lastDetail = null;
    let raw = null;

    while (attempts < maxAttempts) {
      attempts++;
      const t0 = clock();
      try {
        raw = model.invoke({ input: request.input });
      } catch (err) {
        lastReason = MODEL_REASON.PROVIDER_ERROR;
        lastDetail = String(err.message);
        raw = null;
        continue;
      }
      const elapsed = clock() - t0;
      if (elapsed > model.timeout_ms) {
        lastReason = MODEL_REASON.TIMEOUT;
        lastDetail = `${elapsed}ms > ${model.timeout_ms}ms ceiling`;
        raw = null;
        continue;
      }
      break; // success
    }

    if (raw === null) {
      const finalReason = attempts >= maxAttempts && attempts > 1 ? MODEL_REASON.RETRY_CEILING_EXCEEDED : lastReason;
      return settle('failed', finalReason, { output: null, attempts, detail: lastDetail });
    }

    // 5 — output size ceiling
    const outputSize = JSON.stringify(raw.output).length;
    if (outputSize > model.max_output_units) {
      return settle('failed', MODEL_REASON.OUTPUT_LIMIT_EXCEEDED, { output: null, attempts, detail: `${outputSize} > ${model.max_output_units}` });
    }

    // 6 — output contract, if the caller declared one. A model's output is
    // untrusted data until it passes this; failing here never becomes an
    // authorization decision and never reaches callTool on its own.
    if (request.output_contract) {
      const contractError = checkContract(request.output_contract, raw.output);
      if (contractError) {
        return settle('failed', MODEL_REASON.OUTPUT_CONTRACT_VIOLATION, { output: null, attempts, detail: contractError });
      }
    }

    // 7 — charge for the actual call, only now that it succeeded
    const cost = raw.usage.input_units * model.cost_per_input_unit + raw.usage.output_units * model.cost_per_output_unit;
    budget.spent += cost;

    return settle('ok', MODEL_REASON.OK, { output: raw.output, usage: raw.usage, cost, attempts });
  }

  return { invokeModel };
}

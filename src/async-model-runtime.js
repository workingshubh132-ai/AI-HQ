/**
 * ASYNC MODEL RUNTIME (Milestone 12)
 *
 * The exact same governed pipeline model-runtime.js already runs
 * (validate → provider/model lookup → input size limit → budget
 * precheck → bounded retry → output size limit → output contract →
 * charge → audit) — mirrored here with `await`, for providers whose
 * `invoke()` returns a Promise because it makes a real network call.
 * Every MODEL_REASON code, every ceiling, every check is reused from
 * model-runtime.js, not reinvented — this file only exists because
 * "await a Promise" cannot be retrofitted onto a function every existing
 * caller invokes synchronously without awaiting it.
 *
 * NOT wired into runtime.js's `callModel` — that wrapper calls
 * `modelRuntime.invokeModel(...)` synchronously, exactly like every
 * handler built against it (M5–M11) expects. Making this the live path
 * requires handlers themselves to become async, and runtime.js to await
 * them — the identical class of change DECISIONS.md D28 already deferred
 * for postgres-store.js, extended here to the model layer. See D29.
 *
 * ── system instructions ─────────────────────────────────────────────
 *
 * `request.system`, if present, is passed straight through to the
 * provider's `invoke({input, system})` — untouched, unvalidated beyond
 * being a string, exactly as `input` itself is untouched. Neither this
 * file nor the provider treats it as anything but data handed to the
 * model; it grants no authority and is not consulted by any check below.
 *
 * Constitution: sections 13, 22, 23.
 */

import { checkContract } from './contracts.js';
import { MODEL_REASON, budgetKey } from './model-runtime.js';

export { MODEL_REASON };

/** Same clamp as model-runtime.js — no caller may request more, however
 * the request or the model's own config asks for it. */
const MAX_RETRY_CEILING = 3;

/**
 * @param {object} deps
 * @param {{getProvider:Function, getModel:Function}} deps.registry
 * @param {object} deps.audit
 * @param {() => number} deps.clock
 * @param {{provider_id:string, model_id:string, limit:number}[]} [deps.modelBudgets]
 */
export function createAsyncModelRuntime({ registry, audit, clock, modelBudgets = [] }) {
  const budgets = new Map(modelBudgets.map((b) => [budgetKey(b.provider_id, b.model_id), { limit: b.limit, spent: 0 }]));

  async function invokeModel(request) {
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
    if (request.system !== undefined && typeof request.system !== 'string') {
      return settle('failed', MODEL_REASON.INVALID_REQUEST, { output: null, error: 'system, if present, must be a string' });
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
    const key = budgetKey(request.provider_id, request.model_id);
    const budget = budgets.get(key);
    if (!budget) return settle('failed', MODEL_REASON.BUDGET_MISSING, { output: null });
    if (budget.spent + model.max_cost_per_call > budget.limit) {
      return settle('failed', MODEL_REASON.BUDGET_EXCEEDED, {
        output: null,
        detail: `${budget.spent}+${model.max_cost_per_call} > ${budget.limit}`,
      });
    }

    // 4 — bounded retry loop, with GENUINE preemptive timeout: a real
    // async provider can actually be raced against a timer and abandoned
    // (its eventual resolution is simply never awaited further), unlike
    // the synchronous mock model-runtime.js measures after the fact.
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
        raw = await withTimeout(model.invoke({ input: request.input, system: request.system }), model.timeout_ms);
      } catch (err) {
        if (err instanceof TimeoutError) {
          lastReason = MODEL_REASON.TIMEOUT;
          lastDetail = `exceeded ${model.timeout_ms}ms ceiling`;
        } else {
          lastReason = MODEL_REASON.PROVIDER_ERROR;
          lastDetail = String(err.message);
        }
        raw = null;
        continue;
      }
      const elapsed = clock() - t0;
      if (elapsed > model.timeout_ms) {
        // Belt and suspenders: the provider resolved, but too slowly by
        // the injected clock's account (matters for deterministic tests
        // using a fake clock, where withTimeout's real setTimeout cannot
        // observe the same fictional time).
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

    // 6 — output contract, if the caller declared one.
    if (request.output_contract) {
      const contractError = checkContract(request.output_contract, raw.output);
      if (contractError) {
        return settle('failed', MODEL_REASON.OUTPUT_CONTRACT_VIOLATION, { output: null, attempts, detail: contractError });
      }
    }

    // 7 — charge for the actual call, only now that it succeeded. A
    // provider reporting missing, negative, or non-numeric usage (M13
    // adversarial scenario: "impossible/invalid usage") must never reach
    // the budget ledger as-is — NaN or a negative number here would
    // silently corrupt `budget.spent` forever (NaN poisons every future
    // `>` comparison to `false`, permanently defeating the budget check).
    // Fall back to the model's own declared worst-case ceiling instead —
    // never less conservative than trusting bad data, and distinguishable
    // from a real measurement via `usage_status`.
    const inputUnits = sanitizeUsageUnits(raw.usage?.input_units);
    const outputUnits = sanitizeUsageUnits(raw.usage?.output_units);
    const usageValid = inputUnits !== null && outputUnits !== null;
    const cost = usageValid
      ? inputUnits * model.cost_per_input_unit + outputUnits * model.cost_per_output_unit
      : model.max_cost_per_call;
    budget.spent += cost;

    return settle('ok', MODEL_REASON.OK, {
      output: raw.output,
      usage: usageValid ? raw.usage : null,
      usage_status: usageValid ? 'ACTUAL' : 'ESTIMATED',
      cost,
      attempts,
    });
  }

  return { invokeModel };
}

/** A finite, non-negative usage figure, or null. Exported so
 * resource-governor.js (M13) reuses the identical validation instead of
 * redefining it — both files must agree on what "impossible/invalid
 * usage" means. */
export function sanitizeUsageUnits(v) {
  return Number.isFinite(v) && v >= 0 ? v : null;
}

class TimeoutError extends Error {}

function withTimeout(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

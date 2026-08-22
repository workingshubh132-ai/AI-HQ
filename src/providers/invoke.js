/**
 * GOVERNED CONTENT PROVIDER INVOCATION (Milestone 21)
 *
 * The one path from "a request naming a provider_id/model_id" to "a
 * validated response" — mirroring `model-runtime.js`'s exact governed
 * pipeline (validate → provider/model lookup → input size → bounded
 * retry → output size → output shape → audit), generalized across all
 * five `contracts.js` categories instead of text alone.
 *
 * ── THIS FILE HOLDS NO AUTHORITY ─────────────────────────────────────────
 *
 * No reference to the Broker, to Guardian, to the Approval Engine, to
 * `store`'s mutation methods, or to anything that could grant clearance,
 * approve a version, lift a freeze, or authorize a tool call. It cannot
 * bypass any of those systems because it cannot reach them — a
 * structural fact, checked by this milestone's own structural tests, not
 * a promise kept by convention (the same claim model-runtime.js's own
 * header already makes and proves for text).
 *
 * A provider's output is DATA. Nothing here inspects it for anything
 * resembling `approved`/`clearance`/`remove_freeze`/`budget_override` —
 * those fields, if present, pass through `output` completely inert,
 * exactly as untrusted as any other field a provider returns. See
 * DECISIONS.md D38 and this milestone's adversarial tests.
 *
 * ── NOT WIRED INTO runtime.js ────────────────────────────────────────────
 *
 * This is a standalone foundation, proven by its own tests, not yet
 * connected to any handler — the same "build it, prove it, wire it in
 * only in a LATER milestone if ever" discipline M19 (artifacts) followed
 * before M20 wired artifacts into execution. `runtime.js`, `workflow.js`,
 * `router.js`, `guardian.js`, `approval-engine.js`,
 * `execution-coordinator.js`, `broker.js`, and `validator.js` are all
 * unmodified by this file's existence.
 *
 * Constitution: sections 13, 22, 23.
 */

import {
  PROVIDER_REASON, MAX_RETRY_CEILING, validateRequestInput, validateOutputShape, sanitizeUsageUnits,
  RETRYABLE_PROVIDER_REASONS,
} from './contracts.js';

/**
 * @param {object} deps
 * @param {{getProvider:Function, getModel:Function}} deps.registry
 * @param {object} deps.audit
 * @param {() => number} deps.clock
 */
export function createProviderInvoker({ registry, audit, clock }) {
  function invoke(request) {
    const startedAt = clock();

    const settle = (status, reason, patch = {}) => {
      const record = {
        event: 'provider.invocation',
        at: clock(),
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
    if (!request || typeof request !== 'object') {
      return settle('failed', PROVIDER_REASON.INVALID_REQUEST, { output: null, error: 'no request' });
    }
    if (typeof request.provider_id !== 'string' || typeof request.model_id !== 'string') {
      return settle('failed', PROVIDER_REASON.INVALID_REQUEST, { output: null, error: 'provider_id and model_id are required' });
    }
    if (request.input === undefined) {
      return settle('failed', PROVIDER_REASON.INVALID_REQUEST, { output: null, error: 'input is required' });
    }

    // 1 — provider must be registered and enabled. Fail closed either way.
    const provider = registry.getProvider(request.provider_id);
    if (!provider) return settle('failed', PROVIDER_REASON.PROVIDER_NOT_FOUND, { output: null });
    if (!provider.enabled) return settle('failed', PROVIDER_REASON.PROVIDER_DISABLED, { output: null });

    // 2 — model must be registered on that provider.
    const model = registry.getModel(request.provider_id, request.model_id);
    if (!model) return settle('failed', PROVIDER_REASON.MODEL_NOT_SUPPORTED, { output: null });

    // 3 — capability check, only when the request names one.
    if (request.required_capability && !model.capabilities.includes(request.required_capability)) {
      return settle('failed', PROVIDER_REASON.CAPABILITY_NOT_SUPPORTED, {
        output: null, detail: `${request.provider_id}/${request.model_id} does not declare ${request.required_capability}`,
      });
    }

    // 4 — request input must satisfy this provider_type's contract shape.
    const requestError = validateRequestInput(provider.provider_type, request.input);
    if (requestError) return settle('failed', PROVIDER_REASON.PROVIDER_CONTRACT_VIOLATION, { output: null, detail: requestError });

    // 5 — input size ceiling, before the provider ever sees it.
    const inputSize = JSON.stringify(request.input).length;
    if (inputSize > model.max_input_units) {
      return settle('failed', PROVIDER_REASON.PROVIDER_INPUT_TOO_LARGE, { output: null, detail: `${inputSize} > ${model.max_input_units}` });
    }

    // 6 — bounded retry loop. The ceiling is clamped regardless of what
    // the request or the model's own config asks for: no caller may
    // request unlimited retries. Only RETRYABLE_PROVIDER_REASONS trigger
    // another attempt — see contracts.js for exactly which those are and
    // why (never authorization/approval/lifecycle/Guardian-shaped, since
    // no such reason can originate from this file to begin with).
    const maxAttempts = 1 + Math.min(request.max_retries ?? model.default_max_retries, MAX_RETRY_CEILING);

    let attempts = 0;
    let lastReason = PROVIDER_REASON.PROVIDER_ERROR;
    let lastDetail = null;
    let raw = null;

    while (attempts < maxAttempts) {
      attempts++;
      const t0 = clock();
      let outcome;
      try {
        outcome = model.invoke({ input: request.input });
      } catch (err) {
        lastReason = PROVIDER_REASON.PROVIDER_ERROR;
        lastDetail = String(err.message);
        raw = null;
        if (!isRetryable(lastReason)) break;
        continue;
      }
      const elapsed = clock() - t0;
      if (elapsed > model.timeout_ms) {
        lastReason = PROVIDER_REASON.PROVIDER_TIMEOUT;
        lastDetail = `${elapsed}ms > ${model.timeout_ms}ms ceiling`;
        raw = null;
        if (!isRetryable(lastReason)) break;
        continue;
      }
      if (outcome?.status === 'failed') {
        // A provider may report a typed failure directly (e.g. rate
        // limiting) rather than throwing — this is how a future live
        // provider distinguishes "retry me" from "don't."
        lastReason = Object.values(PROVIDER_REASON).includes(outcome.reason) ? outcome.reason : PROVIDER_REASON.PROVIDER_ERROR;
        lastDetail = outcome.detail ?? null;
        raw = null;
        if (!isRetryable(lastReason)) break;
        continue;
      }
      raw = outcome;
      break; // success
    }

    if (raw === null) {
      const finalReason = attempts >= maxAttempts && attempts > 1 && isRetryable(lastReason)
        ? PROVIDER_REASON.RETRY_CEILING_EXCEEDED
        : lastReason;
      return settle('failed', finalReason, { output: null, attempts, detail: lastDetail });
    }

    // 7 — output size ceiling.
    const outputSize = JSON.stringify(raw.output).length;
    if (outputSize > model.max_output_units) {
      return settle('failed', PROVIDER_REASON.PROVIDER_OUTPUT_TOO_LARGE, { output: null, attempts, detail: `${outputSize} > ${model.max_output_units}` });
    }

    // 8 — output shape, per this provider_type's contract. A provider's
    // output is untrusted data until it passes this; failing here never
    // becomes an authorization decision of any kind.
    const outputError = validateOutputShape(provider.provider_type, raw.output);
    if (outputError) return settle('failed', PROVIDER_REASON.PROVIDER_OUTPUT_INVALID, { output: null, attempts, detail: outputError });

    // 9 — cost. Deterministic providers cost nothing real, and this file
    // says so explicitly rather than fabricating a figure. A live
    // provider's real cost computation (usage * declared per-unit rate,
    // the same pattern model-runtime.js already uses for text) is a
    // documented extension point for when one is actually built — see
    // DECISIONS.md D38 — not implemented here because none exists yet.
    const inputUnits = sanitizeUsageUnits(raw.usage?.input_units);
    const outputUnits = sanitizeUsageUnits(raw.usage?.output_units);
    const usageValid = inputUnits !== null && outputUnits !== null;
    const cost = provider.deterministic ? 0 : null;
    const cost_status = provider.deterministic ? 'DETERMINISTIC_NO_EXTERNAL_COST' : 'LIVE_PROVIDER_COST_NOT_IMPLEMENTED';

    return settle('ok', PROVIDER_REASON.OK, {
      output: raw.output,
      usage: usageValid ? raw.usage : null,
      usage_status: usageValid ? 'ACTUAL' : 'UNAVAILABLE',
      cost,
      cost_status,
      attempts,
      provider_type: provider.provider_type,
      provider_version: provider.provider_version,
    });
  }

  return { invoke };
}

function isRetryable(reason) {
  return RETRYABLE_PROVIDER_REASONS.has(reason);
}

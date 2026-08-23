/**
 * GOVERNED ASYNC PROVIDER INVOCATION (Milestone 25)
 *
 * The exact same governed pipeline `invoke.js` (M21) already runs —
 * request shape → provider lookup → enabled check → model lookup →
 * capability check → request contract → input ceiling → bounded,
 * retry-safety-aware retry → output ceiling → output contract → audit —
 * mirrored here with `await` and a GENUINE preemptive timeout, for
 * providers whose `invoke()` returns a Promise because it makes a real
 * network call.
 *
 * ── WHY A TWIN RATHER THAN MAKING invoke.js ASYNC ────────────────────────
 *
 * `runtime.js`'s `generateContent` closure (M22) calls
 * `providerInvoker.invoke(...)` SYNCHRONOUSLY and uses the result
 * immediately; every handler built against it, the whole Content
 * Factory (M23), and the CEO (M24) depend on that. Making `invoke.js`
 * async would break all of them at once.
 *
 * This is not a new dilemma — it is the same one this codebase already
 * resolved twice, the same way: `model-runtime.js` (sync) alongside
 * `async-model-runtime.js` (async, M12), and `createArtifact` (async)
 * alongside `createArtifactSync` (sync, M20). `async-model-runtime.js`'s
 * own header states the reasoning exactly: "'await a Promise' cannot be
 * retrofitted onto a function every existing caller invokes
 * synchronously without awaiting it." This file applies that settled
 * precedent to the M21 provider layer. `invoke.js` is unmodified.
 *
 * ── EVERY CHECK IS REUSED, NOT REINVENTED ────────────────────────────────
 *
 * `PROVIDER_REASON`, `RETRYABLE_PROVIDER_REASONS`, `MAX_RETRY_CEILING`,
 * `validateRequestInput`, `validateOutputShape`, and
 * `sanitizeUsageUnits` are all imported from `contracts.js` — the same
 * single source of truth `invoke.js` uses. A ceiling changed there
 * changes here too, and cannot drift.
 *
 * ── THIS FILE HOLDS NO AUTHORITY, AND NO CREDENTIAL ──────────────────────
 *
 * No reference to the Broker, Guardian, the Approval Engine, or any
 * store-mutation method. It never reads an environment variable, never
 * constructs a URL, and never sees a credential: the provider adapter
 * owns the network boundary entirely. A provider's output is DATA —
 * nothing here inspects it for anything resembling `approved`,
 * `clearance`, or `budget_override`.
 *
 * Constitution: sections 13, 22, 23.
 */

import {
  PROVIDER_REASON, MAX_RETRY_CEILING, validateRequestInput, validateOutputShape,
  sanitizeUsageUnits, RETRYABLE_PROVIDER_REASONS,
} from './contracts.js';

class ProviderTimeoutError extends Error {}

/** Races a provider's promise against a real timer. The abandoned
 * promise's eventual resolution is simply never awaited further — a
 * genuine preemptive timeout, unlike the after-the-fact measurement
 * `invoke.js` can do for a synchronous provider. Mirrors
 * `async-model-runtime.js`'s helper of the same name. */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ProviderTimeoutError(`exceeded ${ms}ms ceiling`)), ms);
  });
  // The timer is deliberately NOT unref'd: against a provider whose
  // promise never settles, this timer firing is the ONLY thing that ends
  // the wait, so it must keep the event loop alive until it does.
  // `clearTimeout` in `finally` releases it the moment either side wins,
  // so a normal call still leaves nothing pending.
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const isRetryable = (reason) => RETRYABLE_PROVIDER_REASONS.has(reason);

/**
 * @param {object} deps
 * @param {{getProvider:Function, getModel:Function}} deps.registry
 * @param {object} deps.audit
 * @param {() => number} deps.clock
 */
export function createAsyncProviderInvoker({ registry, audit, clock }) {
  async function invoke(request) {
    const startedAt = clock();

    const settle = (status, reason, patch = {}) => {
      const record = {
        event: 'provider.invocation',
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
    if (!request || typeof request !== 'object') {
      return settle('failed', PROVIDER_REASON.INVALID_REQUEST, { output: null, error: 'no request' });
    }
    if (typeof request.provider_id !== 'string' || typeof request.model_id !== 'string') {
      return settle('failed', PROVIDER_REASON.INVALID_REQUEST, { output: null, error: 'provider_id and model_id are required' });
    }
    if (request.input === undefined) {
      return settle('failed', PROVIDER_REASON.INVALID_REQUEST, { output: null, error: 'input is required' });
    }

    // 1 — provider must be registered AND enabled. A provider whose
    // configuration gates are unmet reports `enabled: false` and is
    // refused here, before any adapter code runs.
    const provider = registry.getProvider(request.provider_id);
    if (!provider) return settle('failed', PROVIDER_REASON.PROVIDER_NOT_FOUND, { output: null });
    if (!provider.enabled) return settle('failed', PROVIDER_REASON.PROVIDER_DISABLED, { output: null });

    // 2 — model must be registered on that provider. An arbitrary model
    // string never reaches the network.
    const model = registry.getModel(request.provider_id, request.model_id);
    if (!model) return settle('failed', PROVIDER_REASON.MODEL_NOT_SUPPORTED, { output: null });

    // 3 — capability check, only when the request names one.
    if (request.required_capability && !model.capabilities.includes(request.required_capability)) {
      return settle('failed', PROVIDER_REASON.CAPABILITY_NOT_SUPPORTED, {
        output: null, detail: `${request.provider_id}/${request.model_id} does not declare ${request.required_capability}`,
      });
    }

    // 4 — request must satisfy this provider_type's contract shape.
    const requestError = validateRequestInput(provider.provider_type, request.input);
    if (requestError) return settle('failed', PROVIDER_REASON.PROVIDER_CONTRACT_VIOLATION, { output: null, detail: requestError });

    // 5 — input ceiling, before the provider ever sees it.
    const inputSize = JSON.stringify(request.input).length;
    if (inputSize > model.max_input_units) {
      return settle('failed', PROVIDER_REASON.PROVIDER_INPUT_TOO_LARGE, { output: null, detail: `${inputSize} > ${model.max_input_units}` });
    }

    // 6 — bounded retry loop, clamped regardless of what the request or
    // the model's own config asks for. Only RETRYABLE_PROVIDER_REASONS
    // trigger another attempt — never an auth failure, never a
    // configuration failure, never an invalid request.
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
        outcome = await withTimeout(
          model.invoke({ input: request.input, system: request.system }),
          model.timeout_ms,
        );
      } catch (err) {
        if (err instanceof ProviderTimeoutError) {
          lastReason = PROVIDER_REASON.PROVIDER_TIMEOUT;
          lastDetail = err.message;
        } else {
          lastReason = PROVIDER_REASON.PROVIDER_ERROR;
          lastDetail = String(err?.message ?? err);
        }
        raw = null;
        if (!isRetryable(lastReason)) break;
        continue;
      }

      // Belt and suspenders: the provider resolved, but too slowly by
      // the injected clock's account (matters for deterministic tests
      // using a fake clock, where the real setTimeout above cannot
      // observe the same fictional time).
      const elapsed = clock() - t0;
      if (elapsed > model.timeout_ms) {
        lastReason = PROVIDER_REASON.PROVIDER_TIMEOUT;
        lastDetail = `${elapsed}ms > ${model.timeout_ms}ms ceiling`;
        raw = null;
        if (!isRetryable(lastReason)) break;
        continue;
      }

      if (outcome?.status === 'failed') {
        // A provider may report a typed failure directly (rate limiting,
        // auth rejection, invalid configuration) rather than throwing.
        // Only a code this contract recognises is honoured; anything
        // else collapses to the opaque, non-retryable PROVIDER_ERROR.
        lastReason = Object.values(PROVIDER_REASON).includes(outcome.reason)
          ? outcome.reason
          : PROVIDER_REASON.PROVIDER_ERROR;
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

    // 7 — output ceiling.
    const outputSize = JSON.stringify(raw.output).length;
    if (outputSize > model.max_output_units) {
      return settle('failed', PROVIDER_REASON.PROVIDER_OUTPUT_TOO_LARGE, { output: null, attempts, detail: `${outputSize} > ${model.max_output_units}` });
    }

    // 8 — output shape. Untrusted data until it passes; failing here
    // never becomes an authorization decision of any kind.
    const outputError = validateOutputShape(provider.provider_type, raw.output);
    if (outputError) return settle('failed', PROVIDER_REASON.PROVIDER_OUTPUT_INVALID, { output: null, attempts, detail: outputError });

    // 9 — cost. A deterministic provider genuinely costs nothing and
    // says so. A REAL provider's spend is reported from the adapter's
    // own `cost`/`cost_status` when it supplies them — never estimated
    // here, and never reported as $0.00 merely because no verified
    // price table exists. See DECISIONS.md D42.
    const inputUnits = sanitizeUsageUnits(raw.usage?.input_units);
    const outputUnits = sanitizeUsageUnits(raw.usage?.output_units);
    const usageValid = inputUnits !== null && outputUnits !== null;

    const cost = provider.deterministic ? 0 : (Number.isFinite(raw.cost) ? raw.cost : null);
    const cost_status = provider.deterministic
      ? 'DETERMINISTIC_NO_EXTERNAL_COST'
      : (typeof raw.cost_status === 'string' ? raw.cost_status : 'UNPRICED_REAL_SPEND');

    return settle('ok', PROVIDER_REASON.OK, {
      output: raw.output,
      usage: usageValid ? raw.usage : null,
      usage_status: usageValid ? 'ACTUAL' : 'UNAVAILABLE',
      // Sanitized, provider-reported metadata (token counts, request id)
      // when the adapter supplied it. The adapter is responsible for
      // ensuring nothing secret is in here; `groq.js` builds it from
      // named fields only.
      provider_usage: raw.provider_usage ?? null,
      cost,
      cost_status,
      attempts,
      provider_type: provider.provider_type,
      provider_version: provider.provider_version,
    });
  }

  return { invoke };
}

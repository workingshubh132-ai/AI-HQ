/**
 * REAL PROVIDER — GROQ (Milestone 25)
 *
 * The first real, paid, external inference provider wired into
 * `src/providers/`. It conforms to the EXISTING provider contract
 * (`registry.js`'s validator, `contracts.js`'s TEXT_GENERATION request
 * and output shapes) — the contract was not bent to accommodate it.
 *
 * ── THIS FILE IS THE ONLY PLACE THAT TOUCHES THE NETWORK ─────────────────
 *
 * Nothing else in AI-HQ may reach Groq: not the CEO, not an agent, not a
 * handler, not the router, workflow engine, Guardian, Broker, approval
 * engine, artifact service, or resource governor. Structural tests grep
 * every one of those for a network primitive and find none. The HTTP
 * call is made through an INJECTED `fetchImpl` (defaulting to Node's
 * built-in `fetch`, available since Node 18 and required by this
 * project's `engines.node: >=20`) — so no HTTP dependency was added,
 * and every test can observe exactly what would be sent without a
 * single byte leaving the machine.
 *
 * ── THE CREDENTIAL IS READ ONCE, AT CALL TIME, AND GOES NOWHERE ──────────
 *
 * `GROQ_API_KEY` is read inside `invoke()` only — the same rule
 * `provider-anthropic.js` (M12) established and DECISIONS.md D29
 * documents. It is placed in exactly one place, the `Authorization`
 * request header, and:
 *
 *   • never appears in the request BODY (test-enforced);
 *   • never appears on the returned envelope, in `usage`, or in
 *     `generation_metadata`;
 *   • never reaches an audit record, an artifact, or a prompt;
 *   • never appears in an error message — every error this file
 *     produces passes through `redact()`, which strips the key even if
 *     an upstream library echoed it back.
 *
 * The provider is constructed with a CONFIG object that carries a
 * boolean `has_credential` and never the key itself (see
 * `groq-config.js`), so even the provider definition sitting in the
 * registry holds no secret.
 *
 * ── NO CALL IS EVER FABRICATED ───────────────────────────────────────────
 *
 * With the configuration gates unmet, `invoke()` fails closed with
 * PROVIDER_CONFIGURATION_INVALID and never constructs a request. It does
 * not return a plausible-looking fake response. A Groq result in this
 * system means a real Groq call happened.
 *
 * Constitution: sections 13, 22, 23.
 */

import { PROVIDER_TYPE, PROVIDER_REASON } from './contracts.js';
import { readGroqConfig, GROQ_ENV, GROQ_CONFIG_REASON } from './groq-config.js';

export const GROQ_PROVIDER_ID = 'groq';
export const GROQ_PROVIDER_VERSION = '1.0.0-m25';
export const GROQ_CAPABILITY = 'text.chat_completion';

/** Conservative per-model ceilings. Measured in the same
 * `JSON.stringify(...).length` "units" every other provider in this
 * codebase uses (see `deterministic-text.js` and `provider-anthropic.js`'s
 * identical caveat) — deliberately NOT a token count, and never
 * described as one. */
const DEFAULT_MODEL_LIMITS = Object.freeze({
  max_input_units: 8_000,
  max_output_units: 8_000,
  timeout_ms: 30_000,
  default_max_retries: 1,
});

/** How many output tokens a single call may request. Small on purpose:
 * this is a real, paid API, and nothing in AI-HQ currently needs a long
 * completion. */
const MAX_COMPLETION_TOKENS = 512;

/**
 * Replaces every occurrence of the credential with a fixed marker.
 * Applied to EVERY string this file could ever surface. Written to be
 * total: a null/empty secret is a no-op rather than a crash, and
 * `String()` guards against a non-string error payload.
 */
export function redact(text, secret) {
  const s = String(text ?? '');
  if (typeof secret !== 'string' || secret.length < 8) return s;
  return s.split(secret).join('[REDACTED]');
}

/**
 * Maps an HTTP status onto this codebase's existing failure vocabulary.
 * Authentication and configuration failures are deliberately NOT in
 * `RETRYABLE_PROVIDER_REASONS` — retrying a rejected credential only
 * burns quota against a failure that is identical next time.
 */
export function classifyHttpStatus(status) {
  if (status === 401 || status === 403) return PROVIDER_REASON.PROVIDER_AUTH_FAILED;
  if (status === 404) return PROVIDER_REASON.MODEL_NOT_SUPPORTED;
  if (status === 429) return PROVIDER_REASON.PROVIDER_RATE_LIMITED;
  if (status === 408 || status === 504) return PROVIDER_REASON.PROVIDER_TIMEOUT;
  if (status >= 500) return PROVIDER_REASON.PROVIDER_UNAVAILABLE;
  if (status >= 400) return PROVIDER_REASON.INVALID_REQUEST;
  return PROVIDER_REASON.PROVIDER_ERROR;
}

/**
 * Builds the Groq provider definition.
 *
 * @param {object} [deps]
 * @param {Record<string,string|undefined>} [deps.env]  defaults to process.env
 * @param {Function} [deps.fetchImpl]  defaults to globalThis.fetch
 * @param {number} [deps.maxCostPerCallUsd]  the per-call reservation the
 *   EXISTING resource governor holds against a budget. Required to be a
 *   real number: `resource-governor.js` reads `model.max_cost_per_call`
 *   directly, and an undefined value there makes its reservation
 *   arithmetic evaluate `NaN > limit` — always false — silently
 *   defeating budget enforcement. That exact failure was found and
 *   documented in M21 (DECISIONS.md D38); this parameter exists so it
 *   cannot recur for a provider that spends real money.
 * @returns {object} a provider definition `registry.js` accepts unchanged
 */
export function createGroqProvider({ env = process.env, fetchImpl, maxCostPerCallUsd } = {}) {
  const config = readGroqConfig(env);

  // The per-call reservation. Derived from the configured ceiling when
  // the caller does not name one, and NEVER left undefined — see the
  // `maxCostPerCallUsd` note above.
  //
  // STRICTLY POSITIVE, for the reason `isUsableCeiling` in groq-config.js
  // documents: a reservation of 0 makes the governor's arithmetic
  // (`spent + reserved + 0 > limit`) false forever and silently defeats
  // every budget at every scope. A zero here is refused the same way an
  // undefined one is, so the only way to reach 0 is a config that is
  // already disabled — in which case `invoke()` returns before the
  // network and the value is inert. Test 789 asserts the invariant that
  // matters: an ENABLED Groq provider always reserves more than zero.
  const usable = (n) => Number.isFinite(n) && n > 0;
  const perCall = usable(maxCostPerCallUsd)
    ? maxCostPerCallUsd
    : (usable(config.max_spend_usd) ? config.max_spend_usd : 0);

  /**
   * One real Groq chat-completion call.
   *
   * `modelId` is an explicit parameter, closed over per-model below —
   * never shared mutable state — so concurrent calls to two different
   * models cannot race, and no caller, handler, or model output can
   * substitute a different model than the one the registry looked up.
   *
   * @param {string} modelId
   * @param {{input:{text?:string, prompt?:string}, system?:string}} args
   */
  async function invoke(modelId, { input, system }) {
    // Re-read the gates at CALL time, not construction time: a provider
    // left in a registry after configuration changed must not keep
    // spending. Fails closed, and returns BEFORE any request object
    // exists.
    const live = readGroqConfig(env);
    if (!live.enabled) {
      return {
        status: 'failed',
        reason: PROVIDER_REASON.PROVIDER_CONFIGURATION_INVALID,
        detail: `groq is not authorized for live calls (${live.reason})`,
      };
    }

    const apiKey = env[GROQ_ENV.API_KEY];
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      return {
        status: 'failed',
        reason: PROVIDER_REASON.PROVIDER_CONFIGURATION_INVALID,
        detail: `${GROQ_ENV.API_KEY} is not configured — no real Groq call can be made`,
      };
    }

    const doFetch = fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') {
      return {
        status: 'failed',
        reason: PROVIDER_REASON.PROVIDER_CONFIGURATION_INVALID,
        detail: 'no fetch implementation is available in this runtime',
      };
    }

    const prompt = typeof input?.text === 'string' && input.text !== '' ? input.text : input?.prompt;
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      return { status: 'failed', reason: PROVIDER_REASON.INVALID_REQUEST, detail: 'input.text or input.prompt is required' };
    }

    // The request BODY carries the prompt and nothing else of
    // consequence — no credential, no internal governance state, no
    // approval or Guardian information. The key lives only in the
    // header, one line below.
    const body = {
      model: modelId,
      max_tokens: MAX_COMPLETION_TOKENS,
      messages: [
        ...(typeof system === 'string' && system !== '' ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
    };

    let response;
    try {
      response = await doFetch(`${live.base_url}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // A transport-level failure (DNS, TLS, socket). Redacted, because
      // some HTTP stacks include the outbound request — headers and all
      // — in their error text.
      return {
        status: 'failed',
        reason: PROVIDER_REASON.PROVIDER_UNAVAILABLE,
        detail: redact(err?.message, apiKey),
      };
    }

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const text = await response.text();
        detail = redact(`HTTP ${response.status}: ${String(text).slice(0, 500)}`, apiKey);
      } catch {
        // A body that cannot be read is not worth failing differently over.
      }
      return { status: 'failed', reason: classifyHttpStatus(response.status), detail };
    }

    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      return {
        status: 'failed',
        reason: PROVIDER_REASON.PROVIDER_OUTPUT_INVALID,
        detail: redact(`response was not valid JSON: ${err?.message}`, apiKey),
      };
    }

    const rawText = payload?.choices?.[0]?.message?.content;
    if (typeof rawText !== 'string') {
      return {
        status: 'failed',
        reason: PROVIDER_REASON.PROVIDER_OUTPUT_INVALID,
        detail: 'response contained no choices[0].message.content string',
      };
    }

    // The COMPLETION TEXT is redacted too, not only error text.
    //
    // M27 found the gap: `invoke-async.js` writes the provider's `output`
    // into the `provider.invocation` audit record, so an upstream that
    // reflects the Authorization header into its completion — a hostile
    // proxy, a debug echo, a compromised gateway — wrote a LIVE
    // CREDENTIAL into an append-only, permanent log, and from there into
    // any artifact built from that output.
    //
    // Redacting here, at the credential boundary, fixes it once for every
    // consumer: this is the only place that holds the key, so nothing
    // downstream can leak what it never receives. `redact()` is total and
    // is already applied to every error path; the success path had simply
    // never been considered hostile.
    const text = redact(rawText, apiKey);

    // Provider-REPORTED usage only. Never estimated, never invented.
    const usage = payload?.usage ?? {};
    const promptTokens = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null;
    const completionTokens = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null;

    return {
      status: 'ok',
      // Exactly `contracts.js`'s TEXT_GENERATION output shape. Nothing
      // from the raw payload is spread in wholesale — only these named,
      // sanitized fields — so a hostile or malformed response cannot
      // smuggle an unexpected key through.
      output: {
        text,
        length: text.length,
        word_count: text.trim() === '' ? 0 : text.trim().split(/\s+/).length,
      },
      usage: {
        // The invoke pipeline's own unit convention, kept consistent with
        // every other provider here.
        input_units: JSON.stringify(input).length,
        output_units: text.length,
      },
      // Sanitized, provider-reported metadata for provenance. No header,
      // no credential, no raw request.
      provider_usage: {
        provider_reported: true,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : null,
        model: typeof payload?.model === 'string' ? payload.model : null,
        // Groq returns an `id` on the completion. Safe to record: it
        // identifies the request, not the requester.
        request_id: typeof payload?.id === 'string' ? payload.id : null,
      },
      // Real money was spent, and this system has NO verified Groq price
      // table — so it says so rather than claiming "$0.00". See §13 of
      // the M25 directive and DECISIONS.md D42.
      cost: null,
      cost_status: 'UNPRICED_REAL_SPEND',
    };
  }

  // Each configured model closes over its OWN id. The registry's
  // `invoke` therefore always sends the model the registry looked up —
  // there is no shared field a concurrent call could overwrite, and no
  // parameter a caller could use to substitute a different one.
  const models = {};
  for (const modelId of config.models) {
    models[modelId] = Object.freeze({
      ...DEFAULT_MODEL_LIMITS,
      max_cost_per_call: perCall,
      capabilities: [GROQ_CAPABILITY],
      invoke: (args) => invoke(modelId, args ?? {}),
    });
  }

  return Object.freeze({
    provider_type: PROVIDER_TYPE.TEXT_GENERATION,
    provider_version: GROQ_PROVIDER_VERSION,
    // A real network provider: `invoke.js` reports `cost_status`
    // accordingly and never claims a deterministic zero cost.
    deterministic: false,
    enabled: config.enabled,
    capabilities: [GROQ_CAPABILITY],
    models,
  });
}

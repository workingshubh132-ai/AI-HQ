/**
 * GROQ CONFIGURATION AND GATING (Milestone 25)
 *
 * Decides whether a real Groq call is permitted AT ALL, from explicit
 * configuration only. This is the gate that keeps the entire project
 * offline by default: with nothing configured, `readGroqConfig()`
 * returns `{enabled: false}` and no network path is ever constructed.
 *
 * ── THIS FILE NEVER CARRIES THE CREDENTIAL ───────────────────────────────
 *
 * The returned config object contains a BOOLEAN `has_credential` and
 * never the key itself — not the value, not a prefix, not a length, not
 * a hash. The key is read from the environment exactly once, at call
 * time, inside `groq.js`'s `invoke()`, mirroring the rule
 * `provider-anthropic.js` (M12) already established and DECISIONS.md D29
 * documents. Nothing here, and nothing downstream of here, can hand a
 * credential to an agent, a handler, the CEO, the Broker, an audit
 * record, or an artifact.
 *
 * ── OFFLINE BY DEFAULT: THREE INDEPENDENT GATES, ALL REQUIRED ────────────
 *
 *   1. AI_HQ_REAL_PROVIDER_ENABLED === 'true'   explicit, project-wide
 *      opt-in to ANY real provider. Absent → offline.
 *   2. GROQ_ENABLED !== 'false'                 per-provider off switch,
 *      so one provider can be disabled without disabling all.
 *   3. GROQ_API_KEY present AND a VALID spend ceiling configured.
 *
 * A key alone is deliberately NOT sufficient: the M25 directive requires
 * that merely having a credential in the environment never causes a
 * paid call. All three must hold.
 *
 * ── THE SPEND CEILING FAILS CLOSED, ALWAYS ───────────────────────────────
 *
 * `parseSpendCeiling()` accepts ONLY a finite, non-negative number.
 * `undefined`, `null`, `''`, `NaN`, `Infinity`, `-Infinity`, a negative
 * number, and any unparseable string are each rejected as
 * INVALID_SPEND_CEILING — never silently read as "unlimited." There is
 * no code path in this file that produces an unbounded ceiling.
 *
 * ── MODELS ARE CONFIGURATION, NOT INVENTION ──────────────────────────────
 *
 * This file ships NO default model identifier. Groq's supported model
 * list changes over time and could not be verified against authoritative
 * Groq documentation from this environment, so inventing one would be
 * fabrication. `GROQ_MODELS` is a comma-separated allowlist the operator
 * supplies; with it unset, the provider is configuration-invalid and
 * disabled. A request naming a model outside the allowlist fails closed
 * at the registry/invoke boundary, exactly like any unknown model.
 *
 * Constitution: sections 13, 22, 23.
 */

/** Environment variable names, in one place so tests and docs cannot
 * drift from the code. */
export const GROQ_ENV = Object.freeze({
  REAL_PROVIDER_ENABLED: 'AI_HQ_REAL_PROVIDER_ENABLED',
  GROQ_ENABLED: 'GROQ_ENABLED',
  API_KEY: 'GROQ_API_KEY',
  MODELS: 'GROQ_MODELS',
  MAX_SPEND_USD: 'GROQ_MAX_SPEND_USD',
  BASE_URL: 'GROQ_BASE_URL',
});

export const GROQ_CONFIG_REASON = Object.freeze({
  OK: 'OK',
  REAL_PROVIDER_NOT_ENABLED: 'REAL_PROVIDER_NOT_ENABLED',
  PROVIDER_DISABLED: 'PROVIDER_DISABLED',
  NO_CREDENTIAL: 'NO_CREDENTIAL',
  INVALID_SPEND_CEILING: 'INVALID_SPEND_CEILING',
  NO_MODELS_CONFIGURED: 'NO_MODELS_CONFIGURED',
  INVALID_BASE_URL: 'INVALID_BASE_URL',
});

/** Groq's published OpenAI-compatible REST base. Overridable only by
 * explicit configuration, and only to another https:// origin — a
 * plain-http or malformed override is refused rather than silently
 * downgrading a credential-bearing request onto an unencrypted
 * connection. */
export const GROQ_DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * A spend ceiling, or null. Never Infinity, never negative, never NaN —
 * see this file's header.
 * @returns {number|null}
 */
export function parseSpendCeiling(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? raw : null;
  }
  if (!isNonEmptyString(raw)) return null;
  const trimmed = raw.trim();
  // Reject the words that would otherwise coerce to a non-finite number.
  if (/^[+-]?infinity$/i.test(trimmed) || /^nan$/i.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Only an https:// URL is ever accepted — see GROQ_DEFAULT_BASE_URL. */
export function parseBaseUrl(raw) {
  if (!isNonEmptyString(raw)) return GROQ_DEFAULT_BASE_URL;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:') return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Comma-separated allowlist → a frozen array of trimmed, non-empty ids. */
export function parseModels(raw) {
  if (!isNonEmptyString(raw)) return Object.freeze([]);
  const seen = new Set();
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (id !== '') seen.add(id);
  }
  return Object.freeze([...seen]);
}

/**
 * Reads the Groq configuration from an INJECTED environment object.
 *
 * Injection (rather than reaching for the ambient process environment
 * directly) is what lets every gate below be tested exhaustively
 * without mutating the real environment — and it means this file has no
 * ambient authority of its own. The adapter supplies the environment
 * object at construction time; this file only reads the keys it is
 * handed.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {{enabled:boolean, reason:string, has_credential:boolean,
 *   models:string[], max_spend_usd:number|null, base_url:string|null}}
 */
export function readGroqConfig(env = {}) {
  const has_credential = isNonEmptyString(env[GROQ_ENV.API_KEY]);
  const models = parseModels(env[GROQ_ENV.MODELS]);
  const max_spend_usd = parseSpendCeiling(env[GROQ_ENV.MAX_SPEND_USD]);
  const base_url = parseBaseUrl(env[GROQ_ENV.BASE_URL]);

  // NOTE the ordering: the two explicit opt-in gates are evaluated
  // FIRST, so a project that never opted in reports that plainly rather
  // than complaining about a missing key it was never going to use.
  const settle = (reason) => Object.freeze({
    enabled: reason === GROQ_CONFIG_REASON.OK,
    reason,
    has_credential,
    models,
    max_spend_usd,
    base_url,
  });

  if (env[GROQ_ENV.REAL_PROVIDER_ENABLED] !== 'true') return settle(GROQ_CONFIG_REASON.REAL_PROVIDER_NOT_ENABLED);
  if (env[GROQ_ENV.GROQ_ENABLED] === 'false') return settle(GROQ_CONFIG_REASON.PROVIDER_DISABLED);
  if (!has_credential) return settle(GROQ_CONFIG_REASON.NO_CREDENTIAL);
  if (max_spend_usd === null) return settle(GROQ_CONFIG_REASON.INVALID_SPEND_CEILING);
  if (models.length === 0) return settle(GROQ_CONFIG_REASON.NO_MODELS_CONFIGURED);
  if (base_url === null) return settle(GROQ_CONFIG_REASON.INVALID_BASE_URL);

  return settle(GROQ_CONFIG_REASON.OK);
}

/**
 * True only when a real, paid Groq call is fully authorized. Callers use
 * this as the single question to ask — there is deliberately no partial
 * "enabled but unconfigured" state to misread.
 */
export function isLiveGroqAuthorized(env = {}) {
  return readGroqConfig(env).enabled;
}

/**
 * CONTENT GENERATION PROVIDER CONTRACTS (Milestone 21)
 *
 * The typed shape every provider category's REQUEST and RESPONSE must
 * satisfy, plus the failure vocabulary `src/providers/invoke.js` reports
 * against. Pure data and pure validation — no store access, no clock, no
 * randomness, no network — exactly `actions.js`'s and `artifacts.js`'s
 * role, played here for content-generation providers.
 *
 * ── FIVE CATEGORIES, ONE SHARED SHAPE ────────────────────────────────────
 *
 * Every category shares a request envelope (`provider_id`, `model_id`,
 * `input`, optional `timeout_ms`/`max_retries`) and a response envelope
 * (`status`, `output`, `usage`, `cost`, `cost_status`) — the same
 * envelope `providers.js`'s `MOCK_PROVIDER` and `model-runtime.js`
 * already use for text, generalized here to cover image, audio, video,
 * and subtitle generation too. Only the SHAPE of `input`/`output` differs
 * per category — validated by `validateRequest`/`validateOutput` below,
 * dispatched on `provider_type`.
 *
 * ── WHY A NEW, SEPARATE CONTRACT FILE RATHER THAN EXTENDING model-runtime.js ──
 *
 * `providers.js`/`model-runtime.js` are the LIVE, tested, wired-in path
 * for text generation via `runtime.js`'s `callModel` — untouched by this
 * milestone (see DECISIONS.md D38). This file, and the rest of
 * `src/providers/`, is a standalone, NOT-yet-wired-in foundation for all
 * five categories, proven correct by its own tests, exactly the same
 * "build the foundation, prove it standalone, wire it in later if ever"
 * pattern M19 (artifacts) used before M20 wired artifacts into
 * execution. Nothing here is imported by runtime.js, broker.js,
 * workflow.js, router.js, guardian.js, approval-engine.js,
 * execution-coordinator.js, or validator.js.
 *
 * Constitution: sections 6, 7, 13, 22, 23.
 */

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

export const PROVIDER_TYPE = Object.freeze({
  TEXT_GENERATION: 'TEXT_GENERATION',
  IMAGE_GENERATION: 'IMAGE_GENERATION',
  AUDIO_GENERATION: 'AUDIO_GENERATION',
  VIDEO_GENERATION: 'VIDEO_GENERATION',
  SUBTITLE_GENERATION: 'SUBTITLE_GENERATION',
});

const KNOWN_PROVIDER_TYPES = Object.freeze(new Set(Object.values(PROVIDER_TYPE)));

export function isKnownProviderType(value) {
  return typeof value === 'string' && KNOWN_PROVIDER_TYPES.has(value);
}

/**
 * Typed failure vocabulary. Reuses `model-runtime.js`'s naming where the
 * SAME concept already exists there (documented per-code below) rather
 * than inventing parallel meaning for an identical idea; genuinely new
 * codes cover what only a multi-media provider layer needs.
 */
export const PROVIDER_REASON = Object.freeze({
  OK: 'OK',
  INVALID_REQUEST: 'INVALID_REQUEST', // same meaning as MODEL_REASON.INVALID_REQUEST
  PROVIDER_NOT_FOUND: 'PROVIDER_NOT_FOUND', // same meaning as MODEL_REASON.UNKNOWN_PROVIDER
  MODEL_NOT_SUPPORTED: 'MODEL_NOT_SUPPORTED', // same meaning as MODEL_REASON.UNKNOWN_MODEL
  PROVIDER_DISABLED: 'PROVIDER_DISABLED', // genuinely new: a registered provider can be marked disabled without being removed
  CAPABILITY_NOT_SUPPORTED: 'CAPABILITY_NOT_SUPPORTED', // genuinely new: model exists but lacks the requested capability
  PROVIDER_INPUT_TOO_LARGE: 'PROVIDER_INPUT_TOO_LARGE', // same meaning as MODEL_REASON.INPUT_LIMIT_EXCEEDED
  PROVIDER_OUTPUT_TOO_LARGE: 'PROVIDER_OUTPUT_TOO_LARGE', // same meaning as MODEL_REASON.OUTPUT_LIMIT_EXCEEDED
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT', // same meaning as MODEL_REASON.TIMEOUT
  RETRY_CEILING_EXCEEDED: 'RETRY_CEILING_EXCEEDED', // same meaning as MODEL_REASON.RETRY_CEILING_EXCEEDED
  PROVIDER_RATE_LIMITED: 'PROVIDER_RATE_LIMITED', // genuinely new: distinct from a generic provider error — explicitly retry-safe
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE', // genuinely new: transient outage — explicitly retry-safe
  PROVIDER_ERROR: 'PROVIDER_ERROR', // same meaning as MODEL_REASON.PROVIDER_ERROR — an opaque, non-retry-safe failure
  PROVIDER_OUTPUT_INVALID: 'PROVIDER_OUTPUT_INVALID', // genuinely new: output failed this file's own shape validator
  PROVIDER_CONTRACT_VIOLATION: 'PROVIDER_CONTRACT_VIOLATION', // genuinely new: the CALLER's request itself violates this file's contract (e.g. unsupported artifact_type for the category)
  // ── added in M25, when a real network provider first made them
  // distinguishable. Purely additive: no existing check reads either,
  // and NEITHER is retry-safe (see RETRYABLE_PROVIDER_REASONS below) —
  // retrying a rejected credential or a broken configuration only burns
  // quota against a failure that will be identical next time.
  PROVIDER_AUTH_FAILED: 'PROVIDER_AUTH_FAILED', // the provider rejected the credential (HTTP 401/403). NEVER retried.
  PROVIDER_CONFIGURATION_INVALID: 'PROVIDER_CONFIGURATION_INVALID', // the local configuration is missing/unusable (no credential, no spend ceiling, provider not enabled). NEVER retried, and never reaches the network.
});

/**
 * Which failures are safe to retry automatically. A transient condition
 * (the provider was momentarily unavailable, rate-limited, or slow) may
 * legitimately succeed on a second attempt. Everything else — a
 * configuration error, a malformed request, an invalid contract, an
 * output that failed validation — will fail again identically, and
 * retrying it only wastes a call. Mirrors `workflow.js`'s own
 * `RETRYABLE_REASONS` convention exactly (a `Set`, checked before any
 * retry, never inferred from the failure's "feel").
 *
 * Deliberately excludes anything resembling authorization, approval,
 * lifecycle, or Guardian failure — this file has no reference to any of
 * those systems and never will (see DECISIONS.md D38), so no such
 * reason could ever originate here to begin with.
 */
export const RETRYABLE_PROVIDER_REASONS = Object.freeze(new Set([
  PROVIDER_REASON.PROVIDER_TIMEOUT,
  PROVIDER_REASON.PROVIDER_RATE_LIMITED,
  PROVIDER_REASON.PROVIDER_UNAVAILABLE,
]));

/** Bounded regardless of what a request or a model's own config asks
 * for — same clamp value as model-runtime.js's MAX_RETRY_CEILING, same
 * reasoning: no caller may request unlimited retries. */
export const MAX_RETRY_CEILING = 3;

// ── per-category request validation ──────────────────────────────────────
//
// Each returns an error string, or null if the request's `input` is
// well-formed for that category. Never throws. Never authorizes
// anything — these are shape checks only.

function validateTextRequest(input) {
  if (!isPlainObject(input)) return 'input must be an object';
  if (!isNonEmptyString(input.text) && !isNonEmptyString(input.prompt)) return 'input.text or input.prompt is required';
  return null;
}

function validateImageRequest(input) {
  if (!isPlainObject(input)) return 'input must be an object';
  if (!isNonEmptyString(input.prompt)) return 'input.prompt is required';
  if (!isPlainObject(input.dimensions)) return 'input.dimensions is required';
  if (!isPositiveInt(input.dimensions.width) || !isPositiveInt(input.dimensions.height)) {
    return 'input.dimensions.width and input.dimensions.height must be positive integers';
  }
  if (!isNonEmptyString(input.format)) return 'input.format is required';
  return null;
}

function validateAudioRequest(input) {
  if (!isPlainObject(input)) return 'input must be an object';
  if (!isNonEmptyString(input.text)) return 'input.text is required';
  if (!isNonEmptyString(input.voice)) return 'input.voice is required';
  if (!isNonEmptyString(input.language)) return 'input.language is required';
  if (!isNonEmptyString(input.format)) return 'input.format is required';
  return null;
}

function validateVideoRequest(input) {
  if (!isPlainObject(input)) return 'input must be an object';
  if (!Array.isArray(input.input_artifact_ids) || input.input_artifact_ids.length === 0) {
    return 'input.input_artifact_ids must be a non-empty array';
  }
  if (!input.input_artifact_ids.every(isNonEmptyString)) return 'every entry in input.input_artifact_ids must be a non-empty string';
  if (!isNonEmptyString(input.script) && !isNonEmptyString(input.reference)) return 'input.script or input.reference is required';
  if (!Number.isFinite(input.duration_seconds) || input.duration_seconds <= 0) return 'input.duration_seconds must be a positive number';
  if (!isPlainObject(input.dimensions)) return 'input.dimensions is required';
  if (!isPositiveInt(input.dimensions.width) || !isPositiveInt(input.dimensions.height)) {
    return 'input.dimensions.width and input.dimensions.height must be positive integers';
  }
  if (!isNonEmptyString(input.format)) return 'input.format is required';
  return null;
}

function validateSubtitleRequest(input) {
  if (!isPlainObject(input)) return 'input must be an object';
  if (!isNonEmptyString(input.audio_artifact_id)) return 'input.audio_artifact_id is required';
  if (!isNonEmptyString(input.language)) return 'input.language is required';
  if (!isNonEmptyString(input.subtitle_format)) return 'input.subtitle_format is required';
  return null;
}

const REQUEST_VALIDATORS = Object.freeze({
  [PROVIDER_TYPE.TEXT_GENERATION]: validateTextRequest,
  [PROVIDER_TYPE.IMAGE_GENERATION]: validateImageRequest,
  [PROVIDER_TYPE.AUDIO_GENERATION]: validateAudioRequest,
  [PROVIDER_TYPE.VIDEO_GENERATION]: validateVideoRequest,
  [PROVIDER_TYPE.SUBTITLE_GENERATION]: validateSubtitleRequest,
});

/**
 * @param {string} providerType one of PROVIDER_TYPE
 * @param {unknown} input the request's `input` field
 * @returns {string|null} an error message, or null if well-formed
 */
export function validateRequestInput(providerType, input) {
  const validator = REQUEST_VALIDATORS[providerType];
  if (!validator) return `unknown provider_type: ${providerType}`;
  return validator(input);
}

// ── per-category output validation ───────────────────────────────────────
//
// A provider's raw `output` — untrusted, whether it came from a
// deterministic fixture or (in the future) a real network call — must
// satisfy this shape before `invoke.js` will hand it back to a caller.
// Fields like `content`/`content_ref`/`checksum` deliberately mirror
// `artifacts.js`'s own contract (M19) — this is what lets
// `artifact-bridge.js` turn a validated output directly into an
// artifact-creation request without re-deriving anything.

function validateTextOutput(output) {
  if (!isPlainObject(output)) return 'output must be an object';
  if (typeof output.text !== 'string') return 'output.text must be a string';
  return null;
}

function validateMediaOutput(output, { requireDuration = false } = {}) {
  if (!isPlainObject(output)) return 'output must be an object';
  const hasInline = output.content !== undefined && output.content !== null;
  const hasRef = isNonEmptyString(output.content_ref);
  if (hasInline === hasRef) return 'output must set exactly one of content or content_ref';
  if (!isNonEmptyString(output.mime_type)) return 'output.mime_type is required';
  if (hasRef) {
    if (!Number.isInteger(output.size) || output.size < 0) return 'output.size must be a non-negative integer when content_ref is used';
    if (!/^[a-f0-9]{64}$/.test(output.checksum ?? '')) return 'output.checksum must be a 64-hex-character string when content_ref is used';
  }
  if (requireDuration && (!Number.isFinite(output.duration_seconds) || output.duration_seconds <= 0)) {
    return 'output.duration_seconds must be a positive number';
  }
  return null;
}

const OUTPUT_VALIDATORS = Object.freeze({
  [PROVIDER_TYPE.TEXT_GENERATION]: validateTextOutput,
  [PROVIDER_TYPE.IMAGE_GENERATION]: (output) => validateMediaOutput(output),
  [PROVIDER_TYPE.AUDIO_GENERATION]: (output) => validateMediaOutput(output, { requireDuration: true }),
  [PROVIDER_TYPE.VIDEO_GENERATION]: (output) => validateMediaOutput(output, { requireDuration: true }),
  [PROVIDER_TYPE.SUBTITLE_GENERATION]: (output) => validateMediaOutput(output),
});

/**
 * @param {string} providerType one of PROVIDER_TYPE
 * @param {unknown} output the provider's raw response `output` field
 * @returns {string|null} an error message, or null if well-formed
 */
export function validateOutputShape(providerType, output) {
  const validator = OUTPUT_VALIDATORS[providerType];
  if (!validator) return `unknown provider_type: ${providerType}`;
  return validator(output);
}

/** A finite, non-negative usage figure, or null — same convention
 * async-model-runtime.js's `sanitizeUsageUnits` already established,
 * reused here so a provider reporting impossible/negative/NaN usage
 * cannot poison any cost ledger this layer or a future one keeps. */
export function sanitizeUsageUnits(v) {
  return Number.isFinite(v) && v >= 0 ? v : null;
}

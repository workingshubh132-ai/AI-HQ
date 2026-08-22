/**
 * CONTENT ARTIFACT CONTRACT (Milestone 19)
 *
 * The provider-neutral shape every produced piece of content — research,
 * a script, an audio file, an image, a video, captions, a social-media
 * package — is recorded as, plus the static registry of known artifact
 * types and the fail-closed validation that fills the rest of this
 * milestone.
 *
 * ── WHAT THIS FILE IS NOT ────────────────────────────────────────────────
 *
 * It is not an authorization mechanism. Holding a well-formed artifact
 * record, or even an artifact_id, decides nothing — it cannot execute a
 * tool, approve anything, lift a freeze, change a budget, or move an
 * agent's lifecycle state. Those remain the Broker's, Guardian's,
 * Approval Engine's, and Resource Governor's jobs respectively, entirely
 * unconsulted by this file. See src/artifact-service.js's header and
 * DECISIONS.md D36 for how creation is actually governed.
 *
 * It is pure data and pure validation — no store access, no clock, no
 * randomness, no network. Exactly `actions.js`'s role for tool actions,
 * played here for artifacts: a static, agent-unreachable classification
 * table plus fail-closed checks, nothing that decides whether an action
 * is allowed to happen.
 *
 * Constitution: sections 6, 7 (data, not code — the same principle that
 * makes agents declarative applies to what agents produce).
 */

import { createHash } from 'node:crypto';
import { stableStringify } from './payload.js';

/**
 * Provider-neutral artifact types. Extensible by adding an entry here —
 * exactly how `actions.js`'s ACTIONS registry has grown release over
 * release — never by hardcoding a specific pipeline (e.g. "YouTube
 * video") into this file or into artifact-service.js. Adding a type is a
 * source change (and, for the Postgres adapter, a migration widening the
 * matching CHECK constraint — see migration 0007 and DECISIONS.md D34's
 * identical precedent for RUNTIME_STATE), never a runtime-supplied string.
 */
export const ARTIFACT_TYPE = Object.freeze({
  RESEARCH: 'RESEARCH',
  ARTICLE: 'ARTICLE',
  TEXT: 'TEXT',
  SCRIPT: 'SCRIPT',
  AUDIO: 'AUDIO',
  IMAGE: 'IMAGE',
  THUMBNAIL: 'THUMBNAIL',
  VIDEO: 'VIDEO',
  SUBTITLE: 'SUBTITLE',
  EDIT_INSTRUCTION: 'EDIT_INSTRUCTION',
  SOCIAL_PACKAGE: 'SOCIAL_PACKAGE',
});

const KNOWN_ARTIFACT_TYPES = Object.freeze(new Set(Object.values(ARTIFACT_TYPE)));

/** @returns {boolean} */
export function isKnownArtifactType(value) {
  return typeof value === 'string' && KNOWN_ARTIFACT_TYPES.has(value);
}

/** @returns {string[]} every registered artifact type, for introspection/tests */
export function allArtifactTypes() {
  return Object.values(ARTIFACT_TYPE);
}

/**
 * Not a workflow/approval status — see this file's header and the
 * ARTIFACT CONTRACT section of the M19 directive, which lists `status`
 * and `approval_status` as two distinct fields. `status` answers "did
 * producing this artifact succeed": a FAILED record has no usable
 * content (content/content_ref are both null) but is still a legitimate,
 * auditable artifact — "agent X attempted to render audio from this
 * script and failed" is provenance worth keeping, not an error to
 * discard silently.
 */
export const ARTIFACT_STATUS = Object.freeze({
  COMPLETE: 'complete',
  FAILED: 'failed',
});

/**
 * `approval_status` reuses the Approval Engine's own vocabulary exactly
 * (src/approval-engine.js's APPROVAL_STATUS) rather than inventing a
 * parallel one — plus NOT_REQUIRED, for the (expected to be common) case
 * of an artifact whose policy tier never required human approval at all.
 * This field is DESCRIPTIVE ONLY: nothing in the Broker, Guardian, or
 * Approval Engine ever reads it, and setting it here approves nothing —
 * the actual approval decision, if any, is made exactly as M18 defined,
 * by a human calling the Approval Engine's own `decide()`. Duplicating
 * that engine's authority inside this file is exactly what the M19
 * directive forbids.
 */
export const ARTIFACT_APPROVAL_STATUS = Object.freeze({
  NOT_REQUIRED: 'not_required',
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  REVOKED: 'revoked',
});

export const ARTIFACT_REASON = Object.freeze({
  OK: 'OK',
  MISSING_ARTIFACT_ID: 'MISSING_ARTIFACT_ID',
  DUPLICATE_ARTIFACT_ID: 'DUPLICATE_ARTIFACT_ID',
  UNKNOWN_ARTIFACT_TYPE: 'UNKNOWN_ARTIFACT_TYPE',
  INVALID_STATUS: 'INVALID_STATUS',
  MISSING_WORKFLOW_ID: 'MISSING_WORKFLOW_ID',
  UNKNOWN_TASK: 'UNKNOWN_TASK',
  TASK_WORKFLOW_MISMATCH: 'TASK_WORKFLOW_MISMATCH',
  UNKNOWN_AGENT: 'UNKNOWN_AGENT',
  INVALID_REGISTRY_SHA: 'INVALID_REGISTRY_SHA',
  INVALID_PARENT_ID: 'INVALID_PARENT_ID',
  PARENT_NOT_FOUND: 'PARENT_NOT_FOUND',
  CROSS_WORKFLOW_PARENT: 'CROSS_WORKFLOW_PARENT',
  CYCLIC_LINEAGE: 'CYCLIC_LINEAGE',
  INVALID_CONTENT: 'INVALID_CONTENT',
  INVALID_MIME_TYPE: 'INVALID_MIME_TYPE',
  INVALID_SIZE: 'INVALID_SIZE',
  INVALID_CHECKSUM: 'INVALID_CHECKSUM',
  INVALID_PROVIDER_METADATA: 'INVALID_PROVIDER_METADATA',
  INVALID_APPROVAL_STATUS: 'INVALID_APPROVAL_STATUS',
});

export const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/** Loose `type/subtype` shape — not a MIME registry, just enough
 * structure to reject an obviously malformed value. */
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&\-^_.+]*\/[a-z0-9][a-z0-9!#$&\-^_.+]*$/i;

export function isValidMimeType(value) {
  return typeof value === 'string' && MIME_TYPE_PATTERN.test(value);
}

/** Same 64-lowercase-hex-character shape `broker.js`'s validateApproval
 * already requires of `approved_payload_hash` — reused, not reinvented. */
export function isValidChecksum(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

/**
 * SHA-256 of the content's stable serialization — `payload.js`'s
 * `hashPayload`, renamed at the call site for what it means here. Same
 * function M4.5/M4.6 and M18 already trust for "these exact bytes,
 * deterministically."
 *
 * @param {unknown} content
 * @returns {string} 64 hex characters
 */
export function checksumOf(content) {
  return createHash('sha256').update(stableStringify(content)).digest('hex');
}

/**
 * Byte length of the SAME serialization `checksumOf` hashes — derived
 * from `stableStringify`, not a separate `JSON.stringify` call, so
 * `size` and `checksum` are guaranteed to describe the exact same bytes
 * rather than two independently-computed views that could drift.
 *
 * @param {unknown} content
 * @returns {number}
 */
export function byteSizeOf(content) {
  return Buffer.byteLength(stableStringify(content), 'utf8');
}

/**
 * Is `value` a plain, JSON-serializable object (or null)? Used for
 * `generation_metadata` — provider-specific, informational only, but
 * still must not be a function, a circular structure, or a non-object.
 */
export function isSerializableMetadata(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    stableStringify(value);
    return true;
  } catch {
    return false;
  }
}

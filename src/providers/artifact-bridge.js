/**
 * PROVIDER → ARTIFACT BRIDGE (Milestone 21)
 *
 * Turns a SUCCESSFUL, already-validated governed provider result (from
 * `invoke.js`) into an artifact CREATION REQUEST — the exact shape
 * `artifact-service.js`'s `createArtifact`/`createArtifactSync` (M19/M20)
 * already accepts. This file does not call either of those functions
 * itself, and holds no reference to the artifact store: it is a pure,
 * synchronous transform, easier to test in isolation and impossible to
 * mistake for a second artifact-creation interface.
 *
 * ── THE ONE RULE THIS FILE EXISTS TO ENFORCE ─────────────────────────────
 *
 * The request this function builds NEVER sets `agent_id`, `version_id`,
 * `registry_sha`, `workflow_id`, `task_id`, `artifact_id`, `created_at`,
 * or `provenance` — those seven fields exist ONLY on the request object
 * a TRUSTED caller (in M20, `runtime.js`'s `createArtifact` closure)
 * merges in afterward, from real execution context, exactly as M20
 * already established for handler-supplied requests. If a provider's
 * raw output happened to contain fields with those same names (an
 * adversarial or malformed response), this function does not read them
 * off `output` at all — it only ever copies the specific, named fields
 * documented below. See DECISIONS.md D38 and this milestone's
 * adversarial tests (forged provenance via provider output).
 *
 * `artifact-service.js` independently re-derives and re-validates
 * everything regardless (M19/M20, unchanged) — this file's own
 * discipline is defense in depth, not the only guard.
 */

import { PROVIDER_TYPE, isKnownProviderType } from './contracts.js';
import { ARTIFACT_TYPE, isKnownArtifactType } from '../artifacts.js';

/** A convenience default mapping a caller MAY use — never applied
 * automatically, because one provider_type can legitimately back several
 * artifact_types (TEXT_GENERATION alone can produce RESEARCH, ARTICLE,
 * SCRIPT, or plain TEXT depending on what the caller asked for — see
 * demo-artifact-pipeline-agents.js's own research-agent vs script-agent,
 * M20). Guessing intent here would be exactly the kind of "blindly add a
 * default" the M19/M20/M21 directives have each warned against. */
export const DEFAULT_ARTIFACT_TYPE_FOR_PROVIDER_TYPE = Object.freeze({
  [PROVIDER_TYPE.TEXT_GENERATION]: ARTIFACT_TYPE.TEXT,
  [PROVIDER_TYPE.IMAGE_GENERATION]: ARTIFACT_TYPE.IMAGE,
  [PROVIDER_TYPE.AUDIO_GENERATION]: ARTIFACT_TYPE.AUDIO,
  [PROVIDER_TYPE.VIDEO_GENERATION]: ARTIFACT_TYPE.VIDEO,
  [PROVIDER_TYPE.SUBTITLE_GENERATION]: ARTIFACT_TYPE.SUBTITLE,
});

/** Extracts exactly the content-shaped fields this bridge is willing to
 * copy, per provider_type — never the whole `output` object verbatim,
 * so an adversarial or malformed output cannot smuggle an unexpected
 * field through untouched. */
function extractContent(providerType, output) {
  if (providerType === PROVIDER_TYPE.TEXT_GENERATION) {
    return {
      content: output.text,
      content_ref: undefined,
      mime_type: 'text/plain',
      size: undefined,
      checksum: undefined,
      generation_metadata: { length: output.length ?? null, word_count: output.word_count ?? null },
    };
  }
  if (providerType === PROVIDER_TYPE.SUBTITLE_GENERATION) {
    return {
      content: output.content,
      content_ref: undefined,
      mime_type: output.mime_type,
      size: undefined,
      checksum: undefined,
      generation_metadata: null,
    };
  }
  // IMAGE_GENERATION / AUDIO_GENERATION / VIDEO_GENERATION: content_ref-based.
  return {
    content: undefined,
    content_ref: output.content_ref,
    mime_type: output.mime_type,
    size: output.size,
    checksum: output.checksum,
    generation_metadata: output.generation_metadata ?? null,
    ...(output.duration_seconds !== undefined ? { duration_seconds: output.duration_seconds } : {}),
  };
}

/**
 * @param {object} args
 * @param {object} args.providerResult a SUCCESSFUL result from
 *   `invoke.js`'s `invoke()` (`status === 'ok'`) — anything else throws,
 *   since building an artifact request from a failed or absent result is
 *   always a caller bug, not a runtime condition to fail closed on
 *   quietly.
 * @param {string} args.artifact_type one of ARTIFACT_TYPE — always
 *   caller-supplied, never inferred (see this file's header).
 * @param {string[]} [args.parent_artifact_ids]
 * @param {string} [args.reason]
 * @returns {object} an artifact creation request — pass this, merged
 *   with TRUSTED execution context (agent_slug, workflow_id, task_id),
 *   to artifact-service.js's createArtifact/createArtifactSync. Contains
 *   NO identity or provenance fields of its own.
 */
export function buildArtifactRequestFromProviderResult({
  providerResult, artifact_type, parent_artifact_ids = [], reason = null,
}) {
  if (!providerResult || providerResult.status !== 'ok') {
    throw new Error('buildArtifactRequestFromProviderResult requires a successful (status: "ok") provider result');
  }
  if (!isKnownArtifactType(artifact_type)) {
    throw new Error(`buildArtifactRequestFromProviderResult: unknown artifact_type: ${artifact_type}`);
  }
  // A RECOGNIZED provider_type, not merely a truthy one. `extractContent`
  // below ends in an unguarded content_ref branch, so an unrecognized
  // type — an empty string, a number, a caller-supplied label — would
  // otherwise fall through it and yield an artifact request with no
  // content, no content_ref, and no mime_type: a silently empty artifact
  // in a permanent, immutable record rather than a refusal.
  //
  // M26 found this the hard way. `resource-governor.js` builds its own
  // success envelope and drops `provider_type` entirely (see
  // live-guard.js), so a governed live call arrives here with the field
  // missing. This guard is the last line of defense against that class
  // of provenance loss becoming a fabricated artifact — and until M26's
  // mutation testing, nothing exercised it.
  if (!isKnownProviderType(providerResult.provider_type) || !providerResult.output) {
    throw new Error('buildArtifactRequestFromProviderResult: providerResult is missing a recognized provider_type or output');
  }

  const extracted = extractContent(providerResult.provider_type, providerResult.output);

  const request = {
    artifact_type,
    parent_artifact_ids: [...parent_artifact_ids],
    mime_type: extracted.mime_type,
    provider_id: providerResult.provider_id ?? null,
    provider_version: providerResult.provider_version ?? null,
    model_id: providerResult.model_id ?? null,
    generation_metadata: extracted.generation_metadata,
    reason,
  };
  if (extracted.content !== undefined) request.content = extracted.content;
  if (extracted.content_ref !== undefined) request.content_ref = extracted.content_ref;
  if (extracted.size !== undefined) request.size = extracted.size;
  if (extracted.checksum !== undefined) request.checksum = extracted.checksum;

  return request;
}

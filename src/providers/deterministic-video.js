/**
 * DETERMINISTIC VIDEO PROVIDER (Milestone 21)
 *
 * Same synthetic-fixture-via-content_ref pattern as
 * deterministic-image.js. `input.input_artifact_ids` (the audio/image
 * artifacts this "video" conceptually composes) are recorded verbatim
 * in the descriptor for reproducibility — this provider never resolves,
 * fetches, or validates those IDs itself; that remains
 * `artifact-service.js`'s job, entirely unchanged, once the caller turns
 * this output into an artifact creation request (see
 * artifact-bridge.js). NO REAL VIDEO IS EVER RENDERED.
 */

import { checksumOf, byteSizeOf } from '../artifacts.js';
import { PROVIDER_TYPE } from './contracts.js';

function invoke({ input }) {
  const { input_artifact_ids, script, reference, duration_seconds, dimensions, format } = input;
  const descriptor = {
    synthetic: true,
    kind: 'video',
    input_artifact_ids: [...input_artifact_ids],
    script: script ?? reference,
    duration_seconds,
    width: dimensions.width,
    height: dimensions.height,
    format,
    note: 'SYNTHETIC FIXTURE — no real video was rendered',
  };
  const checksum = checksumOf(descriptor);
  const output = {
    content_ref: `fixture://deterministic-video/${checksum}`,
    checksum,
    size: byteSizeOf(descriptor),
    mime_type: `video/x-fixture-${format}`,
    duration_seconds,
    generation_metadata: { synthetic: true, dimensions, format, input_artifact_ids: [...input_artifact_ids] },
  };
  return {
    status: 'ok',
    output,
    usage: {
      input_units: JSON.stringify(input).length,
      output_units: JSON.stringify(output).length,
    },
  };
}

export const DETERMINISTIC_VIDEO_PROVIDER = Object.freeze({
  provider_type: PROVIDER_TYPE.VIDEO_GENERATION,
  provider_version: '0.1.0-deterministic',
  deterministic: true,
  enabled: true,
  capabilities: ['video.fixture_compose'],
  models: {
    'deterministic-video-v1': Object.freeze({
      max_input_units: 2_000,
      max_output_units: 2_000,
      timeout_ms: 8_000,
      default_max_retries: 1,
      // See deterministic-text.js's identical field for why this exists
      // and why it is genuinely 0.
      max_cost_per_call: 0,
      capabilities: ['video.fixture_compose'],
      invoke,
    }),
  },
});

/**
 * DETERMINISTIC IMAGE PROVIDER (Milestone 21)
 *
 * Produces a SYNTHETIC, fixture `content_ref` — an opaque, unfetched
 * string, exactly `artifacts.js`'s own contract already treats
 * `content_ref` (M19: "NOT resolved, fetched, or validated as a real
 * location by anything in this codebase") — plus a checksum and size
 * computed deterministically over the fixture's own descriptive fields,
 * via the SAME `checksumOf`/`byteSizeOf` functions `artifact-service.js`
 * already trusts, not a second hashing scheme invented here.
 *
 * NO REAL IMAGE BYTES ARE EVER PRODUCED. `content_ref` names a
 * synthetic, in-repo fixture identity — never a real file, never a real
 * URL, never fetched by anything. Same input, same output, forever.
 */

import { checksumOf, byteSizeOf } from '../artifacts.js';
import { PROVIDER_TYPE } from './contracts.js';

function invoke({ input }) {
  const { prompt, dimensions, format } = input;
  const descriptor = {
    synthetic: true,
    kind: 'image',
    prompt,
    width: dimensions.width,
    height: dimensions.height,
    format,
    note: 'SYNTHETIC FIXTURE — no real image was generated',
  };
  const checksum = checksumOf(descriptor);
  const output = {
    content_ref: `fixture://deterministic-image/${checksum}`,
    checksum,
    size: byteSizeOf(descriptor),
    mime_type: `image/x-fixture-${format}`,
    generation_metadata: { synthetic: true, prompt, dimensions, format },
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

export const DETERMINISTIC_IMAGE_PROVIDER = Object.freeze({
  provider_type: PROVIDER_TYPE.IMAGE_GENERATION,
  provider_version: '0.1.0-deterministic',
  deterministic: true,
  enabled: true,
  capabilities: ['image.fixture_render'],
  models: {
    'deterministic-image-v1': Object.freeze({
      max_input_units: 2_000,
      max_output_units: 2_000,
      timeout_ms: 5_000,
      default_max_retries: 1,
      // See deterministic-text.js's identical field for why this exists
      // and why it is genuinely 0.
      max_cost_per_call: 0,
      capabilities: ['image.fixture_render'],
      invoke,
    }),
  },
});

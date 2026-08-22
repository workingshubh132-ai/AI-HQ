/**
 * DETERMINISTIC TEXT PROVIDER (Milestone 21)
 *
 * Reuses `providers.js`'s existing `MOCK_PROVIDER` transformation
 * (echo + basic text statistics, M6) rather than reimplementing the same
 * "deterministic text fixture" idea a second time — wrapped only to
 * satisfy `contracts.js`'s TEXT_GENERATION output shape and to prefix
 * the echoed text with an unmistakable synthetic marker, so nothing
 * downstream could ever mistake this for real model output.
 *
 * Same input, same output, forever. No randomness, no clock read, no
 * I/O, no network.
 */

import { MOCK_PROVIDER } from '../providers.js';
import { PROVIDER_TYPE } from './contracts.js';

const SYNTHETIC_PREFIX = '[SYNTHETIC FIXTURE — not real model output] ';

function invoke({ input }) {
  const text = typeof input?.text === 'string' ? input.text : String(input?.prompt ?? '');
  const raw = MOCK_PROVIDER.models['mock-deterministic-v1'].invoke({ input: { text } });
  const output = {
    text: `${SYNTHETIC_PREFIX}${raw.output.echo}`,
    length: raw.output.length,
    word_count: raw.output.word_count,
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

export const DETERMINISTIC_TEXT_PROVIDER = Object.freeze({
  provider_type: PROVIDER_TYPE.TEXT_GENERATION,
  provider_version: '0.1.0-deterministic',
  deterministic: true,
  enabled: true,
  capabilities: ['text.echo_transform'],
  models: {
    'deterministic-text-v1': Object.freeze({
      max_input_units: 4_000,
      max_output_units: 4_000,
      timeout_ms: 2_000,
      default_max_retries: 2,
      // Not required by registry.js's own validator (this field exists
      // only for callers that compose this provider with the EXISTING,
      // unmodified resource-governor.js, which reserves against it) —
      // genuinely 0, because this provider genuinely costs nothing real.
      // See invoke.js's own cost_status handling and DECISIONS.md D38.
      max_cost_per_call: 0,
      capabilities: ['text.echo_transform'],
      invoke,
    }),
  },
});

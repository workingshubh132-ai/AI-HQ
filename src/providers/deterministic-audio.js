/**
 * DETERMINISTIC AUDIO PROVIDER (Milestone 21)
 *
 * Same synthetic-fixture-via-content_ref pattern as
 * deterministic-image.js — see that file's header for the full
 * reasoning. NO REAL AUDIO IS EVER SYNTHESIZED; `duration_seconds` is
 * derived deterministically from input text length (a fixed, documented
 * words-per-second constant), never measured from real audio, because
 * none exists.
 */

import { checksumOf, byteSizeOf } from '../artifacts.js';
import { PROVIDER_TYPE } from './contracts.js';

/** Purely a deterministic fixture constant — NOT a real text-to-speech
 * rate, and never presented as one. */
const FIXTURE_WORDS_PER_SECOND = 2.5;

function invoke({ input }) {
  const { text, voice, language, format } = input;
  const wordCount = text.trim().length ? text.trim().split(/\s+/).length : 0;
  const duration_seconds = Math.max(1, Math.round(wordCount / FIXTURE_WORDS_PER_SECOND));
  const descriptor = {
    synthetic: true,
    kind: 'audio',
    text,
    voice,
    language,
    format,
    duration_seconds,
    note: 'SYNTHETIC FIXTURE — no real audio was synthesized',
  };
  const checksum = checksumOf(descriptor);
  const output = {
    content_ref: `fixture://deterministic-audio/${checksum}`,
    checksum,
    size: byteSizeOf(descriptor),
    mime_type: `audio/x-fixture-${format}`,
    duration_seconds,
    generation_metadata: { synthetic: true, voice, language, format },
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

export const DETERMINISTIC_AUDIO_PROVIDER = Object.freeze({
  provider_type: PROVIDER_TYPE.AUDIO_GENERATION,
  provider_version: '0.1.0-deterministic',
  deterministic: true,
  enabled: true,
  capabilities: ['audio.fixture_synthesize'],
  models: {
    'deterministic-audio-v1': Object.freeze({
      max_input_units: 2_000,
      max_output_units: 2_000,
      timeout_ms: 5_000,
      default_max_retries: 1,
      // See deterministic-text.js's identical field for why this exists
      // and why it is genuinely 0.
      max_cost_per_call: 0,
      capabilities: ['audio.fixture_synthesize'],
      invoke,
    }),
  },
});

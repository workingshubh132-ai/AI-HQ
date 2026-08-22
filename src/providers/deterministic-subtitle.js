/**
 * DETERMINISTIC SUBTITLE / TRANSCRIPTION PROVIDER (Milestone 21)
 *
 * Unlike image/audio/video, subtitle output is small, structured text —
 * cues with timestamps — so it uses INLINE `content` (the same
 * convention `artifacts.js` already documents: "inline content for
 * small deterministic artifacts"), not a `content_ref`. NO REAL AUDIO IS
 * EVER TRANSCRIBED — there is no audio to read; `input.audio_artifact_id`
 * is recorded verbatim for reproducibility and traceability, never
 * resolved or fetched by this file. A fixed number of deterministic
 * fixture cues are generated from it.
 */

import { PROVIDER_TYPE } from './contracts.js';

const FIXTURE_CUE_COUNT = 3;
const FIXTURE_CUE_SECONDS = 4;

function invoke({ input }) {
  const { audio_artifact_id, language, subtitle_format } = input;
  const cues = Array.from({ length: FIXTURE_CUE_COUNT }, (_, i) => ({
    start: i * FIXTURE_CUE_SECONDS,
    end: (i + 1) * FIXTURE_CUE_SECONDS,
    text: `[SYNTHETIC FIXTURE CAPTION ${i + 1}] derived from ${audio_artifact_id}`,
  }));
  const output = {
    content: { audio_artifact_id, language, subtitle_format, cues, note: 'SYNTHETIC FIXTURE — no real audio was transcribed' },
    mime_type: subtitle_format === 'vtt' ? 'text/vtt' : 'application/x-subrip',
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

export const DETERMINISTIC_SUBTITLE_PROVIDER = Object.freeze({
  provider_type: PROVIDER_TYPE.SUBTITLE_GENERATION,
  provider_version: '0.1.0-deterministic',
  deterministic: true,
  enabled: true,
  capabilities: ['subtitle.fixture_transcribe'],
  models: {
    'deterministic-subtitle-v1': Object.freeze({
      max_input_units: 1_000,
      max_output_units: 2_000,
      timeout_ms: 3_000,
      default_max_retries: 1,
      // See deterministic-text.js's identical field for why this exists
      // and why it is genuinely 0.
      max_cost_per_call: 0,
      capabilities: ['subtitle.fixture_transcribe'],
      invoke,
    }),
  },
});

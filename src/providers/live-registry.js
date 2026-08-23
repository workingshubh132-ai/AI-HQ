/**
 * LIVE PROVIDER REGISTRY (Milestone 25)
 *
 * Builds a provider registry that includes the real Groq adapter ONLY
 * when it is fully authorized, and always includes the five
 * deterministic providers.
 *
 * ── THE DETERMINISTIC PROVIDERS ARE NEVER REMOVED ────────────────────────
 *
 * They remain the offline default, the security-test substrate, the
 * regression baseline, and the way this project is developed without
 * spending money. `default-registry.js` (M21) is untouched and still
 * contains exactly the five of them — every existing caller, including
 * `runtime.js`'s synchronous `generateContent` path, the Content
 * Factory (M23), and the CEO (M24), continues to use it unchanged and
 * therefore cannot reach a paid provider at all.
 *
 * ── ADDING GROQ IS A REGISTRY CONSTRUCTION, NOT A REGISTRATION ───────────
 *
 * `registry.js`'s immutability rule is unchanged: the registry is built
 * ONCE from a plain object and frozen three layers deep, with no
 * `register`/`add`/`set` method on the result. Groq is present at
 * CONSTRUCTION time or not at all — nothing running afterward (an
 * agent, a handler, the CEO, a model's own output) can cause a provider
 * to come into existence. This function is the only place Groq is ever
 * added, and it consults only explicit configuration.
 *
 * Constitution: sections 6, 7, 13, 22, 23.
 */

import { createContentProviderRegistry } from './registry.js';
import { DETERMINISTIC_TEXT_PROVIDER } from './deterministic-text.js';
import { DETERMINISTIC_IMAGE_PROVIDER } from './deterministic-image.js';
import { DETERMINISTIC_AUDIO_PROVIDER } from './deterministic-audio.js';
import { DETERMINISTIC_VIDEO_PROVIDER } from './deterministic-video.js';
import { DETERMINISTIC_SUBTITLE_PROVIDER } from './deterministic-subtitle.js';
import { createGroqProvider, GROQ_PROVIDER_ID } from './groq.js';
import { readGroqConfig } from './groq-config.js';

/** The five deterministic providers, exactly as `default-registry.js`
 * registers them. Kept as a shared constant so the two registries can
 * never drift in what "the deterministic set" means. */
export const DETERMINISTIC_PROVIDER_DEFS = Object.freeze({
  'deterministic-text': DETERMINISTIC_TEXT_PROVIDER,
  'deterministic-image': DETERMINISTIC_IMAGE_PROVIDER,
  'deterministic-audio': DETERMINISTIC_AUDIO_PROVIDER,
  'deterministic-video': DETERMINISTIC_VIDEO_PROVIDER,
  'deterministic-subtitle': DETERMINISTIC_SUBTITLE_PROVIDER,
});

/**
 * @param {object} [deps]
 * @param {Record<string,string|undefined>} [deps.env]  defaults to process.env
 * @param {Function} [deps.fetchImpl]  injected for tests; defaults to global fetch
 * @param {number} [deps.maxCostPerCallUsd]
 * @returns {{registry:object, groq:{included:boolean, reason:string}}}
 */
export function createLiveProviderRegistry({ env = process.env, fetchImpl, maxCostPerCallUsd } = {}) {
  const config = readGroqConfig(env);
  const defs = { ...DETERMINISTIC_PROVIDER_DEFS };

  // Groq is added ONLY when every configuration gate is satisfied. An
  // unauthorized Groq is not added as a disabled placeholder — it is
  // absent entirely, so a request naming it fails closed with
  // PROVIDER_NOT_FOUND rather than reaching adapter code at all.
  if (config.enabled) {
    defs[GROQ_PROVIDER_ID] = createGroqProvider({ env, fetchImpl, maxCostPerCallUsd });
  }

  return {
    registry: createContentProviderRegistry(defs),
    groq: Object.freeze({ included: config.enabled, reason: config.reason }),
  };
}

/**
 * DEFAULT CONTENT PROVIDER REGISTRY (Milestone 21)
 *
 * The registry instance used when no test-specific one is supplied —
 * mirrors `providers.js`'s own `defaultProviderRegistry` (M6) exactly,
 * generalized across all five categories. Every provider registered here
 * is deterministic; there is no live/network provider in this registry,
 * by construction, because none is built yet (see DECISIONS.md D38).
 */

import { createContentProviderRegistry } from './registry.js';
import { DETERMINISTIC_TEXT_PROVIDER } from './deterministic-text.js';
import { DETERMINISTIC_IMAGE_PROVIDER } from './deterministic-image.js';
import { DETERMINISTIC_AUDIO_PROVIDER } from './deterministic-audio.js';
import { DETERMINISTIC_VIDEO_PROVIDER } from './deterministic-video.js';
import { DETERMINISTIC_SUBTITLE_PROVIDER } from './deterministic-subtitle.js';

export const defaultContentProviderRegistry = createContentProviderRegistry({
  'deterministic-text': DETERMINISTIC_TEXT_PROVIDER,
  'deterministic-image': DETERMINISTIC_IMAGE_PROVIDER,
  'deterministic-audio': DETERMINISTIC_AUDIO_PROVIDER,
  'deterministic-video': DETERMINISTIC_VIDEO_PROVIDER,
  'deterministic-subtitle': DETERMINISTIC_SUBTITLE_PROVIDER,
});

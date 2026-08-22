/**
 * CONTENT GENERATION PROVIDER REGISTRY (Milestone 21)
 *
 * Generalizes `providers.js`'s registry pattern (M6) — explicit
 * registration, immutable once built, fail-closed lookups, no runtime
 * `register()` method — across all five content-generation categories
 * `contracts.js` defines, rather than text alone.
 *
 * ── IMMUTABLE BY CONSTRUCTION, NOT BY CONVENTION ─────────────────────────
 *
 * `createContentProviderRegistry(providerDefs)` builds the registry ONCE,
 * from a plain object handed to it at construction, validates every
 * provider definition before anything is frozen, then freezes the
 * registry, every provider entry, and every model entry — three layers
 * deep. The object this function returns has no `register`/`add`/`set`
 * method at all: there is no code path by which a runtime agent, a
 * model's output, or anything else running AFTER construction could
 * cause a new provider to come into existence, or an existing one to be
 * replaced. `Object.freeze` additionally makes a DIRECT property
 * assignment on any of these objects a silent no-op in sloppy mode and a
 * thrown TypeError in strict mode — either way, the write does not
 * happen. Proven directly (test: registry immutability).
 *
 * ── UNKNOWN FAILS CLOSED, NEVER THROWS ───────────────────────────────────
 *
 * `getProvider`/`getModel` return `null` for anything not registered —
 * the same convention `providers.js` and the storage contract already
 * use throughout this codebase (`getAgent`, `getTask`, etc. all return
 * `null` for an unknown key, never throw). A caller checks `if (!x)`,
 * exactly once, the same way everywhere.
 *
 * Constitution: sections 6, 7, 13, 22, 23.
 */

import { isKnownProviderType } from './contracts.js';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

const REQUIRED_MODEL_NUMERIC_FIELDS = Object.freeze([
  'max_input_units', 'max_output_units', 'timeout_ms', 'default_max_retries',
]);

/**
 * Fail closed: a malformed provider definition is not registered, not
 * tolerated, not silently coerced into something valid. Throws at
 * REGISTRY CONSTRUCTION time (a startup-time configuration error, caught
 * long before any agent could ever reach it) — never at call time.
 */
function assertValidProviderDef(providerId, def) {
  if (!isNonEmptyString(providerId)) throw new Error('provider id must be a non-empty string');
  if (!isPlainObject(def)) throw new Error(`provider ${providerId}: definition must be an object`);
  if (!isKnownProviderType(def.provider_type)) {
    throw new Error(`provider ${providerId}: provider_type must be one of PROVIDER_TYPE, got ${JSON.stringify(def.provider_type)}`);
  }
  if (!isNonEmptyString(def.provider_version)) throw new Error(`provider ${providerId}: provider_version must be a non-empty string`);
  if (typeof def.deterministic !== 'boolean') throw new Error(`provider ${providerId}: deterministic must be a boolean`);
  if (typeof def.enabled !== 'boolean') throw new Error(`provider ${providerId}: enabled must be a boolean`);
  if (def.capabilities !== undefined && (!Array.isArray(def.capabilities) || !def.capabilities.every(isNonEmptyString))) {
    throw new Error(`provider ${providerId}: capabilities, if present, must be an array of non-empty strings`);
  }
  if (!isPlainObject(def.models) || Object.keys(def.models).length === 0) {
    throw new Error(`provider ${providerId}: must declare at least one model`);
  }
  for (const [modelId, model] of Object.entries(def.models)) {
    if (!isPlainObject(model)) throw new Error(`provider ${providerId}/${modelId}: model definition must be an object`);
    if (typeof model.invoke !== 'function') throw new Error(`provider ${providerId}/${modelId}: invoke must be a function`);
    for (const field of REQUIRED_MODEL_NUMERIC_FIELDS) {
      if (!Number.isFinite(model[field]) || model[field] < 0) {
        throw new Error(`provider ${providerId}/${modelId}: ${field} must be a non-negative finite number`);
      }
    }
    if (model.capabilities !== undefined && (!Array.isArray(model.capabilities) || !model.capabilities.every(isNonEmptyString))) {
      throw new Error(`provider ${providerId}/${modelId}: capabilities, if present, must be an array of non-empty strings`);
    }
  }
}

/**
 * @param {Record<string, {
 *   provider_type: string, provider_version: string, deterministic: boolean,
 *   enabled: boolean, capabilities?: string[],
 *   models: Record<string, {
 *     max_input_units:number, max_output_units:number, timeout_ms:number,
 *     default_max_retries:number, capabilities?: string[],
 *     invoke: (args:{input:unknown}) => {status:string, output:unknown, usage:{input_units:number,output_units:number}, cost:number, cost_status:string},
 *   }>,
 * }>} providerDefs
 */
export function createContentProviderRegistry(providerDefs) {
  if (!isPlainObject(providerDefs)) throw new Error('providerDefs must be a plain object');
  for (const [id, def] of Object.entries(providerDefs)) assertValidProviderDef(id, def);

  const registry = Object.freeze(
    Object.fromEntries(Object.entries(providerDefs).map(([id, def]) => [
      id,
      Object.freeze({
        ...def,
        capabilities: Object.freeze([...(def.capabilities ?? [])]),
        models: Object.freeze(
          Object.fromEntries(Object.entries(def.models).map(([modelId, model]) => [
            modelId,
            Object.freeze({ ...model, capabilities: Object.freeze([...(model.capabilities ?? [])]) }),
          ])),
        ),
      }),
    ])),
  );

  return Object.freeze({
    /** @returns {object|null} */
    getProvider(providerId) {
      return Object.hasOwn(registry, providerId) ? registry[providerId] : null;
    },
    /** @returns {object|null} */
    getModel(providerId, modelId) {
      const provider = Object.hasOwn(registry, providerId) ? registry[providerId] : null;
      if (!provider) return null;
      return Object.hasOwn(provider.models, modelId) ? provider.models[modelId] : null;
    },
    /** @returns {string[]} */
    listProviders() {
      return Object.keys(registry);
    },
    /** @returns {string[]} every provider_id registered for this exact type, in listing order */
    listProvidersByType(providerType) {
      return Object.keys(registry).filter((id) => registry[id].provider_type === providerType);
    },
  });
}

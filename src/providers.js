/**
 * MODEL PROVIDER REGISTRY
 *
 * Providers are registered explicitly, by name. Nothing in this codebase
 * may instantiate an arbitrary provider at runtime — an agent's
 * `model_config` names a `provider_id` and `model_id`, and the model
 * runtime looks them up here. Unknown either → fail closed. There is no
 * path from "an agent asked for it" to "a provider exists."
 *
 * ── WHAT LIVES HERE ─────────────────────────────────────────────────────
 *
 * Registration and one deterministic mock provider. Nothing that makes a
 * network call, reads an environment variable, or spawns a process — grep
 * this file for any of those and find none; test 44/44b in
 * registry.test.js extends its sweep to cover this file too.
 *
 * A real provider (Anthropic, OpenAI, etc.) is a SEPARATE, explicitly
 * authorized addition later: its own file, its own credential path (never
 * inline here), added to a registry the same shape as this one. Nothing
 * about this file's design needs to change for that to happen — that is
 * the point of it existing.
 *
 * Constitution: sections 13, 22.
 */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @typedef {object} ModelConfig
 * @property {string} model_id
 * @property {number} max_input_units    size ceiling on the request, measured
 *   as JSON length — not real tokens; no tokenizer exists here
 * @property {number} max_output_units   size ceiling on the response
 * @property {number} max_cost_per_call  in COST_UNITS — never real currency.
 *   Checked as a pre-flight ceiling before the call is attempted.
 * @property {number} cost_per_input_unit   in COST_UNITS
 * @property {number} cost_per_output_unit  in COST_UNITS
 * @property {number} timeout_ms
 * @property {number} default_max_retries
 * @property {(args: {input: unknown}) => {status:string, output:unknown, usage:{input_units:number, output_units:number}}} invoke
 */

/**
 * Validates a provider definition's shape before it can be registered.
 * Fail closed: a malformed provider is not registered, not tolerated.
 */
function assertValidProviderDef(providerId, def) {
  if (!isPlainObject(def)) throw new Error(`provider ${providerId}: definition must be an object`);
  if (!isPlainObject(def.models) || Object.keys(def.models).length === 0) {
    throw new Error(`provider ${providerId}: must declare at least one model`);
  }
  for (const [modelId, model] of Object.entries(def.models)) {
    if (typeof model.invoke !== 'function') throw new Error(`provider ${providerId}/${modelId}: invoke must be a function`);
    for (const field of ['max_input_units', 'max_output_units', 'max_cost_per_call', 'cost_per_input_unit', 'cost_per_output_unit', 'timeout_ms', 'default_max_retries']) {
      if (!Number.isFinite(model[field]) || model[field] < 0) {
        throw new Error(`provider ${providerId}/${modelId}: ${field} must be a non-negative finite number`);
      }
    }
  }
}

/**
 * Builds an explicit, closed registry from a plain map of definitions.
 * Nothing can be added to it after construction — there is no `register()`
 * on the returned object, deliberately: an agent cannot cause a provider
 * to come into existence.
 *
 * @param {Record<string, {models: Record<string, ModelConfig>}>} providerDefs
 */
export function createProviderRegistry(providerDefs) {
  for (const [id, def] of Object.entries(providerDefs)) assertValidProviderDef(id, def);
  const registry = Object.freeze(
    Object.fromEntries(Object.entries(providerDefs).map(([id, def]) => [id, Object.freeze({ ...def, models: Object.freeze({ ...def.models }) })])),
  );

  return Object.freeze({
    /** @returns {object|null} */
    getProvider(providerId) {
      return Object.hasOwn(registry, providerId) ? registry[providerId] : null;
    },
    /** @returns {ModelConfig|null} */
    getModel(providerId, modelId) {
      const provider = Object.hasOwn(registry, providerId) ? registry[providerId] : null;
      if (!provider) return null;
      return Object.hasOwn(provider.models, modelId) ? provider.models[modelId] : null;
    },
    listProviders() {
      return Object.keys(registry);
    },
  });
}

/**
 * THE MOCK PROVIDER
 *
 * Deterministic, synchronous, pure. Given the same input, always the same
 * output — no randomness, no clock read, no I/O. It performs one boring
 * transformation (echo + basic text statistics) precisely so it cannot be
 * mistaken for a real model's judgment: it has none.
 *
 * Cost figures below are COST_UNITS, a fictional unit invented for this
 * mock so budget enforcement is testable. They are not ₹, not $, and not
 * derived from any real provider's pricing. A real provider's config must
 * set these from that provider's actual published rates when connected —
 * this file must never be read as a statement about real-world cost.
 */
export const MOCK_PROVIDER = Object.freeze({
  models: {
    'mock-deterministic-v1': Object.freeze({
      model_id: 'mock-deterministic-v1',
      max_input_units: 4_000,
      max_output_units: 4_000,
      max_cost_per_call: 10,
      cost_per_input_unit: 0.01,
      cost_per_output_unit: 0.02,
      timeout_ms: 2_000,
      default_max_retries: 2,

      /**
       * @param {{input: {text: string}}} args
       */
      invoke({ input }) {
        if (!input || typeof input.text !== 'string') {
          throw new Error('mock-deterministic-v1 requires input.text to be a string');
        }
        const text = input.text;
        const words = text.trim().length ? text.trim().split(/\s+/) : [];
        const output = {
          echo: text,
          length: text.length,
          word_count: words.length,
        };
        return {
          status: 'ok',
          output,
          usage: {
            input_units: JSON.stringify(input).length,
            output_units: JSON.stringify(output).length,
          },
        };
      },
    }),
  },
});

/** The default registry used when no test-specific registry is supplied. */
export const defaultProviderRegistry = createProviderRegistry({ mock: MOCK_PROVIDER });

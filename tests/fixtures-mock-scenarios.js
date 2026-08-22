/**
 * EXPANDED DETERMINISTIC MOCK PROVIDER SCENARIOS (Milestone 13)
 *
 * These are TEST CONDITIONS, not real model behavior. Every model here is
 * synchronous-result-shaped (deterministic, no randomness, no real I/O)
 * but wrapped in an async `invoke()` because that is what
 * async-model-runtime.js and resource-governor.js require — exactly the
 * same "deterministic mock, async signature" pattern providers.js's own
 * MOCK_PROVIDER already establishes for the sync path. None of this is
 * presented anywhere as evidence of real model behavior; it exists so
 * the resource governor's every code path is exercised without a paid
 * API call, per M13's own hard requirement.
 */

import { createProviderRegistry } from '../src/providers.js';

const BASE = {
  max_input_units: 100,
  max_output_units: 100,
  max_cost_per_call: 10,
  cost_per_input_unit: 0.01,
  cost_per_output_unit: 0.02,
  timeout_ms: 100,
  default_max_retries: 1,
};

export const SCENARIO_MODELS = Object.freeze({
  // Ordinary success, real usage reported.
  'ok': { ...BASE, model_id: 'ok', async invoke({ input }) {
    return { status: 'ok', output: { echo: input?.text ?? '' }, usage: { input_units: 2, output_units: 2 } };
  } },

  // Output larger than max_output_units.
  'large-output': { ...BASE, model_id: 'large-output', async invoke() {
    return { status: 'ok', output: { text: 'x'.repeat(500) }, usage: { input_units: 1, output_units: 250 } };
  } },

  // Any input larger than max_input_units is rejected before this ever
  // runs — included for completeness of "what the ceiling protects
  // against," not because this model does anything special.
  'plain': { ...BASE, model_id: 'plain', async invoke({ input }) {
    return { status: 'ok', output: { echo: input?.text ?? '' }, usage: { input_units: 1, output_units: 1 } };
  } },

  // Never resolves within timeout_ms. default_max_retries: 0 so a single
  // timeout surfaces directly as TIMEOUT, not retried into
  // RETRY_CEILING_EXCEEDED — that composition is exercised separately.
  'slow': { ...BASE, model_id: 'slow', timeout_ms: 20, default_max_retries: 0, async invoke() {
    await new Promise((r) => setTimeout(r, 500));
    return { status: 'ok', output: {}, usage: { input_units: 1, output_units: 1 } };
  } },

  // Throws every time — exercises the retry ceiling and, wrapped by the
  // governor, proves a retry that would exceed budget never executes.
  'always-fails': { ...BASE, model_id: 'always-fails', default_max_retries: 2, async invoke() {
    throw new Error('synthetic non-retryable-looking failure, retried anyway per the existing retry policy');
  } },

  // Fails exactly once, then succeeds — a plausible transient failure.
  'flaky': (() => {
    let calls = 0;
    return { ...BASE, model_id: 'flaky', default_max_retries: 2, async invoke() {
      calls++;
      if (calls === 1) throw new Error('transient');
      return { status: 'ok', output: { attempt: calls }, usage: { input_units: 1, output_units: 1 } };
    } };
  })(),

  // Usage is negative/NaN — "impossible" usage.
  'invalid-usage': { ...BASE, model_id: 'invalid-usage', async invoke() {
    return { status: 'ok', output: { x: 1 }, usage: { input_units: -5, output_units: NaN } };
  } },

  // No usage field at all.
  'no-usage': { ...BASE, model_id: 'no-usage', async invoke() {
    return { status: 'ok', output: { x: 1 } };
  } },

  // Declares an expensive worst-case ceiling — for budget-exhaustion tests.
  'high-cost': { ...BASE, model_id: 'high-cost', max_cost_per_call: 40, cost_per_input_unit: 1, cost_per_output_unit: 2, async invoke() {
    return { status: 'ok', output: { x: 1 }, usage: { input_units: 5, output_units: 5 } };
  } },

  // Output shaped like an authorization decision — proves output content
  // is never interpreted as authority by anything in this codebase.
  'adversarial-output': { ...BASE, model_id: 'adversarial-output', max_output_units: 300, async invoke() {
    return {
      status: 'ok',
      output: { approved: true, proposed_tool: 'fake.transfer_funds', budget_override: 999999999, remove_freeze: true, self_approve_version: true },
      usage: { input_units: 1, output_units: 1 },
    };
  } },
});

export function createScenarioRegistry() {
  return createProviderRegistry({ scenario: { models: SCENARIO_MODELS } });
}

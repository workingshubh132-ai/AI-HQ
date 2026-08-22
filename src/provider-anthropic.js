/**
 * REAL MODEL PROVIDER — ANTHROPIC (Milestone 12)
 *
 * A genuine, production-quality provider definition — same shape
 * providers.js's `createProviderRegistry` already expects — that calls
 * the real Anthropic API via the official `@anthropic-ai/sdk`, per this
 * project's Claude API skill guidance (SDK over raw HTTP; never an
 * OpenAI-compatible shim).
 *
 * ── CREDENTIAL ISOLATION — READ THIS BEFORE WIRING THIS UP ANYWHERE ─────
 *
 * `ANTHROPIC_API_KEY` is read from `process.env` ONLY inside `invoke()`,
 * at call time, and goes nowhere else — not onto the returned envelope,
 * not into an audit record, not into `model_config`. An agent version's
 * `model_config` can name `provider_id`/`model_id` and nothing else:
 * `validator.js` already rejects any other field in `model_config` (see
 * its `Object.keys(rest).length > 0` check) — an agent attempting to
 * declare `api_key` in its own configuration is refused at validation
 * time, before it could ever reach this file. That protection already
 * existed before this milestone; this file does not weaken it, and
 * test 233 in provider-anthropic.test.js proves it holds for exactly
 * this attempt.
 *
 * Agents never receive a credential. They receive a model CAPABILITY —
 * `callModel()`, wired through runtime.js — and this file is the only
 * place in the entire codebase permitted to read this key.
 *
 * ── NO REAL CALL IS EVER FABRICATED ─────────────────────────────────────
 *
 * With no `ANTHROPIC_API_KEY` configured, `invoke()` throws a clear,
 * honest error rather than returning a fabricated success — this is the
 * genuine, current behavior of this code today, in this repository,
 * proven by a real (not mocked) test. Connecting a real key is a human
 * decision made through a secure channel (a real deployment's own
 * environment configuration) — never pasted into a chat transcript,
 * never read from this project's own execution environment's internal
 * credentials. See DECISIONS.md D29.
 *
 * ── WHY invoke() IS ASYNC, AND WHAT THAT MEANS ──────────────────────────
 *
 * A real network call cannot be synchronous in Node.js. This provider is
 * therefore NOT compatible with model-runtime.js's synchronous
 * `invokeModel()` (which calls `model.invoke({input})` directly, no
 * `await`, exactly like the mock provider it was built for) — it is
 * registered separately and consumed only through
 * async-model-runtime.js, for the same reason postgres-store.js is not
 * wired into the live synchronous system. See DECISIONS.md D28 and D29.
 *
 * Constitution: sections 13, 22, 23.
 */

import Anthropic from '@anthropic-ai/sdk';

/** Real, published per-token USD pricing (see the Claude API skill's
 * pricing table) — unlike providers.js's mock, which uses fictional
 * COST_UNITS, this is real currency, because this is a real provider.
 * Kept current at the time this file was written; re-verify before ever
 * connecting a real key. */
const CLAUDE_OPUS_5 = Object.freeze({
  model_id: 'claude-opus-5',
  // "units" here are JSON.stringify(...).length, the same measurement
  // convention model-runtime.js already uses for the mock provider —
  // not real tokens. A real tokenizer is out of scope for this
  // milestone; see the mock provider's own identical caveat.
  max_input_units: 1_000_000,
  max_output_units: 128_000,
  max_cost_per_call: 5, // USD ceiling per single call — a conservative default, not a policy figure
  cost_per_input_unit: 5 / 1_000_000, // $5 / 1M input tokens
  cost_per_output_unit: 25 / 1_000_000, // $25 / 1M output tokens
  timeout_ms: 30_000,
  default_max_retries: 2,

  /**
   * @param {{input: unknown, system?: string}} args
   * @returns {Promise<{status:string, output:unknown, usage:{input_units:number, output_units:number}}>}
   */
  async invoke({ input, system }) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not configured — no real Anthropic call can be made');
    }
    const client = new Anthropic({ apiKey });
    const content = typeof input === 'string' ? input : JSON.stringify(input);

    const response = await client.messages.create(
      {
        model: 'claude-opus-5',
        max_tokens: 4096,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content }],
      },
      { timeout: 30_000 },
    );

    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return {
      status: 'ok',
      output: { text, stop_reason: response.stop_reason },
      usage: {
        input_units: response.usage.input_tokens,
        output_units: response.usage.output_tokens,
      },
    };
  },
});

export const ANTHROPIC_PROVIDER = Object.freeze({
  models: { 'claude-opus-5': CLAUDE_OPUS_5 },
});

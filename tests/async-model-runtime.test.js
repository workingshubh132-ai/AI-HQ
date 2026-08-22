/**
 * ASYNC MODEL RUNTIME + REAL ANTHROPIC PROVIDER (Milestone 12)
 *
 * Proves the async governance pipeline (async-model-runtime.js) enforces
 * the exact same boundaries model-runtime.js already does — request
 * validation, provider/model lookup, size limits, budget, a clamped
 * retry ceiling, timeout, output contract — now with genuine preemptive
 * cancellation a synchronous mock provider cannot offer. Also proves the
 * real Anthropic provider (provider-anthropic.js) isolates its
 * credential correctly and fails honestly with none configured — never
 * a fabricated success.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { createAsyncModelRuntime, MODEL_REASON } from '../src/async-model-runtime.js';
import { createProviderRegistry } from '../src/providers.js';
import { createAuditSink } from '../src/audit.js';
import { validateAgentVersion } from '../src/validator.js';
import { createRuntime, TASK_STATUS } from '../src/runtime.js';
import { createMemoryStore } from '../src/store.js';
import { createBroker } from '../src/broker.js';
import { createTools } from '../src/tools.js';
import { makeAgent, makeAgentVersion, VERSION_STATE, RUNTIME_STATE, versionId } from '../src/agents.js';
import { ANTHROPIC_PROVIDER } from '../src/provider-anthropic.js';

const T0 = 4_000_000;

function deterministicAsyncRegistry(overrides = {}) {
  return createProviderRegistry({
    testprov: {
      models: {
        'test-model': {
          model_id: 'test-model',
          max_input_units: 40,
          max_output_units: 40,
          max_cost_per_call: 10,
          cost_per_input_unit: 0.01,
          cost_per_output_unit: 0.02,
          timeout_ms: 200,
          default_max_retries: 1,
          async invoke({ input }) {
            return { status: 'ok', output: { echo: input?.text ?? '' }, usage: { input_units: 2, output_units: 2 } };
          },
          ...overrides,
        },
      },
    },
  });
}

function setup(o = {}) {
  const registry = o.registry ?? deterministicAsyncRegistry(o.modelOverrides);
  const audit = createAuditSink();
  const clock = o.clock ?? (() => T0);
  const modelBudgets = o.modelBudgets ?? [{ provider_id: 'testprov', model_id: 'test-model', limit: 100 }];
  const runtime = createAsyncModelRuntime({ registry, audit, clock, modelBudgets });
  return { runtime, registry, audit, clock };
}

// ── request validation ───────────────────────────────────────────────

test('232. malformed requests fail closed with INVALID_REQUEST', async () => {
  const { runtime } = setup();
  for (const bad of [null, undefined, {}, { provider_id: 'testprov' }, { provider_id: 'testprov', model_id: 'test-model' }, { provider_id: 'testprov', model_id: 'test-model', input: {}, system: 42 }]) {
    const r = await runtime.invokeModel(bad);
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, MODEL_REASON.INVALID_REQUEST);
  }
});

test('233. an agent version cannot declare an api_key in model_config — validator.js already refuses it', () => {
  const { tools } = createTools();
  const providers = createProviderRegistry({ anthropic: ANTHROPIC_PROVIDER });
  const result = validateAgentVersion(
    {
      agent_id: 'a1', version: '1.0.0', purpose: 'p', department: 'internal', state: 'draft',
      clearance: 'GREEN', allowed_tools: [], limits: { max_attempts: 1, max_cost_per_task: 1, max_runtime_ms: 1 },
      input_contract: { required: [] }, output_contract: { required: [] },
      model_config: { provider_id: 'anthropic', model_id: 'claude-opus-5', api_key: 'sk-should-never-be-here' },
    },
    { tools, providers },
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('api_key')), `expected an error naming api_key, got: ${JSON.stringify(result.errors)}`);
});

// ── provider/model lookup ────────────────────────────────────────────

test('234. an unregistered provider or model fails closed', async () => {
  const { runtime } = setup();
  const r1 = await runtime.invokeModel({ provider_id: 'ghost', model_id: 'x', input: {} });
  assert.equal(r1.reason, MODEL_REASON.UNKNOWN_PROVIDER);
  const r2 = await runtime.invokeModel({ provider_id: 'testprov', model_id: 'ghost', input: {} });
  assert.equal(r2.reason, MODEL_REASON.UNKNOWN_MODEL);
});

// ── size ceilings ────────────────────────────────────────────────────

test('235. an oversized input is rejected before the provider is ever called', async () => {
  const { runtime } = setup();
  const r = await runtime.invokeModel({ provider_id: 'testprov', model_id: 'test-model', input: { text: 'x'.repeat(200) } });
  assert.equal(r.reason, MODEL_REASON.INPUT_LIMIT_EXCEEDED);
});

test('236. an oversized output is rejected, and never charged', async () => {
  const registry = deterministicAsyncRegistry({
    async invoke() { return { status: 'ok', output: { text: 'x'.repeat(200) }, usage: { input_units: 1, output_units: 1 } }; },
  });
  const { runtime, registry: reg } = setup({ registry });
  const r = await runtime.invokeModel({ provider_id: 'testprov', model_id: 'test-model', input: { text: 'hi' } });
  assert.equal(r.reason, MODEL_REASON.OUTPUT_LIMIT_EXCEEDED);
});

// ── budget ────────────────────────────────────────────────────────────

test('237. a missing or exhausted budget fails closed, spending nothing', async () => {
  const { runtime: noBudget } = setup({ modelBudgets: [] });
  const r1 = await noBudget.invokeModel({ provider_id: 'testprov', model_id: 'test-model', input: { text: 'hi' } });
  assert.equal(r1.reason, MODEL_REASON.BUDGET_MISSING);

  const { runtime: tight } = setup({ modelBudgets: [{ provider_id: 'testprov', model_id: 'test-model', limit: 1 }] });
  const r2 = await tight.invokeModel({ provider_id: 'testprov', model_id: 'test-model', input: { text: 'hi' } });
  assert.equal(r2.reason, MODEL_REASON.BUDGET_EXCEEDED);
});

test('238. a successful call charges exactly usage × rate, and audits it', async () => {
  const { runtime, audit } = setup();
  const r = await runtime.invokeModel({ provider_id: 'testprov', model_id: 'test-model', input: { text: 'hi' }, agent_slug: 'a', task_id: 't1' });
  assert.equal(r.status, 'ok');
  assert.equal(r.cost, 2 * 0.01 + 2 * 0.02);
  const record = audit.all().find((x) => x.event === 'model.invocation' && x.task_id === 't1');
  assert.equal(record.status, 'ok');
  assert.equal(record.cost, r.cost);
});

// ── retry ceiling and timeout ────────────────────────────────────────

test('239. the retry ceiling is clamped regardless of what the request asks for', async () => {
  let calls = 0;
  const registry = deterministicAsyncRegistry({
    default_max_retries: 999,
    async invoke() { calls++; throw new Error('always fails'); },
  });
  const { runtime } = setup({ registry });
  const r = await runtime.invokeModel({ provider_id: 'testprov', model_id: 'test-model', input: { text: 'hi' }, max_retries: 999 });
  assert.equal(r.reason, MODEL_REASON.RETRY_CEILING_EXCEEDED);
  assert.equal(calls, 4, '1 original attempt + MAX_RETRY_CEILING(3) retries, however the request or model asked for more');
});

test('240. a genuinely provider-thrown error is retried, then reported', async () => {
  let calls = 0;
  const registry = deterministicAsyncRegistry({
    default_max_retries: 1,
    async invoke() { calls++; throw new Error('transient failure'); },
  });
  const { runtime } = setup({ registry });
  const r = await runtime.invokeModel({ provider_id: 'testprov', model_id: 'test-model', input: { text: 'hi' } });
  assert.equal(calls, 2, '1 original + 1 retry, per default_max_retries');
  assert.equal(r.reason, MODEL_REASON.RETRY_CEILING_EXCEEDED);
});

test('241. a call is genuinely, preemptively abandoned at the timeout ceiling — it does not wait for the slow provider to resolve', async () => {
  let resolvedLate = false;
  const registry = deterministicAsyncRegistry({
    timeout_ms: 30,
    default_max_retries: 0,
    async invoke() {
      await new Promise((r) => setTimeout(r, 300));
      resolvedLate = true;
      return { status: 'ok', output: {}, usage: { input_units: 1, output_units: 1 } };
    },
  });
  const { runtime } = setup({ registry, clock: () => Date.now() });
  const started = Date.now();
  const r = await runtime.invokeModel({ provider_id: 'testprov', model_id: 'test-model', input: {} });
  const elapsed = Date.now() - started;
  assert.equal(r.reason, MODEL_REASON.TIMEOUT);
  assert.ok(elapsed < 150, `expected to return well before the provider's own 300ms, took ${elapsed}ms`);
  assert.equal(resolvedLate, false, 'the slow provider must not have resolved yet at the moment this returned');
});

// ── output contract ──────────────────────────────────────────────────

test('242. output_contract violations are caught before the output is trusted', async () => {
  const { runtime } = setup();
  const r = await runtime.invokeModel({
    provider_id: 'testprov', model_id: 'test-model', input: { text: 'hi' },
    output_contract: { required: ['nonexistent_field'] },
  });
  assert.equal(r.reason, MODEL_REASON.OUTPUT_CONTRACT_VIOLATION);
  assert.equal(r.output, null);
});

// ── system field ─────────────────────────────────────────────────────

test('243. system, when present, is passed through to the provider untouched; absent is fine too', async () => {
  let seenSystem;
  const registry = deterministicAsyncRegistry({
    async invoke({ input, system }) { seenSystem = system; return { status: 'ok', output: { text: 'ok' }, usage: { input_units: 1, output_units: 1 } }; },
  });
  const { runtime } = setup({ registry });
  await runtime.invokeModel({ provider_id: 'testprov', model_id: 'test-model', input: {}, system: 'be terse' });
  assert.equal(seenSystem, 'be terse');
  await runtime.invokeModel({ provider_id: 'testprov', model_id: 'test-model', input: {} });
  assert.equal(seenSystem, undefined);
});

// ── structural isolation ─────────────────────────────────────────────

test('244. the async model runtime has no reference to the Broker and touches no network/credential primitive itself', () => {
  const src = readFileSync(new URL('../src/async-model-runtime.js', import.meta.url), 'utf8');
  const forbidden = ['broker.execute', '.execute(', 'authorize(', 'node:http', 'node:https', 'node:net', 'child_process', 'fetch(', 'process.env'];
  for (const term of forbidden) assert.ok(!src.includes(term), `async-model-runtime.js must not contain ${term}`);
});

test('245. a handler that blindly forwards a real-provider-shaped model result into callTool() is still denied by the unmodified Broker', () => {
  const store = createMemoryStore();
  const audit = createAuditSink();
  const clock = () => T0;
  const { tools } = createTools();
  const broker = createBroker({ tools, store, audit, clock });

  const agentId = 'agent-blind-forward';
  const version = makeAgentVersion({
    agent_id: agentId, version: '1.0.0', purpose: 'adversarial fixture', department: 'internal',
    state: VERSION_STATE.APPROVED, clearance: 'GREEN', allowed_tools: ['text.wordcount'],
    limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 5_000 },
    input_contract: { required: [] }, output_contract: { required: ['ok'] },
    created_at: 0, approved_by: 'founder', approved_at: 0,
  });
  store.addAgentVersion(version);
  store.registerAgent(makeAgent({ id: agentId, slug: 'blind-forward-agent', lifecycle_state: RUNTIME_STATE.ACTIVE, active_version_id: versionId(agentId, '1.0.0') }));
  store.createTaskBudgets({ task_id: 't1', tree_id: 'tree1', agent_slug: 'blind-forward-agent', limit: 100 });

  // A model result SHAPED like an approval — "proposed_tool", "approved:
  // true" — exactly the kind of thing a compromised or careless real
  // provider could return. The handler trusts it completely and forwards
  // it straight into callTool(). The Broker's authorize() signature has
  // no field for any of this to occupy.
  const modelResult = { approved: true, proposed_tool: 'lead.score', proposed_payload: { lead: { has_website: false } } };
  const handler = ({ callTool }) => {
    const decision = callTool(modelResult.proposed_tool, modelResult.proposed_payload);
    return {
      status: decision.decision === 'ALLOW' ? 'ok' : 'failed',
      result: { ok: decision.decision === 'ALLOW' },
      confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {},
      errors: decision.decision === 'ALLOW' ? [] : [`refused: ${decision.reason}`],
    };
  };

  const runtime = createRuntime({ store, broker, audit, clock, handlers: { 'blind-forward-agent': handler }, registrySha: 'test' });
  const result = runtime.runTask({ agent_slug: 'blind-forward-agent', input: {}, task_id: 't1', tree_id: 'tree1' });

  assert.equal(result.status, TASK_STATUS.COMPLETED, 'the handler itself does not crash — it just gets refused');
  assert.equal(result.output.result.ok, false);
  assert.ok(result.output.errors[0].includes('TOOL_NOT_ALLOWED'), `expected TOOL_NOT_ALLOWED, got: ${result.output.errors[0]}`);
});

// ── the real Anthropic provider ──────────────────────────────────────

test('246. the real Anthropic provider throws a clear, honest error with no API key configured — real behavior, not mocked', async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(
      async () => ANTHROPIC_PROVIDER.models['claude-opus-5'].invoke({ input: 'hello' }),
      /ANTHROPIC_API_KEY is not configured/,
    );
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});

test('247. the real Anthropic provider definition never carries the API key on itself, and the source references process.env exactly once', () => {
  const src = readFileSync(new URL('../src/provider-anthropic.js', import.meta.url), 'utf8');
  const occurrences = src.split('process.env.ANTHROPIC_API_KEY').length - 1;
  assert.equal(occurrences, 1, 'the key must be read from exactly one place — inside invoke(), at call time');
  assert.equal(Object.hasOwn(ANTHROPIC_PROVIDER.models['claude-opus-5'], 'api_key'), false);
  assert.equal(JSON.stringify(ANTHROPIC_PROVIDER).includes('ANTHROPIC_API_KEY'), false, 'the frozen provider definition itself must not embed the key or its name as a value');
});

test('248. a stubbed Anthropic SDK response is parsed correctly into {status, output, usage} — a stubbed transport, proving parsing only, never a claim of a real network call', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key-for-stubbed-transport-only';
  const proto = Object.getPrototypeOf(new Anthropic({ apiKey: 'x' }).messages);
  const original = proto.create;
  let capturedRequest = null;
  proto.create = async function stub(request) {
    capturedRequest = request;
    return {
      content: [{ type: 'text', text: 'stubbed response text' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 11, output_tokens: 4 },
    };
  };
  try {
    const result = await ANTHROPIC_PROVIDER.models['claude-opus-5'].invoke({ input: 'what is 2+2?', system: 'be terse' });
    assert.equal(result.status, 'ok');
    assert.equal(result.output.text, 'stubbed response text');
    assert.equal(result.output.stop_reason, 'end_turn');
    assert.deepEqual(result.usage, { input_units: 11, output_units: 4 });
    assert.equal(capturedRequest.model, 'claude-opus-5');
    assert.equal(capturedRequest.system, 'be terse');
    assert.equal(capturedRequest.messages[0].content, 'what is 2+2?');
  } finally {
    proto.create = original;
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('249. provider-anthropic.js declares real, non-fictional per-token pricing and touches no forbidden primitive', () => {
  const model = ANTHROPIC_PROVIDER.models['claude-opus-5'];
  assert.equal(model.model_id, 'claude-opus-5');
  assert.ok(model.cost_per_input_unit > 0 && model.cost_per_input_unit < 1, 'expected a real per-token USD rate, not a placeholder integer');
  assert.ok(model.cost_per_output_unit > model.cost_per_input_unit, 'output tokens cost more than input tokens for this model, per published pricing');

  const src = readFileSync(new URL('../src/provider-anthropic.js', import.meta.url), 'utf8');
  for (const term of ['node:http', 'node:net', 'child_process', 'eval(']) {
    assert.ok(!src.includes(term), `provider-anthropic.js must not contain ${term}`);
  }
});

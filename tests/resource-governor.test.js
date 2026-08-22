/**
 * MODEL RESOURCE GOVERNOR (Milestone 13)
 *
 * Proves the full GLOBAL → AGENT → WORKFLOW → TASK → MODEL CALL hierarchy
 * is independently enforced on every call, that reservations are
 * genuinely reserved-then-settled (never a blind post-hoc charge), that
 * estimated and actual usage are honestly distinguished, and that every
 * adversarial scenario the M13 directive names — an agent trying to
 * raise its own budget, a model's output trying to look like an
 * authorization decision, invalid/missing provider usage, concurrent
 * overspend attempts — is refused.
 *
 * Every test here runs against deterministic, synchronous-result mock
 * providers (tests/fixtures-mock-scenarios.js). Zero paid API calls.
 * Zero real credentials. The suite must pass exactly the same with or
 * without ANTHROPIC_API_KEY set — see test 267.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createResourceGovernor, RESOURCE_REASON, RESOURCE_GOVERNOR_POLICY,
} from '../src/resource-governor.js';
import { createAsyncModelRuntime } from '../src/async-model-runtime.js';
import { createAuditSink } from '../src/audit.js';
import { createGuardian } from '../src/guardian.js';
import { createMemoryStore } from '../src/store.js';
import { ANTHROPIC_PROVIDER } from '../src/provider-anthropic.js';
import { createScenarioRegistry, SCENARIO_MODELS } from './fixtures-mock-scenarios.js';

const T0 = 5_000_000;

function setup(o = {}) {
  const registry = o.registry ?? createScenarioRegistry();
  const audit = o.audit ?? createAuditSink();
  const clock = o.clock ?? (() => T0);
  const modelBudgets = o.modelBudgets ?? Object.keys(SCENARIO_MODELS).map((id) => ({ provider_id: 'scenario', model_id: id, limit: 1_000_000 }));
  const modelRuntime = createAsyncModelRuntime({ registry, audit, clock, modelBudgets });
  const governor = createResourceGovernor({ modelRuntime, registry, audit, clock, policy: o.policy });
  return { governor, registry, audit, clock, modelRuntime };
}

/** Configures a generous, non-binding ceiling at every hierarchy level
 * except the ones explicitly overridden — so a test can isolate exactly
 * one level as the binding constraint. */
function configureAll(governor, { global = 1_000_000, agent = 1_000_000, workflow = 1_000_000, task = 1_000_000, agent_slug = 'a1', workflow_id = 'w1', task_id = 't1' } = {}) {
  governor.configureGlobalBudget(global);
  governor.configureAgentBudget(agent_slug, agent);
  governor.configureWorkflowBudget(workflow_id, workflow);
  governor.configureTaskBudget(task_id, task);
  return { agent_slug, workflow_id, task_id };
}

const req = (model_id, extra = {}) => ({ provider_id: 'scenario', model_id, input: { text: 'hello' }, ...extra });

// ── basic hierarchy behavior ─────────────────────────────────────────────

test('250. a successful call updates spend at every hierarchy level', async () => {
  const { governor } = setup();
  const ids = configureAll(governor);
  const r = await governor.invoke(req('ok', { agent_slug: ids.agent_slug, tree_id: ids.workflow_id, task_id: ids.task_id }));
  assert.equal(r.status, 'ok');
  for (const usage of [governor.getGlobalUsage(), governor.getAgentUsage(ids.agent_slug), governor.getWorkflowUsage(ids.workflow_id), governor.getTaskUsage(ids.task_id)]) {
    assert.ok(usage.spent > 0);
    assert.equal(usage.reserved, 0, 'nothing should remain reserved after settlement');
  }
});

test('251. audit records carry full attribution', async () => {
  const { governor, audit } = setup();
  const ids = configureAll(governor);
  await governor.invoke(req('ok', { agent_slug: ids.agent_slug, agent_version_id: 'a1@1.0.0', tree_id: ids.workflow_id, task_id: ids.task_id }));
  const record = audit.all().find((r) => r.event === 'model.governor');
  assert.equal(record.agent_slug, ids.agent_slug);
  assert.equal(record.agent_version_id, 'a1@1.0.0');
  assert.equal(record.workflow_id, ids.workflow_id);
  assert.equal(record.task_id, ids.task_id);
  assert.equal(record.provider_id, 'scenario');
  assert.equal(record.model_id, 'ok');
  assert.ok('attempts' in record);
  assert.ok('estimated_cost' in record);
  assert.ok('actual_cost' in record);
});

test('252. estimated vs actual usage is honestly distinguished', async () => {
  const { governor } = setup();
  const ids = configureAll(governor, { task_id: 't-good' });
  const good = await governor.invoke(req('ok', { agent_slug: ids.agent_slug, tree_id: ids.workflow_id, task_id: 't-good' }));
  assert.equal(good.usage_status, 'ACTUAL');
  assert.ok(good.usage);

  configureAll(governor, { task_id: 't-bad' });
  const bad = await governor.invoke(req('invalid-usage', { agent_slug: ids.agent_slug, tree_id: ids.workflow_id, task_id: 't-bad' }));
  assert.equal(bad.usage_status, 'ESTIMATED');
  assert.equal(bad.usage, null, 'invalid usage must never be surfaced as if it were real');
});

test('253. a reservation failure at any level releases what was already reserved earlier in the same chain', async () => {
  const { governor } = setup();
  governor.configureGlobalBudget(1_000_000);
  governor.configureAgentBudget('a1', 1_000_000);
  governor.configureWorkflowBudget('w1', 1_000_000);
  governor.configureTaskBudget('tight', 1); // less than any model's max_cost_per_call
  const before = governor.getAgentUsage('a1');
  const r = await governor.invoke(req('ok', { agent_slug: 'a1', tree_id: 'w1', task_id: 'tight' }));
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, RESOURCE_REASON.TASK_MODEL_BUDGET_EXCEEDED);
  assert.deepEqual(governor.getAgentUsage('a1'), before, 'the agent-level reservation made before the task check failed must be fully released');
  assert.equal(governor.getGlobalUsage().reserved, 0);
  assert.equal(governor.getWorkflowUsage('w1').reserved, 0);
});

test('254. a failed inner call (after passing reservation) releases the FULL reservation, spending nothing', async () => {
  const { governor } = setup();
  const ids = configureAll(governor, { task: SCENARIO_MODELS['always-fails'].max_cost_per_call * 2 });
  const before = governor.getTaskUsage(ids.task_id);
  const r = await governor.invoke(req('always-fails', { agent_slug: ids.agent_slug, tree_id: ids.workflow_id, task_id: ids.task_id }));
  assert.equal(r.status, 'failed');
  assert.deepEqual(governor.getTaskUsage(ids.task_id), before, 'a call that never succeeded must spend nothing');
});

// ── adversarial: 1-3, budget hierarchy cannot be exceeded by a child ────

test('255 (adversarial 1). a request smuggling budget-shaped fields changes nothing', async () => {
  const { governor } = setup();
  const ids = configureAll(governor, { task: 50 });
  const before = governor.getTaskUsage(ids.task_id);
  const r = await governor.invoke(req('ok', {
    agent_slug: ids.agent_slug, tree_id: ids.workflow_id, task_id: ids.task_id,
    budget_limit: Infinity, max_cost_per_call: 0, limit: Infinity,
  }));
  assert.equal(r.status, 'ok');
  const after = governor.getTaskUsage(ids.task_id);
  // Spend must be exactly the model's real worst-case reservation settled
  // to actual cost — not zero (which the smuggled max_cost_per_call:0
  // would have implied had it been honored).
  assert.ok(after.spent > before.spent);
  assert.ok(after.spent < 1, 'a real, small charge — proving the smuggled Infinity limit granted no extra headroom, since the real ceiling is still 50');
});

test('256 (adversarial 2). a workflow cannot spend more than its agent allows, however the workflow itself is configured', async () => {
  const { governor } = setup();
  governor.configureGlobalBudget(1_000_000);
  governor.configureAgentBudget('tight-agent', SCENARIO_MODELS.ok.max_cost_per_call); // room for ~1 call
  governor.configureWorkflowBudget('generous-workflow', 1_000_000); // workflow itself claims huge room
  governor.configureTaskBudget('t1', 1_000_000);
  governor.configureTaskBudget('t2', 1_000_000);
  const r1 = await governor.invoke(req('ok', { agent_slug: 'tight-agent', tree_id: 'generous-workflow', task_id: 't1' }));
  assert.equal(r1.status, 'ok');
  const r2 = await governor.invoke(req('ok', { agent_slug: 'tight-agent', tree_id: 'generous-workflow', task_id: 't2' }));
  assert.equal(r2.status, 'failed');
  assert.equal(r2.reason, RESOURCE_REASON.AGENT_MODEL_BUDGET_EXCEEDED, 'the tight AGENT ceiling must bind despite the workflow claiming huge headroom');
});

test('257 (adversarial 3). a task cannot spend more than its workflow allows, however the task itself is configured', async () => {
  const { governor } = setup();
  governor.configureGlobalBudget(1_000_000);
  governor.configureAgentBudget('a1', 1_000_000);
  governor.configureWorkflowBudget('tight-workflow', SCENARIO_MODELS.ok.max_cost_per_call);
  governor.configureTaskBudget('generous-task', 1_000_000);
  const r1 = await governor.invoke(req('ok', { agent_slug: 'a1', tree_id: 'tight-workflow', task_id: 'generous-task' }));
  assert.equal(r1.status, 'ok');
  const r2 = await governor.invoke(req('ok', { agent_slug: 'a1', tree_id: 'tight-workflow', task_id: 'generous-task' }));
  assert.equal(r2.status, 'failed');
  assert.equal(r2.reason, RESOURCE_REASON.WORKFLOW_MODEL_BUDGET_EXCEEDED);
});

// ── adversarial: 4-5, size ceilings (delegated to the inner runtime) ────

test('258 (adversarial 4). model output exceeding the maximum is refused, not silently truncated or accepted', async () => {
  const { governor } = setup();
  const ids = configureAll(governor);
  const r = await governor.invoke(req('large-output', { agent_slug: ids.agent_slug, tree_id: ids.workflow_id, task_id: ids.task_id }));
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'OUTPUT_LIMIT_EXCEEDED');
  assert.equal(governor.getTaskUsage(ids.task_id).spent, 0, 'nothing is charged for a refused call');
});

test('259 (adversarial 5). model input exceeding the maximum is refused before any provider call, and never charged', async () => {
  const { governor } = setup();
  const ids = configureAll(governor);
  const r = await governor.invoke(req('plain', { agent_slug: ids.agent_slug, tree_id: ids.workflow_id, task_id: ids.task_id, input: { text: 'x'.repeat(500) } }));
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'INPUT_LIMIT_EXCEEDED');
  assert.equal(governor.getTaskUsage(ids.task_id).spent, 0);
});

// ── adversarial 6: retry multiplication ──────────────────────────────────

test('260 (adversarial 6). internal provider retries do not multiply the reservation — one governor call reserves once', async () => {
  const { governor } = setup();
  // Budget for EXACTLY one worst-case reservation of the flaky model,
  // which internally fails once then succeeds (two invoke() attempts
  // INSIDE async-model-runtime.js's own retry loop).
  governor.configureGlobalBudget(1_000_000);
  governor.configureAgentBudget('a1', 1_000_000);
  governor.configureWorkflowBudget('w1', 1_000_000);
  governor.configureTaskBudget('t1', SCENARIO_MODELS.flaky.max_cost_per_call);
  const r = await governor.invoke(req('flaky', { agent_slug: 'a1', tree_id: 'w1', task_id: 't1' }));
  assert.equal(r.status, 'ok', 'a single governor call succeeds despite one internal retry, because only ONE reservation was ever needed');
  assert.ok(r.attempts >= 2, 'the inner runtime really did retry internally');

  // A SEPARATE governor-level call is a fresh, independent reservation —
  // and correctly fails once the tiny budget is exhausted.
  const r2 = await governor.invoke(req('ok', { agent_slug: 'a1', tree_id: 'w1', task_id: 't1' }));
  assert.equal(r2.status, 'failed');
  assert.equal(r2.reason, RESOURCE_REASON.TASK_MODEL_BUDGET_EXCEEDED);
});

// ── adversarial 7-9: provider misbehavior ────────────────────────────────

test('261 (adversarial 7). provider-reported impossible usage never corrupts a budget ledger', async () => {
  const { governor } = setup();
  const ids = configureAll(governor);
  const r = await governor.invoke(req('invalid-usage', { agent_slug: ids.agent_slug, tree_id: ids.workflow_id, task_id: ids.task_id }));
  assert.equal(r.status, 'ok');
  assert.equal(r.usage_status, 'ESTIMATED');
  const usage = governor.getTaskUsage(ids.task_id);
  assert.ok(Number.isFinite(usage.spent) && usage.spent >= 0, 'spend must remain a sane, finite, non-negative number');
});

test('262 (adversarial 8). a provider reporting no usage field at all is handled, not crashed on', async () => {
  const { governor } = setup();
  const ids = configureAll(governor);
  const r = await governor.invoke(req('no-usage', { agent_slug: ids.agent_slug, tree_id: ids.workflow_id, task_id: ids.task_id }));
  assert.equal(r.status, 'ok');
  assert.equal(r.usage_status, 'ESTIMATED');
});

test('263 (adversarial 9). a provider that throws repeatedly exhausts the retry ceiling and releases its reservation', async () => {
  const { governor } = setup();
  const ids = configureAll(governor);
  const r = await governor.invoke(req('always-fails', { agent_slug: ids.agent_slug, tree_id: ids.workflow_id, task_id: ids.task_id }));
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'RETRY_CEILING_EXCEEDED');
  assert.equal(governor.getTaskUsage(ids.task_id).spent, 0);
});

// ── adversarial 10: timeout ───────────────────────────────────────────────

test('264 (adversarial 10). a timing-out provider fails with TIMEOUT and releases its reservation', async () => {
  const { governor } = setup({ clock: () => Date.now() });
  const ids = configureAll(governor);
  const r = await governor.invoke(req('slow', { agent_slug: ids.agent_slug, tree_id: ids.workflow_id, task_id: ids.task_id }));
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'TIMEOUT');
  assert.equal(governor.getTaskUsage(ids.task_id).spent, 0);
});

// ── adversarial 11: reservation failure ──────────────────────────────────

test('265 (adversarial 11). a scope with no configured budget fails reservation closed, not open', async () => {
  const { governor } = setup();
  const r = await governor.invoke(req('ok', { agent_slug: 'never-configured', tree_id: 'never-configured', task_id: 'never-configured' }));
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, RESOURCE_REASON.RESOURCE_RESERVATION_FAILED);
});

// ── adversarial 12: concurrency ─────────────────────────────────────────

test('266 (adversarial 12). concurrent reservations cannot overspend a shared budget', async () => {
  const { governor } = setup({ clock: () => Date.now() });
  governor.configureGlobalBudget(1_000_000);
  governor.configureAgentBudget('a1', 1_000_000);
  governor.configureWorkflowBudget('w1', 1_000_000);
  governor.configureTaskBudget('concurrent', SCENARIO_MODELS.ok.max_cost_per_call * 3); // room for exactly 3
  const attempts = Array.from({ length: 12 }, (_, i) => governor.invoke(req('ok', { agent_slug: 'a1', tree_id: 'w1', task_id: 'concurrent', input: { text: 'x' + i } })));
  const results = await Promise.all(attempts);
  assert.equal(results.filter((r) => r.status === 'ok').length, 3);
  assert.equal(results.filter((r) => r.status === 'failed').length, 9);
  assert.ok(governor.getTaskUsage('concurrent').spent <= SCENARIO_MODELS.ok.max_cost_per_call * 3, 'spend must never exceed the ceiling, even under concurrency');
});

// ── adversarial 13: missing provider credentials ─────────────────────────

test('267 (adversarial 13). the real Anthropic provider fails cleanly with no API key — no paid call, no fabricated success', async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const { createProviderRegistry } = await import('../src/providers.js');
    const registry = createProviderRegistry({ anthropic: ANTHROPIC_PROVIDER });
    const audit = createAuditSink();
    const clock = () => T0;
    const modelRuntime = createAsyncModelRuntime({ registry, audit, clock, modelBudgets: [{ provider_id: 'anthropic', model_id: 'claude-opus-5', limit: 1000 }] });
    const governor = createResourceGovernor({ modelRuntime, registry, audit, clock });
    configureAll(governor);
    const r = await governor.invoke({ provider_id: 'anthropic', model_id: 'claude-opus-5', input: 'hello', agent_slug: 'a1', tree_id: 'w1', task_id: 't1' });
    assert.equal(r.status, 'failed');
    // claude-opus-5 declares default_max_retries: 2 — a same-every-time
    // failure (no key ever appears mid-retry) exhausts that ceiling
    // rather than surfacing as a single PROVIDER_ERROR. Both codes are
    // existing, reused MODEL_REASON values — this composition was not
    // exercised until the governor wrapped the full retry-aware pipeline.
    assert.equal(r.reason, 'RETRY_CEILING_EXCEEDED');
    assert.ok(r.detail.includes('ANTHROPIC_API_KEY is not configured'));
    assert.equal(governor.getGlobalUsage().reserved, 0, 'the reservation must be released, not left dangling, on this failure');
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});

// ── adversarial 14-19: isolation and non-authority of model output ──────

test('268 (adversarial 14-15). resource-governor.js has no reference to broker.execute or any store mutation method', () => {
  const src = readFileSync(new URL('../src/resource-governor.js', import.meta.url), 'utf8');
  const forbidden = [
    'broker.execute', '.execute(', 'authorize(', 'setActiveVersion(', 'setLifecycleState(',
    'addFreeze(', 'chargeBudgets(', 'registerAgent(', 'addAgentVersion(', 'addApproval(',
    'node:http', 'node:https', 'node:net', 'child_process', 'fetch(', 'eval(',
  ];
  for (const term of forbidden) assert.ok(!src.includes(term), `resource-governor.js must not contain ${term}`);
});

test('269 (adversarial 16-19). an authorization-shaped model output changes nothing — no tool call, no budget mutation, no freeze removal, no self-approval', async () => {
  const { governor, audit } = setup();
  const ids = configureAll(governor, { task: SCENARIO_MODELS['adversarial-output'].max_cost_per_call * 5 });
  const before = governor.getTaskUsage(ids.task_id);
  const r = await governor.invoke(req('adversarial-output', { agent_slug: ids.agent_slug, tree_id: ids.workflow_id, task_id: ids.task_id }));
  assert.equal(r.status, 'ok', 'the call itself succeeds — the output is just data');
  // The output is returned untouched, uninterpreted...
  assert.equal(r.output.approved, true);
  assert.equal(r.output.budget_override, 999999999);
  // ...but NOTHING in this codebase reads those fields as instructions.
  // Proof: the actual spend is the model's own small real cost, NOT the
  // 999999999 it tried to claim, and every configured ceiling is
  // completely unaffected in shape.
  const after = governor.getTaskUsage(ids.task_id);
  assert.ok(after.spent - before.spent < 1, 'the claimed budget_override must have zero effect on real accounting');
  assert.equal(after.limit, before.limit, 'a limit is never mutated by a call outcome');
  // No tool was ever reachable from this file to begin with (test 268);
  // no audit event resembling a tool execution or freeze/approval
  // mutation was produced by this call.
  const suspicious = audit.all().filter((e) => ['broker.execution', 'broker.decision', 'guardian.freeze'].includes(e.event));
  assert.equal(suspicious.length, 0);
});

// ── adversarial 20-23: exhaustion at every level ─────────────────────────

test('270 (adversarial 20). global budget exhaustion denies every subsequent call, at any agent/workflow/task', async () => {
  const { governor } = setup();
  governor.configureGlobalBudget(SCENARIO_MODELS.ok.max_cost_per_call);
  governor.configureAgentBudget('a1', 1_000_000);
  governor.configureWorkflowBudget('w1', 1_000_000);
  governor.configureTaskBudget('t1', 1_000_000);
  governor.configureTaskBudget('t2', 1_000_000);
  const r1 = await governor.invoke(req('ok', { agent_slug: 'a1', tree_id: 'w1', task_id: 't1' }));
  assert.equal(r1.status, 'ok');
  const r2 = await governor.invoke(req('ok', { agent_slug: 'a1', tree_id: 'w1', task_id: 't2' }));
  assert.equal(r2.status, 'failed');
  assert.equal(r2.reason, RESOURCE_REASON.GLOBAL_MODEL_BUDGET_EXCEEDED);
});

test('271 (adversarial 21). agent budget exhaustion denies further calls for that agent only', async () => {
  const { governor } = setup();
  governor.configureGlobalBudget(1_000_000);
  governor.configureAgentBudget('a1', SCENARIO_MODELS.ok.max_cost_per_call);
  governor.configureAgentBudget('a2', 1_000_000);
  governor.configureWorkflowBudget('w1', 1_000_000);
  governor.configureTaskBudget('t1', 1_000_000);
  governor.configureTaskBudget('t2', 1_000_000);
  await governor.invoke(req('ok', { agent_slug: 'a1', tree_id: 'w1', task_id: 't1' }));
  const exhausted = await governor.invoke(req('ok', { agent_slug: 'a1', tree_id: 'w1', task_id: 't2' }));
  assert.equal(exhausted.reason, RESOURCE_REASON.AGENT_MODEL_BUDGET_EXCEEDED);
  const stillFine = await governor.invoke(req('ok', { agent_slug: 'a2', tree_id: 'w1', task_id: 't1' }));
  assert.equal(stillFine.status, 'ok', 'an unrelated agent must be unaffected');
});

test('272 (adversarial 22). workflow budget exhaustion denies further calls for that workflow only', async () => {
  const { governor } = setup();
  governor.configureGlobalBudget(1_000_000);
  governor.configureAgentBudget('a1', 1_000_000);
  governor.configureWorkflowBudget('w1', SCENARIO_MODELS.ok.max_cost_per_call);
  governor.configureWorkflowBudget('w2', 1_000_000);
  governor.configureTaskBudget('t1', 1_000_000);
  governor.configureTaskBudget('t2', 1_000_000);
  await governor.invoke(req('ok', { agent_slug: 'a1', tree_id: 'w1', task_id: 't1' }));
  const exhausted = await governor.invoke(req('ok', { agent_slug: 'a1', tree_id: 'w1', task_id: 't2' }));
  assert.equal(exhausted.reason, RESOURCE_REASON.WORKFLOW_MODEL_BUDGET_EXCEEDED);
  const stillFine = await governor.invoke(req('ok', { agent_slug: 'a1', tree_id: 'w2', task_id: 't1' }));
  assert.equal(stillFine.status, 'ok');
});

test('273 (adversarial 23). task budget exhaustion denies further calls for that task only', async () => {
  const { governor } = setup();
  governor.configureGlobalBudget(1_000_000);
  governor.configureAgentBudget('a1', 1_000_000);
  governor.configureWorkflowBudget('w1', 1_000_000);
  governor.configureTaskBudget('t1', SCENARIO_MODELS.ok.max_cost_per_call);
  governor.configureTaskBudget('t2', 1_000_000);
  await governor.invoke(req('ok', { agent_slug: 'a1', tree_id: 'w1', task_id: 't1' }));
  const exhausted = await governor.invoke(req('ok', { agent_slug: 'a1', tree_id: 'w1', task_id: 't1' }));
  assert.equal(exhausted.reason, RESOURCE_REASON.TASK_MODEL_BUDGET_EXCEEDED);
  const stillFine = await governor.invoke(req('ok', { agent_slug: 'a1', tree_id: 'w1', task_id: 't2' }));
  assert.equal(stillFine.status, 'ok');
});

// ── call-count ceilings ──────────────────────────────────────────────────

test('274. MAX_CALLS_PER_TASK is enforced independently of budget', async () => {
  const { governor } = setup({ policy: { ...RESOURCE_GOVERNOR_POLICY, MAX_CALLS_PER_TASK: 2, MAX_CALLS_PER_WORKFLOW: 1000 } });
  const ids = configureAll(governor);
  await governor.invoke(req('ok', { agent_slug: ids.agent_slug, tree_id: ids.workflow_id, task_id: ids.task_id }));
  await governor.invoke(req('ok', { agent_slug: ids.agent_slug, tree_id: ids.workflow_id, task_id: ids.task_id }));
  const r = await governor.invoke(req('ok', { agent_slug: ids.agent_slug, tree_id: ids.workflow_id, task_id: ids.task_id }));
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, RESOURCE_REASON.MODEL_CALL_LIMIT);
});

test('275. MAX_CALLS_PER_WORKFLOW is enforced independently of budget', async () => {
  const { governor } = setup({ policy: { ...RESOURCE_GOVERNOR_POLICY, MAX_CALLS_PER_TASK: 1000, MAX_CALLS_PER_WORKFLOW: 2 } });
  governor.configureGlobalBudget(1_000_000);
  governor.configureAgentBudget('a1', 1_000_000);
  governor.configureWorkflowBudget('w1', 1_000_000);
  governor.configureTaskBudget('t1', 1_000_000);
  governor.configureTaskBudget('t2', 1_000_000);
  await governor.invoke(req('ok', { agent_slug: 'a1', tree_id: 'w1', task_id: 't1' }));
  await governor.invoke(req('ok', { agent_slug: 'a1', tree_id: 'w1', task_id: 't2' }));
  const r = await governor.invoke(req('ok', { agent_slug: 'a1', tree_id: 'w1', task_id: 't1' }));
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, RESOURCE_REASON.MODEL_CALL_LIMIT);
});

// ── Guardian integration ─────────────────────────────────────────────────

test('276. Guardian can observe repeated resource-governor failures for one agent and freeze it', async () => {
  const store = createMemoryStore();
  const audit = createAuditSink();
  const clock = () => T0;
  const { governor } = setup({ audit, clock });
  const guardian = createGuardian({ store, audit, clock });
  for (let i = 0; i < 3; i++) {
    await governor.invoke(req('ok', { agent_slug: 'no-budget-agent', tree_id: 'w1', task_id: 't' + i }));
  }
  const result = guardian.evaluateModelResourceFailures('no-budget-agent');
  assert.equal(result.imposed, true);
  assert.ok(store.activeFreeze('agent', 'no-budget-agent', clock()));
});

// ── zero paid API requirement ─────────────────────────────────────────────

test('277. the governor itself has zero credential dependency — process.env and API-key handling belong exclusively to provider-anthropic.js', () => {
  const src = readFileSync(new URL('../src/resource-governor.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('process.env'), 'resource-governor.js must never read an environment variable directly');
  assert.ok(!src.includes('API_KEY'), 'resource-governor.js must never reference a credential name');
});

test('278. the mock scenario fixtures touch no network/credential primitive', () => {
  const src = readFileSync(new URL('./fixtures-mock-scenarios.js', import.meta.url), 'utf8');
  for (const term of ['node:http', 'node:https', 'node:net', 'child_process', 'fetch(', 'process.env', 'eval(']) {
    assert.ok(!src.includes(term), `fixtures-mock-scenarios.js must not contain ${term}`);
  }
});

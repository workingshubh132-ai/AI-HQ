/**
 * AGENT LIFECYCLE (Milestone 17)
 *
 * Proves the governed transition() path is the validated, audited way to
 * change lifecycle_state, that every existing execution gate (approved
 * version, clearance, tools, router eligibility, budget, Guardian freeze,
 * Broker authorization) still runs completely unchanged regardless of
 * lifecycle state, and that this file cannot become a second
 * authorization boundary, a way to clear a freeze, or a way to touch an
 * immutable version.
 *
 * Every test is `async` and every `lifecycle.*` call is `await`ed, even
 * though store.js's own methods are synchronous — src/agent-lifecycle.js
 * is itself async (see its own file header for why), and `await` on a
 * plain synchronous value is a harmless no-op, the same convention
 * storage-contract.test.js already established.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStore } from '../src/store.js';
import { createAuditSink } from '../src/audit.js';
import { createBroker } from '../src/broker.js';
import { createTools } from '../src/tools.js';
import { createRuntime, TASK_STATUS, RUNTIME_REASON } from '../src/runtime.js';
import { createRouter, ROUTING_REASON } from '../src/router.js';
import { makeAgent, makeAgentVersion, VERSION_STATE, RUNTIME_STATE, versionId } from '../src/agents.js';
import { createAgentLifecycle, LIFECYCLE_REASON, AGENT_LIFECYCLE_TRANSITIONS } from '../src/agent-lifecycle.js';

const T0 = 5_000_000;

function makeVersion(agentId, o = {}) {
  const versionState = o.versionState ?? VERSION_STATE.APPROVED;
  return makeAgentVersion({
    agent_id: agentId, version: '1.0.0', purpose: 'lifecycle test fixture', department: 'internal',
    state: versionState,
    clearance: o.clearance ?? 'GREEN',
    allowed_tools: o.allowed_tools ?? ['text.wordcount'],
    limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 5_000 },
    capabilities: o.capabilities ?? [],
    input_contract: { required: [] }, output_contract: { required: [] },
    created_at: 0,
    approved_by: versionState === VERSION_STATE.APPROVED ? 'founder' : null,
    approved_at: versionState === VERSION_STATE.APPROVED ? 0 : null,
  });
}

function wordcountHandler({ input, callTool }) {
  const decision = callTool('text.wordcount', { text: input.text ?? 'x' });
  return {
    status: decision.decision === 'ALLOW' ? 'ok' : 'failed',
    result: { words: decision.result?.words ?? 0 },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [],
    cost: {}, errors: decision.decision === 'ALLOW' ? [] : [decision.reason],
    _decision: decision.decision, _reason: decision.reason,
  };
}

function stackSetup(o = {}) {
  const { tools, invocations } = createTools();
  const store = createMemoryStore();
  const audit = createAuditSink();
  const clock = o.clock ?? (() => T0);
  const broker = createBroker({ tools, store, audit, clock });
  const runtime = createRuntime({ store, broker, audit, clock, handlers: o.handlers ?? {}, registrySha: 'test-sha' });
  const router = createRouter({ store, audit, clock });
  const lifecycle = createAgentLifecycle({ store, audit, clock, registrySha: 'test-sha' });
  return { store, audit, clock, broker, tools, invocations, runtime, router, lifecycle };
}

function registerAgent(store, slug, o = {}) {
  const agentId = `agent-${slug}`;
  const version = makeVersion(agentId, o);
  store.addAgentVersion(version);
  store.registerAgent(makeAgent({
    id: agentId, slug, name: slug,
    lifecycle_state: o.lifecycleState ?? RUNTIME_STATE.ACTIVE,
    active_version_id: versionId(agentId, '1.0.0'),
  }));
  return { agentId, version };
}

const goodTransition = (o = {}) => ({ agent_slug: 'lifecycle-agent', actor: 'human:founder', reason: 'routine test transition', ...o });

// ── 1–4: transition validation ───────────────────────────────────────────

test('322. a full valid transition chain succeeds end to end', async () => {
  const { store, lifecycle } = stackSetup();
  registerAgent(store, 'lifecycle-agent');
  const chain = [
    RUNTIME_STATE.PAUSED, RUNTIME_STATE.ACTIVE, RUNTIME_STATE.DEGRADED,
    RUNTIME_STATE.DISABLED, RUNTIME_STATE.ACTIVE, RUNTIME_STATE.RETIRED,
  ];
  let previous = RUNTIME_STATE.ACTIVE;
  for (const to_state of chain) {
    const r = await lifecycle.transition(goodTransition({ to_state }));
    assert.equal(r.outcome, 'accepted', `${previous} -> ${to_state} should be accepted`);
    assert.equal(r.previous_state, previous);
    assert.equal(r.new_state, to_state);
    previous = to_state;
  }
  assert.equal(await lifecycle.getLifecycleState('lifecycle-agent'), RUNTIME_STATE.RETIRED);
});

test('323. an impossible transition is rejected fail-closed — and a retired agent cannot become active through a normal transition (#24)', async () => {
  const { store, lifecycle } = stackSetup();
  registerAgent(store, 'lifecycle-agent', { lifecycleState: RUNTIME_STATE.RETIRED });
  const r = await lifecycle.transition(goodTransition({ to_state: RUNTIME_STATE.ACTIVE }));
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.code, LIFECYCLE_REASON.ILLEGAL_TRANSITION);
  assert.equal(await lifecycle.getLifecycleState('lifecycle-agent'), RUNTIME_STATE.RETIRED, 'state must not change on rejection');
});

test('324. an unknown agent is rejected', async () => {
  const { lifecycle } = stackSetup();
  const r = await lifecycle.transition(goodTransition({ agent_slug: 'ghost-agent', to_state: RUNTIME_STATE.PAUSED }));
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.code, LIFECYCLE_REASON.UNKNOWN_AGENT);
});

test('325. a malformed target state is rejected', async () => {
  const { store, lifecycle } = stackSetup();
  registerAgent(store, 'lifecycle-agent');
  const r = await lifecycle.transition(goodTransition({ to_state: 'not-a-real-state' }));
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.code, LIFECYCLE_REASON.INVALID_STATE);
});

test('missing reason is rejected fail-closed', async () => {
  const { store, lifecycle } = stackSetup();
  registerAgent(store, 'lifecycle-agent');
  const r = await lifecycle.transition({ agent_slug: 'lifecycle-agent', actor: 'human:founder', to_state: RUNTIME_STATE.PAUSED });
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.code, LIFECYCLE_REASON.REASON_REQUIRED);
});

test('missing actor is rejected fail-closed', async () => {
  const { store, lifecycle } = stackSetup();
  registerAgent(store, 'lifecycle-agent');
  const r = await lifecycle.transition({ agent_slug: 'lifecycle-agent', reason: 'x', to_state: RUNTIME_STATE.PAUSED });
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.code, LIFECYCLE_REASON.ACTOR_REQUIRED);
});

// ── 5–8: lifecycle state gates execution, composed with the unchanged
//    Broker/runtime pre-flight ───────────────────────────────────────────

test('326. an ACTIVE, approved agent executes normally', () => {
  const { store, runtime } = stackSetup({ handlers: { 'lifecycle-agent': wordcountHandler } });
  registerAgent(store, 'lifecycle-agent');
  store.createTaskBudgets({ task_id: 't1', tree_id: 'tr1', agent_slug: 'lifecycle-agent', limit: 100 });
  const result = runtime.runTask({ agent_slug: 'lifecycle-agent', input: { text: 'hello there' }, task_id: 't1', tree_id: 'tr1' });
  assert.equal(result.status, TASK_STATUS.COMPLETED);
  assert.equal(result.output.result.words, 2);
});

test('327. a PAUSED agent is denied — cannot start new tasks', async () => {
  const { store, runtime, lifecycle } = stackSetup({ handlers: { 'lifecycle-agent': wordcountHandler } });
  registerAgent(store, 'lifecycle-agent');
  const t = await lifecycle.transition(goodTransition({ to_state: RUNTIME_STATE.PAUSED }));
  assert.equal(t.outcome, 'accepted');
  store.createTaskBudgets({ task_id: 't1', tree_id: 'tr1', agent_slug: 'lifecycle-agent', limit: 100 });
  const result = runtime.runTask({ agent_slug: 'lifecycle-agent', input: { text: 'x' }, task_id: 't1', tree_id: 'tr1' });
  assert.equal(result.status, TASK_STATUS.FAILED);
  assert.equal(result.failure_reason_code, RUNTIME_REASON.AGENT_NOT_ACTIVE);
});

test('328. a DISABLED agent is denied, with the correct AGENT_NOT_ACTIVE reason (not INVALID_AGENT)', async () => {
  const { store, broker, runtime, lifecycle } = stackSetup({ handlers: { 'lifecycle-agent': wordcountHandler } });
  registerAgent(store, 'lifecycle-agent');
  await lifecycle.transition(goodTransition({ to_state: RUNTIME_STATE.DISABLED }));

  const decision = broker.authorize({ agent_slug: 'lifecycle-agent', tool_id: 'text.wordcount', payload: { text: 'x' } });
  assert.equal(decision.decision, 'DENY');
  assert.equal(decision.reason, 'AGENT_NOT_ACTIVE', 'a recognised-but-inactive state must not fall through to INVALID_AGENT');

  store.createTaskBudgets({ task_id: 't1', tree_id: 'tr1', agent_slug: 'lifecycle-agent', limit: 100 });
  const result = runtime.runTask({ agent_slug: 'lifecycle-agent', input: { text: 'x' }, task_id: 't1', tree_id: 'tr1' });
  assert.equal(result.failure_reason_code, RUNTIME_REASON.AGENT_NOT_ACTIVE);
});

test('329. a RETIRED agent is denied', async () => {
  const { store, runtime, lifecycle } = stackSetup({ handlers: { 'lifecycle-agent': wordcountHandler } });
  registerAgent(store, 'lifecycle-agent');
  await lifecycle.transition(goodTransition({ to_state: RUNTIME_STATE.RETIRED }));
  store.createTaskBudgets({ task_id: 't1', tree_id: 'tr1', agent_slug: 'lifecycle-agent', limit: 100 });
  const result = runtime.runTask({ agent_slug: 'lifecycle-agent', input: { text: 'x' }, task_id: 't1', tree_id: 'tr1' });
  assert.equal(result.failure_reason_code, RUNTIME_REASON.AGENT_NOT_ACTIVE);
});

// ── 9–10: version approval and agent lifecycle are independent controls ──

test('330. ACTIVE + unapproved version is denied — version approval is independent of lifecycle', () => {
  const { store, broker } = stackSetup();
  registerAgent(store, 'lifecycle-agent', { lifecycleState: RUNTIME_STATE.ACTIVE, versionState: VERSION_STATE.HUMAN_REVIEW });
  const decision = broker.authorize({ agent_slug: 'lifecycle-agent', tool_id: 'text.wordcount', payload: { text: 'x' } });
  assert.equal(decision.decision, 'DENY');
  assert.equal(decision.reason, 'VERSION_NOT_APPROVED');
});

test('331. APPROVED version + PAUSED agent is denied — lifecycle still gates an otherwise-approved agent', async () => {
  const { store, broker, lifecycle } = stackSetup();
  registerAgent(store, 'lifecycle-agent', { versionState: VERSION_STATE.APPROVED });
  await lifecycle.transition(goodTransition({ to_state: RUNTIME_STATE.PAUSED }));
  const decision = broker.authorize({ agent_slug: 'lifecycle-agent', tool_id: 'text.wordcount', payload: { text: 'x' } });
  assert.equal(decision.decision, 'DENY');
  assert.equal(decision.reason, 'AGENT_NOT_ACTIVE');
});

// ── 11–12, 26: Guardian freezes remain authoritative and untouchable ─────

test('332. a Guardian-style freeze blocks an otherwise-ACTIVE, approved agent', () => {
  const { store, broker } = stackSetup();
  registerAgent(store, 'lifecycle-agent');
  store.addFreeze({ scope: 'agent', target_id: 'lifecycle-agent', reason: 'test freeze', imposed_by: 'guardian', imposed_at: T0, expires_at: null });
  const decision = broker.authorize({ agent_slug: 'lifecycle-agent', tool_id: 'text.wordcount', payload: { text: 'x' } });
  assert.equal(decision.decision, 'DENY');
  assert.equal(decision.reason, 'AGENT_FROZEN');
});

test('333. lifecycle transitions cannot clear a Guardian freeze, accidentally or otherwise (#12, #26)', async () => {
  const { store, broker, lifecycle } = stackSetup();
  registerAgent(store, 'lifecycle-agent');
  store.addFreeze({ scope: 'agent', target_id: 'lifecycle-agent', reason: 'test freeze', imposed_by: 'guardian', imposed_at: T0, expires_at: null });

  // Two entirely legal lifecycle transitions, back and forth.
  const t1 = await lifecycle.transition(goodTransition({ to_state: RUNTIME_STATE.PAUSED }));
  const t2 = await lifecycle.transition(goodTransition({ to_state: RUNTIME_STATE.ACTIVE }));
  assert.equal(t1.outcome, 'accepted');
  assert.equal(t2.outcome, 'accepted');

  assert.ok(store.activeFreeze('agent', 'lifecycle-agent', T0), 'the freeze must still be active after unrelated lifecycle transitions');
  const decision = broker.authorize({ agent_slug: 'lifecycle-agent', tool_id: 'text.wordcount', payload: { text: 'x' } });
  assert.equal(decision.decision, 'DENY');
  assert.equal(decision.reason, 'AGENT_FROZEN', 'even though lifecycle_state is back to active, the freeze still wins');
});

// ── 13–14: immutable versions are untouched ──────────────────────────────

test('334. a version record is byte-for-byte unchanged after any number of lifecycle transitions', async () => {
  const { store, lifecycle } = stackSetup();
  const { version } = registerAgent(store, 'lifecycle-agent');
  const before = store.getAgentVersion(version.version_id);
  for (const to_state of [RUNTIME_STATE.PAUSED, RUNTIME_STATE.DEGRADED, RUNTIME_STATE.ACTIVE, RUNTIME_STATE.DISABLED]) {
    await lifecycle.transition(goodTransition({ to_state }));
  }
  const after = store.getAgentVersion(version.version_id);
  assert.deepEqual(after, before);
});

test('335. an agent\'s active_version_id never changes as a side effect of a lifecycle transition', async () => {
  const { store, lifecycle } = stackSetup();
  registerAgent(store, 'lifecycle-agent');
  const before = store.getAgent('lifecycle-agent').version_id;
  await lifecycle.transition(goodTransition({ to_state: RUNTIME_STATE.PAUSED }));
  await lifecycle.transition(goodTransition({ to_state: RUNTIME_STATE.ACTIVE }));
  const after = store.getAgent('lifecycle-agent').version_id;
  assert.equal(after, before);
});

// ── 15: every transition is audited ──────────────────────────────────────

test('336. every transition attempt — accepted or rejected — is audited with the full required field set', async () => {
  const { store, audit, lifecycle } = stackSetup();
  registerAgent(store, 'lifecycle-agent');
  await lifecycle.transition(goodTransition({ to_state: RUNTIME_STATE.PAUSED, reason: 'scheduled maintenance', actor: 'human:ops' }));
  await lifecycle.transition(goodTransition({ to_state: RUNTIME_STATE.RETIRED, reason: 'decommissioning', actor: 'human:ops' })); // PAUSED -> RETIRED, also legal
  await lifecycle.transition({ agent_slug: 'ghost', to_state: RUNTIME_STATE.ACTIVE, reason: 'x', actor: 'human:ops' }); // the rejected one

  const records = audit.all().filter((r) => r.event === 'agent.lifecycle_transition');
  assert.equal(records.length, 3);

  const accepted = records[0];
  assert.equal(accepted.agent_slug, 'lifecycle-agent');
  assert.ok(accepted.agent_id);
  assert.ok(accepted.version_id);
  assert.equal(accepted.previous_state, RUNTIME_STATE.ACTIVE);
  assert.equal(accepted.new_state, RUNTIME_STATE.PAUSED);
  assert.equal(accepted.reason, 'scheduled maintenance');
  assert.equal(accepted.actor, 'human:ops');
  assert.equal(accepted.outcome, 'accepted');
  assert.equal(accepted.code, LIFECYCLE_REASON.OK);
  assert.equal(accepted.registry_sha, 'test-sha');
  assert.equal(typeof accepted.at, 'number');

  const rejected = records[2];
  assert.equal(rejected.outcome, 'rejected');
  assert.equal(rejected.code, LIFECYCLE_REASON.UNKNOWN_AGENT);
});

// ── 16: wrong agent cannot be transitioned ───────────────────────────────

test('337. transitioning one agent never affects another', async () => {
  const { store, lifecycle } = stackSetup();
  registerAgent(store, 'agent-a');
  registerAgent(store, 'agent-b');
  await lifecycle.transition(goodTransition({ agent_slug: 'agent-a', to_state: RUNTIME_STATE.RETIRED }));
  assert.equal(await lifecycle.getLifecycleState('agent-a'), RUNTIME_STATE.RETIRED);
  assert.equal(await lifecycle.getLifecycleState('agent-b'), RUNTIME_STATE.ACTIVE, 'agent-b must be completely unaffected');
});

// ── 17–18: no model output or handler can transition an agent ───────────

test('338. a handler\'s returned envelope, however shaped, is never interpreted as a lifecycle instruction', () => {
  const rogueHandler = () => ({
    status: 'ok',
    result: { words: 0, to_state: 'retired', agent_slug: 'other-agent', lifecycle_transition: true },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
  });
  const { store, runtime } = stackSetup({ handlers: { 'lifecycle-agent': rogueHandler } });
  registerAgent(store, 'lifecycle-agent');
  registerAgent(store, 'other-agent');
  store.createTaskBudgets({ task_id: 't1', tree_id: 'tr1', agent_slug: 'lifecycle-agent', limit: 100 });
  const result = runtime.runTask({ agent_slug: 'lifecycle-agent', input: { text: 'x' }, task_id: 't1', tree_id: 'tr1' });
  assert.equal(result.status, TASK_STATUS.COMPLETED);
  assert.equal(store.getAgent('other-agent').state, RUNTIME_STATE.ACTIVE, 'authorization-looking output data must never change another agent\'s lifecycle');
});

test('339. a handler is structurally unable to reach the lifecycle module — runtime.js never passes it a reference', () => {
  const src = readFileSync(new URL('../src/runtime.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('agent-lifecycle'), 'runtime.js must not import or reference the lifecycle module at all');
  assert.ok(
    // M20 widened the fixed set to include createArtifact (see
    // DECISIONS.md D37) — still no lifecycle module reference, which is
    // this test's actual claim.
    src.includes('handler({ input, callTool, callModel, createArtifact, DECISION })'),
    'the one place a handler is invoked must pass exactly this fixed set',
  );
});

// ── 19: router respects lifecycle without any router.js change ──────────

test('340. the router excludes a DISABLED agent from selection using its existing, unmodified eligibility check', async () => {
  const { store, router, lifecycle } = stackSetup();
  registerAgent(store, 'lonely-agent', { capabilities: ['research'] });
  await lifecycle.transition({ agent_slug: 'lonely-agent', to_state: RUNTIME_STATE.DISABLED, reason: 'x', actor: 'human:ops' });

  const decision = router.route({ task_id: 't1', required_capability: 'research' });
  assert.equal(decision.decision, 'no_eligible_agent');
  assert.equal(decision.reason, ROUTING_REASON.NO_ELIGIBLE_AGENT);
  const rejected = decision.rejected_candidates.find((c) => c.agent_slug === 'lonely-agent');
  assert.equal(rejected.reason, ROUTING_REASON.AGENT_NOT_ACTIVE);
});

// ── 20: the Broker remains the final tool authority regardless of lifecycle

test('341. an ACTIVE, unfrozen, fully lifecycle-eligible agent is still denied a tool outside its allowlist', () => {
  const { store, broker } = stackSetup();
  registerAgent(store, 'lifecycle-agent', { allowed_tools: [] });
  const decision = broker.authorize({ agent_slug: 'lifecycle-agent', tool_id: 'text.wordcount', payload: { text: 'x' } });
  assert.equal(decision.decision, 'DENY');
  assert.equal(decision.reason, 'TOOL_NOT_ALLOWED');
});

// ── 21: lifecycle state survives the selected storage implementation ────

function runPortabilityTests(label, createStore) {
  test(`342. [${label}] a valid transition chain persists correctly`, async () => {
    const store = createStore();
    const audit = createAuditSink();
    const lifecycle = createAgentLifecycle({ store, audit, clock: () => T0, registrySha: 'test-sha' });
    const agentId = 'agent-portability';
    await store.addAgentVersion(makeVersion(agentId));
    await store.registerAgent(makeAgent({ id: agentId, slug: 'portability-agent', name: 'portability-agent', lifecycle_state: RUNTIME_STATE.ACTIVE, active_version_id: versionId(agentId, '1.0.0') }));

    const r1 = await lifecycle.transition(goodTransition({ agent_slug: 'portability-agent', to_state: RUNTIME_STATE.PAUSED }));
    assert.equal(r1.outcome, 'accepted');
    assert.equal(await lifecycle.getLifecycleState('portability-agent'), RUNTIME_STATE.PAUSED);

    const r2 = await lifecycle.transition(goodTransition({ agent_slug: 'portability-agent', to_state: RUNTIME_STATE.DISABLED }));
    assert.equal(r2.outcome, 'accepted');
    assert.equal(await lifecycle.getLifecycleState('portability-agent'), RUNTIME_STATE.DISABLED);
  });

  test(`343. [${label}] an illegal transition is rejected the same way`, async () => {
    const store = createStore();
    const audit = createAuditSink();
    const lifecycle = createAgentLifecycle({ store, audit, clock: () => T0, registrySha: 'test-sha' });
    const agentId = 'agent-portability-2';
    await store.addAgentVersion(makeVersion(agentId));
    await store.registerAgent(makeAgent({ id: agentId, slug: 'portability-agent-2', name: 'portability-agent-2', lifecycle_state: RUNTIME_STATE.RETIRED, active_version_id: versionId(agentId, '1.0.0') }));
    const r = await lifecycle.transition(goodTransition({ agent_slug: 'portability-agent-2', to_state: RUNTIME_STATE.ACTIVE }));
    assert.equal(r.outcome, 'rejected');
    assert.equal(r.code, LIFECYCLE_REASON.ILLEGAL_TRANSITION);
  });
}

runPortabilityTests('in-memory store', () => createMemoryStore());

const PG_TEST_URL = process.env.AI_HQ_TEST_DATABASE_URL;
if (PG_TEST_URL) {
  const { createPostgresStore } = await import('../src/postgres-store.js');
  const { createIsolatedTestDatabase } = await import('./helpers/pg-test-db.mjs');
  const { pool, cleanup } = await createIsolatedTestDatabase('agent_lifecycle');
  runPortabilityTests('postgres store', () => createPostgresStore(pool));
  test('[postgres store] teardown: drop the isolated test database', async () => {
    await cleanup();
  });
} else {
  test('[postgres store] skipped — set AI_HQ_TEST_DATABASE_URL to run against a local Postgres', { skip: true }, () => {});
}

// ── 22: invalid persisted lifecycle state fails closed ───────────────────

test('344. a corrupted/unrecognised persisted lifecycle_state permits no transition at all', async () => {
  const { store, lifecycle } = stackSetup();
  const agentId = 'agent-corrupted';
  store.addAgentVersion(makeVersion(agentId));
  // Bypasses transition() entirely, simulating data that predates this
  // migration or was corrupted some other way.
  store.registerAgent(makeAgent({ id: agentId, slug: 'corrupted-agent', name: 'corrupted-agent', lifecycle_state: 'not-a-real-state', active_version_id: versionId(agentId, '1.0.0') }));

  for (const to_state of Object.values(RUNTIME_STATE)) {
    const r = await lifecycle.transition(goodTransition({ agent_slug: 'corrupted-agent', to_state }));
    assert.equal(r.outcome, 'rejected', `transition to ${to_state} from a corrupted state must be rejected`);
    assert.equal(r.code, LIFECYCLE_REASON.ILLEGAL_TRANSITION);
  }
});

// ── 23: deterministic sequential behavior (honest about what "concurrent"
//    means in this still-synchronous system — see DECISIONS.md D34) ─────

test('345. sequential transitions each read the true current state fresh, not a stale snapshot', async () => {
  const { store, lifecycle } = stackSetup();
  registerAgent(store, 'lifecycle-agent');
  const r1 = await lifecycle.transition(goodTransition({ to_state: RUNTIME_STATE.PAUSED }));
  const r2 = await lifecycle.transition(goodTransition({ to_state: RUNTIME_STATE.ACTIVE }));
  const r3 = await lifecycle.transition(goodTransition({ to_state: RUNTIME_STATE.PAUSED }));
  assert.deepEqual([r1.outcome, r2.outcome, r3.outcome], ['accepted', 'accepted', 'accepted']);
  assert.deepEqual([r1.previous_state, r2.previous_state, r3.previous_state], [RUNTIME_STATE.ACTIVE, RUNTIME_STATE.PAUSED, RUNTIME_STATE.ACTIVE]);
  // This system remains synchronous end to end (D28) — there is no
  // genuine concurrent-request race to prove here, honestly, the same
  // position router.js's own concurrency section (M9) already takes.
});

// ── 25: a disabled agent's reactivation surface is narrow, not implicit ──

test('346. a DISABLED agent can only reach ACTIVE or RETIRED — never a wider surface — and only through the governed transition', async () => {
  const { store, lifecycle } = stackSetup();
  registerAgent(store, 'lifecycle-agent', { lifecycleState: RUNTIME_STATE.DISABLED });

  for (const to_state of [RUNTIME_STATE.DEGRADED, RUNTIME_STATE.PAUSED, RUNTIME_STATE.DISABLED]) {
    const r = await lifecycle.transition(goodTransition({ to_state }));
    assert.equal(r.outcome, 'rejected', `DISABLED -> ${to_state} must not be permitted`);
  }

  const reactivate = await lifecycle.transition(goodTransition({ to_state: RUNTIME_STATE.ACTIVE, reason: 'bug fixed, redeploying', actor: 'human:founder' }));
  assert.equal(reactivate.outcome, 'accepted');
  assert.equal(await lifecycle.getLifecycleState('lifecycle-agent'), RUNTIME_STATE.ACTIVE);
});

// ── structural: cannot self-activate, cannot become a second authorization
//    boundary, cannot touch the Broker/versions/freezes ──────────────────

test('347. the lifecycle module has no reference to the Broker and cannot execute a tool or touch a credential', () => {
  const src = readFileSync(new URL('../src/agent-lifecycle.js', import.meta.url), 'utf8');
  const forbidden = [
    'broker.execute', 'tool.handler', '.execute(',
    'process.env', 'fetch(', 'node:http', 'node:https', 'child_process', 'eval(',
  ];
  for (const term of forbidden) assert.ok(!src.includes(term), `agent-lifecycle.js must not contain ${term}`);
});

test('348. the lifecycle module never touches an agent_version — no addAgentVersion, no setActiveVersion', () => {
  const src = readFileSync(new URL('../src/agent-lifecycle.js', import.meta.url), 'utf8');
  for (const term of ['addAgentVersion(', 'setActiveVersion(', 'getAgentVersion(']) {
    assert.ok(!src.includes(term), `agent-lifecycle.js must not call ${term}`);
  }
});

test('349. the lifecycle module never touches a freeze — no addFreeze, no activeFreeze', () => {
  const src = readFileSync(new URL('../src/agent-lifecycle.js', import.meta.url), 'utf8');
  for (const term of ['addFreeze(', 'activeFreeze(']) {
    assert.ok(!src.includes(term), `agent-lifecycle.js must not call ${term}`);
  }
});

test('350. the lifecycle module calls store.setLifecycleState exactly once, and store.getAgent for reads — the only two contract methods it needs', () => {
  const src = readFileSync(new URL('../src/agent-lifecycle.js', import.meta.url), 'utf8');
  const setCalls = (src.match(/store\.setLifecycleState\(/g) ?? []).length;
  assert.equal(setCalls, 1);
  assert.ok(src.includes('store.getAgent('));
  assert.ok(!src.includes('store.getAgentRecord('), 'must use the formal-contract getAgent(), not the memory-only introspection method — see the file header');
});

test('351. RETIRED and FROZEN have no outgoing edges in the transition graph', () => {
  assert.equal(AGENT_LIFECYCLE_TRANSITIONS[RUNTIME_STATE.RETIRED].size, 0);
  assert.equal(AGENT_LIFECYCLE_TRANSITIONS[RUNTIME_STATE.FROZEN].size, 0);
});

test('352. the lifecycle module exposes exactly two functions — no hidden authorization surface', () => {
  const { lifecycle } = stackSetup();
  assert.deepEqual(Object.keys(lifecycle).sort(), ['getLifecycleState', 'transition']);
});

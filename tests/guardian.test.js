/**
 * GUARDIAN — AUTONOMOUS SAFETY CONTROLLER (Milestone 10)
 *
 * Proves Guardian OBSERVES and FREEZES, and never anything more: every
 * policy is deterministic threshold-counting over the existing audit log,
 * the only mutation it ever performs is `store.addFreeze`, and an imposed
 * freeze is immediately effective at the Broker and runtime.js exactly as
 * any human-imposed freeze already was — Guardian adds an automated
 * caller of an existing enforcement point, not a new one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStore } from '../src/store.js';
import { createAuditSink } from '../src/audit.js';
import { createBroker } from '../src/broker.js';
import { createTools } from '../src/tools.js';
import { createRuntime } from '../src/runtime.js';
import { createGuardian, GUARDIAN_POLICY, GUARDIAN_REASON } from '../src/guardian.js';
import { registerRouterDemoAgents, ROUTER_DEMO_AGENT_SLUGS, ROUTER_DEMO_HANDLERS } from '../src/demo-router-agents.js';

const T0 = 3_000_000;
const S = ROUTER_DEMO_AGENT_SLUGS;

/** Full stack with the 3 legitimate router demo agents registered. */
function stackSetup(o = {}) {
  const { tools } = createTools();
  const store = createMemoryStore();
  const audit = createAuditSink();
  const clock = o.clock ?? (() => T0);
  registerRouterDemoAgents(store);
  const broker = createBroker({ tools, store, audit, clock });
  const runtime = createRuntime({ store, broker, audit, clock, handlers: o.handlers ?? ROUTER_DEMO_HANDLERS, registrySha: 'test-sha' });
  const guardian = createGuardian({ store, audit, clock, policy: o.policy ?? GUARDIAN_POLICY });
  return { store, audit, clock, broker, runtime, guardian, tools };
}

/** Runs a task for agent_slug against tree_id `n` times, giving each task
 * its own budget so BUDGET_MISSING never masks the intended failure mode. */
function runN(runtime, store, agent_slug, tree_id, n, prefix = 't') {
  const results = [];
  for (let i = 0; i < n; i++) {
    const task_id = `${prefix}${i}`;
    store.createTaskBudgets({ task_id, tree_id, agent_slug, limit: 1000 });
    results.push(runtime.runTask({ agent_slug, input: { text: 'x' }, task_id, tree_id }));
  }
  return results;
}

// ── 1. agent failure rate ────────────────────────────────────────────────

test('197. below the failure threshold, the agent is not frozen', () => {
  const { store, runtime, guardian } = stackSetup({ handlers: { [S.RESEARCH]: () => { throw new Error('boom'); } } });
  runN(runtime, store, S.RESEARCH, 'tree1', 2);
  const r = guardian.evaluateAgentFailureRate(S.RESEARCH);
  assert.equal(r.imposed, false);
  assert.equal(store.activeFreeze('agent', S.RESEARCH, T0), null);
});

test('198. at the failure threshold, Guardian freezes the agent', () => {
  const { store, runtime, guardian } = stackSetup({ handlers: { [S.RESEARCH]: () => { throw new Error('boom'); } } });
  runN(runtime, store, S.RESEARCH, 'tree1', 3);
  const r = guardian.evaluateAgentFailureRate(S.RESEARCH);
  assert.equal(r.imposed, true);
  assert.equal(r.reason, GUARDIAN_REASON.AGENT_FAILURE_RATE_EXCEEDED);
  assert.ok(store.activeFreeze('agent', S.RESEARCH, T0));
});

test('199. a Guardian-imposed agent freeze is immediately enforced by the Broker', () => {
  const { store, broker, runtime, guardian } = stackSetup({ handlers: { [S.RESEARCH]: () => { throw new Error('boom'); } } });
  runN(runtime, store, S.RESEARCH, 'tree1', 3);
  guardian.evaluateAgentFailureRate(S.RESEARCH);
  const decision = broker.authorize({ agent_slug: S.RESEARCH, tool_id: 'text.wordcount', payload: { text: 'x' } });
  assert.equal(decision.decision, 'DENY');
  assert.equal(decision.reason, 'AGENT_FROZEN');
});

test('200. a Guardian-imposed agent freeze is immediately enforced by runtime.js pre-flight', () => {
  const { store, runtime, guardian } = stackSetup({ handlers: { [S.RESEARCH]: () => { throw new Error('boom'); } } });
  runN(runtime, store, S.RESEARCH, 'tree1', 3);
  guardian.evaluateAgentFailureRate(S.RESEARCH);
  store.createTaskBudgets({ task_id: 'after-freeze', tree_id: 'tree1', agent_slug: S.RESEARCH, limit: 100 });
  const result = runtime.runTask({ agent_slug: S.RESEARCH, input: { text: 'x' }, task_id: 'after-freeze', tree_id: 'tree1' });
  assert.equal(result.status, 'failed');
  assert.equal(result.failure_reason_code, 'AGENT_FROZEN');
});

// ── 2. workflow failure rate ─────────────────────────────────────────────

test('201. at the failure threshold, Guardian freezes the WORKFLOW, not just an agent', () => {
  const { store, audit, clock, guardian } = stackSetup();
  for (let i = 0; i < 3; i++) audit.write({ event: 'runtime.task', at: clock(), tree_id: 'wf-bad', agent_slug: S.RESEARCH, status: 'failed' });
  const r = guardian.evaluateWorkflowFailureRate('wf-bad');
  assert.equal(r.imposed, true);
  assert.equal(r.reason, GUARDIAN_REASON.WORKFLOW_FAILURE_RATE_EXCEEDED);
  assert.ok(store.activeFreeze('workflow', 'wf-bad', T0));
});

test('202. a Guardian-imposed workflow freeze is enforced by the Broker for tool calls in that tree', () => {
  const { store, broker, audit, clock, guardian } = stackSetup();
  for (let i = 0; i < 3; i++) audit.write({ event: 'runtime.task', at: clock(), tree_id: 'wf-bad2', agent_slug: S.RESEARCH, status: 'failed' });
  guardian.evaluateWorkflowFailureRate('wf-bad2');
  const decision = broker.authorize({ agent_slug: S.RESEARCH, tool_id: 'text.wordcount', payload: { text: 'x' }, tree_id: 'wf-bad2' });
  assert.equal(decision.decision, 'DENY');
  assert.equal(decision.reason, 'WORKFLOW_FROZEN');
});

// ── 3. repeated authorization denials ────────────────────────────────────

test('203. repeated authorization denials freeze the agent', () => {
  const { store, audit, clock, guardian } = stackSetup();
  for (let i = 0; i < 3; i++) audit.write({ event: 'broker.decision', at: clock(), agent_slug: S.WRITING, decision: 'DENY', reason: 'TOOL_NOT_ALLOWED' });
  const r = guardian.evaluateAuthorizationDenials(S.WRITING);
  assert.equal(r.imposed, true);
  assert.equal(r.reason, GUARDIAN_REASON.AUTHORIZATION_DENIAL_SPIKE);
  assert.ok(store.activeFreeze('agent', S.WRITING, T0));
});

test('a mix of ALLOW and DENY below threshold does not freeze', () => {
  const { store, audit, clock, guardian } = stackSetup();
  audit.write({ event: 'broker.decision', at: clock(), agent_slug: S.WRITING, decision: 'DENY' });
  audit.write({ event: 'broker.decision', at: clock(), agent_slug: S.WRITING, decision: 'ALLOW' });
  audit.write({ event: 'broker.decision', at: clock(), agent_slug: S.WRITING, decision: 'DENY' });
  const r = guardian.evaluateAuthorizationDenials(S.WRITING);
  assert.equal(r.imposed, false);
  assert.equal(store.activeFreeze('agent', S.WRITING, T0), null);
});

// ── 4. abnormal retry rate ────────────────────────────────────────────────

test('204. an abnormal retry rate freezes the workflow', () => {
  const { store, audit, clock, guardian } = stackSetup();
  for (let i = 0; i < 3; i++) audit.write({ event: 'workflow.retry', at: clock(), workflow_id: 'wf-retry', task_id: `t${i}`, decision: 'accepted' });
  const r = guardian.evaluateRetrySpike('wf-retry');
  assert.equal(r.imposed, true);
  assert.equal(r.reason, GUARDIAN_REASON.RETRY_SPIKE);
  assert.ok(store.activeFreeze('workflow', 'wf-retry', T0));
});

test('rejected retries do not count toward the retry-spike threshold', () => {
  const { store, audit, clock, guardian } = stackSetup();
  for (let i = 0; i < 3; i++) audit.write({ event: 'workflow.retry', at: clock(), workflow_id: 'wf-retry2', task_id: `t${i}`, decision: 'rejected' });
  const r = guardian.evaluateRetrySpike('wf-retry2');
  assert.equal(r.imposed, false);
});

// ── 5. global budget exhaustion ──────────────────────────────────────────

test('205. global budget exhaustion triggers a HARD global freeze (no expiry)', () => {
  const { store, guardian } = stackSetup();
  store.addBudget({ level: 'global_month', target_id: null, limit: 100, spent: 100 });
  const r = guardian.evaluateGlobalBudget();
  assert.equal(r.imposed, true);
  assert.equal(r.reason, GUARDIAN_REASON.GLOBAL_BUDGET_EXHAUSTED);
  assert.equal(r.expires_at, null, 'a global emergency freeze must not silently self-expire');
});

test('206. a Guardian global freeze blocks every agent, not just one', () => {
  const { store, broker, guardian } = stackSetup();
  store.addBudget({ level: 'global_month', target_id: null, limit: 100, spent: 100 });
  guardian.evaluateGlobalBudget();
  for (const slug of [S.RESEARCH, S.ANALYSIS, S.WRITING]) {
    const decision = broker.authorize({ agent_slug: slug, tool_id: 'text.wordcount', payload: { text: 'x' } });
    assert.equal(decision.decision, 'DENY');
    assert.equal(decision.reason, 'GLOBAL_FREEZE');
  }
});

// ── 6. abnormal per-agent spending ───────────────────────────────────────

test('207. abnormal per-agent spending triggers a SOFT freeze below full exhaustion', () => {
  const { store, guardian } = stackSetup();
  store.addBudget({ level: 'agent_day', target_id: S.ANALYSIS, limit: 100, spent: 92 });
  const r = guardian.evaluateAgentBudgetWarning(S.ANALYSIS);
  assert.equal(r.imposed, true);
  assert.equal(r.reason, GUARDIAN_REASON.AGENT_BUDGET_WARNING);
  assert.notEqual(r.expires_at, null, 'a spending WARNING is soft, not a permanent freeze');
});

test('spending below the warning ratio does not freeze', () => {
  const { store, guardian } = stackSetup();
  store.addBudget({ level: 'agent_day', target_id: S.ANALYSIS, limit: 100, spent: 10 });
  const r = guardian.evaluateAgentBudgetWarning(S.ANALYSIS);
  assert.equal(r.imposed, false);
});

// ── idempotency and audit ────────────────────────────────────────────────

test('208. Guardian does not re-freeze an already-frozen scope', () => {
  const { store, runtime, guardian, audit } = stackSetup({ handlers: { [S.RESEARCH]: () => { throw new Error('boom'); } } });
  runN(runtime, store, S.RESEARCH, 'tree1', 3);
  guardian.evaluateAgentFailureRate(S.RESEARCH);
  const again = guardian.evaluateAgentFailureRate(S.RESEARCH);
  assert.equal(again.imposed, false);
  assert.equal(again.reason, 'ALREADY_FROZEN');
  const freezeEvents = audit.all().filter((r) => r.event === 'guardian.freeze' && r.target_id === S.RESEARCH);
  assert.equal(freezeEvents.length, 1, 'exactly one freeze record, not one per evaluation');
  const persistEvents = audit.all().filter((r) => r.event === 'guardian.condition_persists');
  assert.equal(persistEvents.length, 1, 'the second breach is recorded, not silently dropped');
});

test('209. soft freezes carry an expiry; the hard global freeze does not', () => {
  const { store, guardian } = stackSetup();
  store.addBudget({ level: 'agent_day', target_id: S.ANALYSIS, limit: 100, spent: 92 });
  const soft = guardian.evaluateAgentBudgetWarning(S.ANALYSIS);
  store.addBudget({ level: 'global_month', target_id: null, limit: 100, spent: 100 });
  const hard = guardian.evaluateGlobalBudget();
  assert.equal(typeof soft.expires_at, 'number');
  assert.equal(hard.expires_at, null);
});

test('210. evaluate() runs every policy across an empty store without throwing', () => {
  const store = createMemoryStore();
  const audit = createAuditSink();
  const guardian = createGuardian({ store, audit, clock: () => T0 });
  const result = guardian.evaluate();
  assert.equal(result.checked_at, T0);
  assert.ok(Array.isArray(result.results));
});

test('211. evaluate() discovers workflow ids purely from the audit log', () => {
  const { store, audit, clock, guardian } = stackSetup();
  for (let i = 0; i < 3; i++) audit.write({ event: 'runtime.task', at: clock(), tree_id: 'discovered-wf', agent_slug: S.RESEARCH, status: 'failed' });
  guardian.evaluate();
  assert.ok(store.activeFreeze('workflow', 'discovered-wf', T0), 'evaluate() must have found and checked this workflow on its own');
});

test('214. every guardian.freeze audit event carries scope, target, and reason', () => {
  const { store, runtime, guardian, audit } = stackSetup({ handlers: { [S.RESEARCH]: () => { throw new Error('boom'); } } });
  runN(runtime, store, S.RESEARCH, 'tree1', 3);
  guardian.evaluateAgentFailureRate(S.RESEARCH);
  const record = audit.all().find((r) => r.event === 'guardian.freeze');
  assert.equal(record.scope, 'agent');
  assert.equal(record.target_id, S.RESEARCH);
  assert.equal(record.reason, GUARDIAN_REASON.AGENT_FAILURE_RATE_EXCEEDED);
  assert.ok(record.detail);
});

test('215. a guardian.check audit event is recorded even when no freeze is imposed', () => {
  const { store, runtime, guardian, audit } = stackSetup({ handlers: { [S.RESEARCH]: () => { throw new Error('boom'); } } });
  runN(runtime, store, S.RESEARCH, 'tree1', 1);
  guardian.evaluateAgentFailureRate(S.RESEARCH);
  const record = audit.all().find((r) => r.event === 'guardian.check' && r.check === 'agent_failure_rate');
  assert.ok(record, 'observability must not depend on a breach happening');
  assert.equal(record.failures, 1);
});

// ── isolation ─────────────────────────────────────────────────────────────

test('216. a failing agent does not cause Guardian to freeze an unrelated, healthy agent', () => {
  const { store, runtime, guardian } = stackSetup({ handlers: { [S.RESEARCH]: () => { throw new Error('boom'); } } });
  runN(runtime, store, S.RESEARCH, 'tree1', 3);
  guardian.evaluateAgentFailureRate(S.RESEARCH);
  const healthy = guardian.evaluateAgentFailureRate(S.WRITING);
  assert.equal(healthy.imposed, false);
  assert.equal(store.activeFreeze('agent', S.WRITING, T0), null);
});

test('217. a failing workflow does not cause Guardian to freeze an unrelated workflow', () => {
  const { store, audit, clock, guardian } = stackSetup();
  for (let i = 0; i < 3; i++) audit.write({ event: 'runtime.task', at: clock(), tree_id: 'wf-A', agent_slug: S.RESEARCH, status: 'failed' });
  audit.write({ event: 'runtime.task', at: clock(), tree_id: 'wf-B', agent_slug: S.RESEARCH, status: 'completed' });
  guardian.evaluateWorkflowFailureRate('wf-A');
  const healthy = guardian.evaluateWorkflowFailureRate('wf-B');
  assert.equal(healthy.imposed, false);
  assert.equal(store.activeFreeze('workflow', 'wf-B', T0), null);
});

// ── 8. repeated HANDLER-classified failures, specifically (M15) ─────────

test('309. below the handler-failure threshold, the agent is not frozen', () => {
  const { store, runtime, guardian } = stackSetup({ handlers: { [S.RESEARCH]: () => { throw new Error('boom'); } } });
  runN(runtime, store, S.RESEARCH, 'tree1', 2);
  const r = guardian.evaluateHandlerFailureRate(S.RESEARCH);
  assert.equal(r.imposed, false);
  assert.equal(store.activeFreeze('agent', S.RESEARCH, T0), null);
});

test('310. at the handler-failure threshold, Guardian freezes the agent with a distinct reason', () => {
  const { store, runtime, guardian } = stackSetup({ handlers: { [S.RESEARCH]: () => { throw new Error('boom'); } } });
  runN(runtime, store, S.RESEARCH, 'tree1', 3);
  const r = guardian.evaluateHandlerFailureRate(S.RESEARCH);
  assert.equal(r.imposed, true);
  assert.equal(r.reason, GUARDIAN_REASON.HANDLER_FAILURE_RATE_EXCEEDED);
  assert.ok(store.activeFreeze('agent', S.RESEARCH, T0));
});

test('311. a Guardian handler-failure freeze is immediately enforced by the Broker and runtime.js', () => {
  const { store, broker, runtime, guardian } = stackSetup({ handlers: { [S.RESEARCH]: () => { throw new Error('boom'); } } });
  runN(runtime, store, S.RESEARCH, 'tree1', 3);
  guardian.evaluateHandlerFailureRate(S.RESEARCH);

  const decision = broker.authorize({ agent_slug: S.RESEARCH, tool_id: 'text.wordcount', payload: { text: 'x' } });
  assert.equal(decision.decision, 'DENY');
  assert.equal(decision.reason, 'AGENT_FROZEN');

  store.createTaskBudgets({ task_id: 'after-freeze', tree_id: 'tree1', agent_slug: S.RESEARCH, limit: 100 });
  const result = runtime.runTask({ agent_slug: S.RESEARCH, input: { text: 'x' }, task_id: 'after-freeze', tree_id: 'tree1' });
  assert.equal(result.status, 'failed');
  assert.equal(result.failure_reason_code, 'AGENT_FROZEN');
});

test('312. structural (non-handler) failures never trip the handler-failure check, even at the same volume that trips the general one', () => {
  // Three failures, none of them HANDLER_ERROR — e.g. the agent is
  // already frozen for an unrelated reason, so every attempt fails
  // AGENT_FROZEN. The general agent_failure_rate check (#1) would count
  // these identically to a real handler bug; this narrower check must not.
  const { store, audit, clock, guardian } = stackSetup();
  store.addFreeze({ scope: 'agent', target_id: S.ANALYSIS, reason: 'pre-existing', imposed_by: 'test', imposed_at: T0, expires_at: null });
  for (let i = 0; i < 3; i++) {
    audit.write({ event: 'runtime.task', at: clock(), tree_id: 'tree1', agent_slug: S.ANALYSIS, status: 'failed', reason: 'AGENT_FROZEN' });
  }
  const r = guardian.evaluateHandlerFailureRate(S.ANALYSIS);
  assert.equal(r.imposed, false, 'AGENT_FROZEN failures are not handler failures');
});

test('313. a mix of failure reasons only counts the HANDLER_ERROR ones toward the threshold', () => {
  const { store, audit, clock, guardian } = stackSetup();
  audit.write({ event: 'runtime.task', at: clock(), tree_id: 'tree1', agent_slug: S.WRITING, status: 'failed', reason: 'HANDLER_ERROR' });
  audit.write({ event: 'runtime.task', at: clock(), tree_id: 'tree1', agent_slug: S.WRITING, status: 'failed', reason: 'HANDLER_ERROR' });
  audit.write({ event: 'runtime.task', at: clock(), tree_id: 'tree1', agent_slug: S.WRITING, status: 'failed', reason: 'INPUT_CONTRACT_VIOLATION' });
  audit.write({ event: 'runtime.task', at: clock(), tree_id: 'tree1', agent_slug: S.WRITING, status: 'failed', reason: 'BUDGET_MISSING' });
  const r = guardian.evaluateHandlerFailureRate(S.WRITING);
  assert.equal(r.imposed, false, 'only 2 of the 4 recent failures are HANDLER_ERROR — below the threshold of 3');
  assert.equal(store.activeFreeze('agent', S.WRITING, T0), null);
});

test('314. Guardian freezing an agent for handler failures never touches that agent\'s clearance, tools, or version state', () => {
  const { store, runtime, guardian } = stackSetup({ handlers: { [S.RESEARCH]: () => { throw new Error('boom'); } } });
  const before = store.getAgent(S.RESEARCH);
  runN(runtime, store, S.RESEARCH, 'tree1', 3);
  guardian.evaluateHandlerFailureRate(S.RESEARCH);
  const after = store.getAgent(S.RESEARCH);
  assert.equal(after.clearance, before.clearance);
  assert.deepEqual(after.allowed_tools, before.allowed_tools);
  assert.equal(after.version_state, before.version_state);
  assert.equal(after.version_id, before.version_id);
});

test('315. a handler-failing agent does not cause Guardian to freeze an unrelated, healthy agent', () => {
  const { store, runtime, guardian } = stackSetup({ handlers: { [S.RESEARCH]: () => { throw new Error('boom'); } } });
  runN(runtime, store, S.RESEARCH, 'tree1', 3);
  guardian.evaluateHandlerFailureRate(S.RESEARCH);
  const healthy = guardian.evaluateHandlerFailureRate(S.WRITING);
  assert.equal(healthy.imposed, false);
  assert.equal(store.activeFreeze('agent', S.WRITING, T0), null);
});

test('316. evaluate() runs the handler-failure check for every known agent automatically', () => {
  const { store, runtime, guardian } = stackSetup({ handlers: { [S.RESEARCH]: () => { throw new Error('boom'); } } });
  runN(runtime, store, S.RESEARCH, 'tree1', 3);
  const result = guardian.evaluate();
  const check = result.results.find((r) => r.check === 'handler_failure_rate' && r.target_id === S.RESEARCH);
  assert.ok(check, 'evaluate() must include this check without being asked directly');
  // Whether THIS check's own imposed flag is true depends on evaluate()'s
  // internal ordering — the general agent_failure_rate check (#1) trips
  // on the same 3 failures and may freeze first, making this check's own
  // impose() call correctly a no-op (idempotency, per test 208). What
  // must hold regardless is that the agent ends up frozen and this check
  // genuinely ran.
  assert.ok(store.activeFreeze('agent', S.RESEARCH, T0));
});

// ── Guardian cannot grant authority ──────────────────────────────────────

test('218. Guardian freezing an agent never touches that agent\'s clearance, tools, or version state', () => {
  const { store, runtime, guardian } = stackSetup({ handlers: { [S.RESEARCH]: () => { throw new Error('boom'); } } });
  const before = store.getAgent(S.RESEARCH);
  runN(runtime, store, S.RESEARCH, 'tree1', 3);
  guardian.evaluateAgentFailureRate(S.RESEARCH);
  const after = store.getAgent(S.RESEARCH);
  assert.equal(after.clearance, before.clearance);
  assert.deepEqual(after.allowed_tools, before.allowed_tools);
  assert.equal(after.version_state, before.version_state);
  assert.equal(after.version_id, before.version_id);
});

test('219. Guardian exposes no method capable of lifting a freeze', () => {
  const { guardian } = stackSetup();
  for (const name of ['liftFreeze', 'unfreeze', 'removeFreeze', 'clearFreeze', 'approve', 'setActiveVersion', 'chargeBudgets', 'execute']) {
    assert.equal(typeof guardian[name], 'undefined', `guardian must not expose ${name}`);
  }
});

// ── structural isolation ─────────────────────────────────────────────────

test('212. Guardian has no reference to broker.execute and touches no network/credential primitive', () => {
  const src = readFileSync(new URL('../src/guardian.js', import.meta.url), 'utf8');
  const forbidden = [
    'node:http', 'node:https', 'node:net', 'node:tls', 'child_process', 'worker_threads',
    'fetch(', 'process.env', 'eval(', 'broker.execute', '.execute(', 'authorize(',
  ];
  for (const term of forbidden) assert.ok(!src.includes(term), `guardian.js must not contain ${term}`);
});

test('213. Guardian only ever calls addFreeze/activeFreeze/listAgents/budgetsFor on the store — never a mutation method belonging to another security boundary', () => {
  const src = readFileSync(new URL('../src/guardian.js', import.meta.url), 'utf8');
  const forbidden = ['setActiveVersion(', 'registerAgent(', 'addApproval(', 'chargeBudgets(', 'addAgentVersion(', 'setLifecycleState(', 'createTask(', 'updateTask(', 'claimIdempotency(', 'recordIdempotency('];
  for (const term of forbidden) assert.ok(!src.includes(`store.${term}`), `guardian.js must not call store.${term}`);
  assert.ok(src.includes('store.addFreeze('), 'the one mutation Guardian is meant to perform must still be present');
});

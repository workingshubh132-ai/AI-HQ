/**
 * ROUTER — MULTI-AGENT CONTROL PLANE (Milestone 9)
 *
 * Proves the router SELECTS without ever AUTHORIZING: every eligibility
 * check it applies is advisory filtering, and the Broker/runtime remain
 * the only layers that can actually allow a tool call or an agent run.
 * Tests deterministic selection, the 10-point eligibility gauntlet,
 * capability-is-not-authorization (adversarially), concurrency reservation
 * accounting, per-agent vs per-workflow budget isolation, freeze
 * precedence, and full auditability.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStore } from '../src/store.js';
import { createAuditSink } from '../src/audit.js';
import { createBroker } from '../src/broker.js';
import { createTools } from '../src/tools.js';
import { createRuntime } from '../src/runtime.js';
import { createRouter, ROUTING_REASON, ROUTING_POLICY_VERSION, MAX_AGENT_CONCURRENCY } from '../src/router.js';
import { makeAgent, makeAgentVersion, VERSION_STATE, RUNTIME_STATE, versionId } from '../src/agents.js';
import {
  registerRouterDemoAgents, registerMisleadingAgent, ROUTER_DEMO_AGENT_SLUGS, ROUTER_DEMO_HANDLERS,
} from '../src/demo-router-agents.js';

const T0 = 2_000_000;

/** store + audit + router, with the 3 legitimate demo agents registered. */
function routerSetup(o = {}) {
  const store = createMemoryStore();
  const audit = createAuditSink();
  const clock = o.clock ?? (() => T0);
  registerRouterDemoAgents(store);
  const router = createRouter({ store, audit, clock });
  return { store, audit, clock, router };
}

/** Full stack (store + Broker + runtime + router), for tests that need to
 * actually EXECUTE a routed task, not just route it. */
function fullStackSetup(o = {}) {
  const { tools, outbox, invocations } = createTools();
  const store = createMemoryStore();
  const audit = createAuditSink();
  const clock = o.clock ?? (() => T0);
  registerRouterDemoAgents(store);
  const broker = createBroker({ tools, store, audit, clock });
  const runtime = createRuntime({ store, broker, audit, clock, handlers: ROUTER_DEMO_HANDLERS, registrySha: 'test-sha' });
  const router = createRouter({ store, audit, clock });
  return { store, audit, clock, broker, runtime, router, tools, outbox, invocations };
}

const S = ROUTER_DEMO_AGENT_SLUGS;

// ── 1–4: basic selection ─────────────────────────────────────────────────

test('171. one eligible agent is selected', () => {
  const { router } = routerSetup();
  const r = router.route({ task_id: 't1', required_capability: 'analysis' });
  assert.equal(r.decision, 'routed');
  assert.equal(r.reason, ROUTING_REASON.OK);
  assert.equal(r.selected_agent_slug, S.ANALYSIS);
  assert.equal(r.routing_policy_version, ROUTING_POLICY_VERSION);
});

test('172. multiple eligible agents for the same capability are chosen deterministically (ascending agent_slug)', () => {
  const { store, router } = routerSetup();
  // A second research-capable agent, slug sorting AFTER 'research-agent'.
  const v = makeAgentVersion({
    agent_id: 'agent-research-2', version: '1.0.0', purpose: 'second research agent', department: 'internal',
    state: VERSION_STATE.APPROVED, clearance: 'GREEN', allowed_tools: ['text.wordcount'],
    limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 5_000 }, capabilities: ['research'],
    input_contract: { required: [] }, output_contract: { required: [] }, created_at: 0, approved_by: 'founder', approved_at: 0,
  });
  store.addAgentVersion(v);
  store.registerAgent(makeAgent({ id: 'agent-research-2', slug: 'zz-second-research-agent', active_version_id: versionId('agent-research-2', '1.0.0') }));

  const r = router.route({ task_id: 't1', required_capability: 'research' });
  assert.equal(r.selected_agent_slug, S.RESEARCH, "'research-agent' < 'zz-second-research-agent' ascending");
});

test('173. required capability filters candidates', () => {
  const { router } = routerSetup();
  const r = router.route({ task_id: 't1', required_capability: 'writing' });
  assert.equal(r.selected_agent_slug, S.WRITING);
  const rejectedSlugs = r.rejected_candidates.map((c) => c.agent_slug).sort();
  assert.deepEqual(rejectedSlugs, [S.ANALYSIS, S.RESEARCH].sort());
  for (const c of r.rejected_candidates) assert.equal(c.reason, ROUTING_REASON.CAPABILITY_NOT_DECLARED);
});

test('174. an unsupported capability yields no route', () => {
  const { router } = routerSetup();
  const r = router.route({ task_id: 't1', required_capability: 'astrology' });
  assert.equal(r.decision, 'no_eligible_agent');
  assert.equal(r.reason, ROUTING_REASON.NO_ELIGIBLE_AGENT);
  assert.equal(r.selected_agent_slug, null);
  assert.equal(r.rejected_candidates.length, 3);
});

// ── 5–9: eligibility exclusions ──────────────────────────────────────────

test('175. a paused agent is excluded', () => {
  const { store, router } = routerSetup();
  store.setLifecycleState(S.RESEARCH, RUNTIME_STATE.PAUSED);
  const r = router.route({ task_id: 't1', required_capability: 'research' });
  assert.equal(r.decision, 'no_eligible_agent');
  const rejected = r.rejected_candidates.find((c) => c.agent_slug === S.RESEARCH);
  assert.equal(rejected.reason, ROUTING_REASON.AGENT_NOT_ACTIVE);
});

test('a degraded agent is excluded the same way, reusing the same lifecycle check', () => {
  const { store, router } = routerSetup();
  store.setLifecycleState(S.RESEARCH, RUNTIME_STATE.DEGRADED);
  const r = router.route({ task_id: 't1', required_capability: 'research' });
  assert.equal(r.decision, 'no_eligible_agent');
});

test('176. an unapproved active version excludes the agent', () => {
  const store = createMemoryStore();
  const v = makeAgentVersion({
    agent_id: 'agent-draft', version: '1.0.0', purpose: 'p', department: 'internal', state: VERSION_STATE.HUMAN_REVIEW,
    clearance: 'GREEN', allowed_tools: [], limits: { max_attempts: 1, max_cost_per_task: 1, max_runtime_ms: 1 },
    capabilities: ['research'], input_contract: { required: [] }, output_contract: { required: [] }, created_at: 0,
  });
  store.addAgentVersion(v);
  store.registerAgent(makeAgent({ id: 'agent-draft', slug: 'draft-agent', active_version_id: versionId('agent-draft', '1.0.0') }));
  const router = createRouter({ store, audit: createAuditSink(), clock: () => T0 });
  const r = router.route({ task_id: 't1', required_capability: 'research' });
  assert.equal(r.decision, 'no_eligible_agent');
  assert.equal(r.rejected_candidates[0].reason, ROUTING_REASON.VERSION_NOT_APPROVED);
});

test('177. a missing active version excludes the agent', () => {
  const store = createMemoryStore();
  store.registerAgent(makeAgent({ id: 'agent-blank', slug: 'blank-agent', active_version_id: null }));
  const router = createRouter({ store, audit: createAuditSink(), clock: () => T0 });
  const r = router.route({ task_id: 't1', required_capability: 'research' });
  assert.equal(r.decision, 'no_eligible_agent');
  assert.equal(r.rejected_candidates[0].reason, ROUTING_REASON.INVALID_AGENT);
});

test('178. concurrency exhausted excludes the agent, below/at/above the limit', () => {
  const { router } = routerSetup();
  for (let i = 0; i < MAX_AGENT_CONCURRENCY; i++) {
    const r = router.route({ task_id: `c${i}`, required_capability: 'research' });
    assert.equal(r.decision, 'routed', `reservation ${i} of ${MAX_AGENT_CONCURRENCY} should still succeed`);
  }
  const atLimit = router.route({ task_id: 'c-over', required_capability: 'research' });
  assert.equal(atLimit.decision, 'no_eligible_agent');
  const rejected = atLimit.rejected_candidates.find((c) => c.agent_slug === S.RESEARCH);
  assert.equal(rejected.reason, ROUTING_REASON.AGENT_CONCURRENCY_LIMIT);
});

test('179. insufficient agent budget excludes the agent', () => {
  const { store, router } = routerSetup();
  store.addBudget({ level: 'agent_day', target_id: S.RESEARCH, limit: 10, spent: 10 });
  const r = router.route({ task_id: 't1', required_capability: 'research' });
  assert.equal(r.decision, 'no_eligible_agent');
  const rejected = r.rejected_candidates.find((c) => c.agent_slug === S.RESEARCH);
  assert.equal(rejected.reason, ROUTING_REASON.BUDGET_INSUFFICIENT);
});

// ── 10: determinism ───────────────────────────────────────────────────────

test('180. routing is deterministic across repeated identical calls', () => {
  const { router } = routerSetup();
  const results = [0, 1, 2].map((i) => router.route({ task_id: `d${i}`, required_capability: 'writing' }).selected_agent_slug);
  assert.deepEqual(results, [S.WRITING, S.WRITING, S.WRITING]);
});

// ── 11: isolation ──────────────────────────────────────────────────────────

test('181. routing for agent A never mutates agent B', () => {
  const { store, router } = routerSetup();
  const before = store.getAgent(S.WRITING);
  router.route({ task_id: 't1', required_capability: 'research' }); // selects RESEARCH, not WRITING
  const after = store.getAgent(S.WRITING);
  assert.deepEqual(after, before, 'routing another agent must not touch this one at all');
  assert.equal(router.getConcurrency(S.WRITING), 0);
});

// ── 12: capability is not authorization (adversarial) ──────────────────────

test('182. a capability claim the agent is not authorized for is still denied at execution, even though routing selected it', () => {
  const store = createMemoryStore();
  registerMisleadingAgent(store);
  const audit = createAuditSink();
  const { tools } = createTools();
  const clock = () => T0;
  const broker = createBroker({ tools, store, audit, clock });
  const runtime = createRuntime({ store, broker, audit, clock, handlers: ROUTER_DEMO_HANDLERS, registrySha: 'test-sha' });
  const router = createRouter({ store, audit, clock });

  // The router has ONLY the label to go on, and the label matches.
  const routed = router.route({ task_id: 'adv1', required_capability: 'research' });
  assert.equal(routed.decision, 'routed');
  assert.equal(routed.selected_agent_slug, S.MISLEADING);

  // The handler tries to call a tool it was never authorized for.
  store.createTaskBudgets({ task_id: 'adv1', tree_id: 'adv-tree', agent_slug: S.MISLEADING, limit: 100 });
  const result = runtime.runTask({ agent_slug: S.MISLEADING, input: { text: 'x' }, task_id: 'adv1', tree_id: 'adv-tree' });

  assert.equal(result.status, 'completed', 'the handler itself does not throw — it just gets refused');
  assert.equal(result.output._broker_decision, 'DENY');
  assert.equal(result.output._broker_reason, 'TOOL_NOT_ALLOWED', 'a capability string never became allowed_tools membership');
});

// ── 13–15: router cannot bypass, or weaken, the Broker ──────────────────────

test('183. the router has no reference to broker.execute, and touches no network/credential primitive', () => {
  const routerSrc = readSourceOf('../src/router.js');
  const demoSrc = readSourceOf('../src/demo-router-agents.js');
  const forbidden = ['node:http', 'node:https', 'node:net', 'node:tls', 'child_process', 'worker_threads', 'fetch(', 'process.env', 'eval(', 'broker.execute', '.execute('];
  for (const term of forbidden) {
    assert.ok(!routerSrc.includes(term), `router.js must not contain ${term}`);
    assert.ok(!demoSrc.includes(term), `demo-router-agents.js must not contain ${term}`);
  }
});

test('184. a routed agent calling a tool outside its allowlist is still denied (wrong tool)', () => {
  // Reuses the same adversarial fixture — TOOL_NOT_ALLOWED is exactly the
  // "wrong tool" case the Broker's allowlist check exists for.
  const store = createMemoryStore();
  registerMisleadingAgent(store);
  const audit = createAuditSink();
  const clock = () => T0;
  const { tools } = createTools();
  const broker = createBroker({ tools, store, audit, clock });
  const decision = broker.authorize({ agent_slug: S.MISLEADING, tool_id: 'lead.score', payload: { lead: {} } });
  assert.equal(decision.decision, 'DENY');
  assert.equal(decision.reason, 'TOOL_NOT_ALLOWED');
});

test('185. a routed GREEN agent attempting a RED action is still denied (wrong clearance)', () => {
  const { store } = routerSetup();
  const audit = createAuditSink();
  const clock = () => T0;
  const { tools } = createTools();
  const broker = createBroker({ tools, store, audit, clock });
  // research-agent is GREEN and was never given fake.transfer_funds — this
  // proves clearance/allowlist enforcement survives selection regardless.
  const decision = broker.authorize({ agent_slug: S.RESEARCH, tool_id: 'fake.transfer_funds', payload: { amount: 1 } });
  assert.equal(decision.decision, 'DENY');
  assert.ok(['TOOL_NOT_ALLOWED', 'RED_REQUIRES_HUMAN'].includes(decision.reason));
});

// ── 16–18: freezes win regardless of routing ────────────────────────────────

test('186. a workflow freeze denies routing into that tree', () => {
  const { store, router } = routerSetup();
  store.addFreeze({ scope: 'workflow', target_id: 'wf-frozen', reason: 'incident', expires_at: null });
  const r = router.route({ task_id: 't1', required_capability: 'research', workflow_id: 'wf-frozen' });
  assert.equal(r.decision, 'no_eligible_agent');
  assert.equal(r.reason, ROUTING_REASON.WORKFLOW_FROZEN);
});

test('187. a global freeze denies all routing', () => {
  const { store, router } = routerSetup();
  store.addFreeze({ scope: 'global', target_id: null, reason: 'emergency', expires_at: null });
  const r = router.route({ task_id: 't1', required_capability: 'research' });
  assert.equal(r.decision, 'no_eligible_agent');
  assert.equal(r.reason, ROUTING_REASON.GLOBAL_FREEZE);
});

test('188. an agent freeze excludes only that agent, not the whole route', () => {
  const { store, router } = routerSetup();
  store.addFreeze({ scope: 'agent', target_id: S.RESEARCH, reason: 'incident', expires_at: null });
  const r = router.route({ task_id: 't1', required_capability: 'research' });
  assert.equal(r.decision, 'no_eligible_agent');
  assert.equal(r.rejected_candidates.find((c) => c.agent_slug === S.RESEARCH).reason, ROUTING_REASON.AGENT_FROZEN);
  // an unrelated capability is entirely unaffected
  const r2 = router.route({ task_id: 't2', required_capability: 'writing' });
  assert.equal(r2.decision, 'routed');
});

// ── 19–20: reservation release on terminal outcomes ─────────────────────────

test('189. a failed task releases its concurrency reservation', () => {
  const { store, broker, runtime, router } = fullStackSetup();
  const routed = router.route({ task_id: 'fail1', required_capability: 'research' });
  assert.equal(router.getConcurrency(S.RESEARCH), 1);

  // No budget was ever created for this task — runtime.js fails closed
  // with BUDGET_MISSING before the handler runs, a clean terminal FAILED.
  const result = runtime.runTask({ agent_slug: S.RESEARCH, input: { text: 'x' }, task_id: 'fail1', tree_id: 'tree1' });
  assert.equal(result.status, 'failed');

  router.release({ agent_slug: routed.selected_agent_slug, task_id: 'fail1' });
  assert.equal(router.getConcurrency(S.RESEARCH), 0, 'the slot must be freed after a failed task');
});

test('190. a cancelled task releases its concurrency reservation', () => {
  const { router } = routerSetup();
  const routed = router.route({ task_id: 'cancel1', required_capability: 'research' });
  assert.equal(router.getConcurrency(S.RESEARCH), 1);
  // Cancellation in this codebase means "never started" (see workflow.js) —
  // release() is exactly as valid to call for that outcome as for FAILED.
  const { released } = router.release({ agent_slug: routed.selected_agent_slug, task_id: 'cancel1' });
  assert.equal(released, true);
  assert.equal(router.getConcurrency(S.RESEARCH), 0);
});

test('release() on a reservation never held is a safe, fail-closed no-op', () => {
  const { router } = routerSetup();
  const { released } = router.release({ agent_slug: S.RESEARCH, task_id: 'never-routed' });
  assert.equal(released, false);
  assert.equal(router.getConcurrency(S.RESEARCH), 0);
});

// ── 21: cross-workflow isolation ────────────────────────────────────────────

test('191. two workflows cannot corrupt each other\'s budget-based routing state', () => {
  const { store, router } = routerSetup();
  store.addBudget({ level: 'tree', target_id: 'wf-A', limit: 10, spent: 10 }); // exhausted
  store.addBudget({ level: 'tree', target_id: 'wf-B', limit: 10, spent: 0 }); // healthy
  const a = router.route({ task_id: 'a1', required_capability: 'research', workflow_id: 'wf-A' });
  const b = router.route({ task_id: 'b1', required_capability: 'research', workflow_id: 'wf-B' });
  assert.equal(a.decision, 'no_eligible_agent');
  assert.equal(b.decision, 'routed');
});

// ── 22–24: fail closed ──────────────────────────────────────────────────────

test('192. an empty agent registry fails closed, not throws', () => {
  const store = createMemoryStore();
  const router = createRouter({ store, audit: createAuditSink(), clock: () => T0 });
  const r = router.route({ task_id: 't1', required_capability: 'research' });
  assert.equal(r.decision, 'no_eligible_agent');
  assert.equal(r.reason, ROUTING_REASON.NO_ELIGIBLE_AGENT);
  assert.deepEqual(r.rejected_candidates, []);
});

test('193. a capability no agent declares fails closed with full accounting, not an exception', () => {
  const { router } = routerSetup();
  const r = router.route({ task_id: 't1', required_capability: 'time-travel' });
  assert.equal(r.decision, 'no_eligible_agent');
  assert.equal(r.rejected_candidates.length, 3);
});

test('194. malformed routing requests fail closed', () => {
  const { router } = routerSetup();
  for (const bad of [null, undefined, {}, { task_id: 't1' }, { task_id: '', required_capability: 'x' }, { task_id: 't1', required_capability: 'x', workflow_id: 5 }]) {
    const r = router.route(bad);
    assert.equal(r.decision, 'malformed_request', `expected malformed_request for ${JSON.stringify(bad)}`);
    assert.equal(r.reason, ROUTING_REASON.MALFORMED_REQUEST);
  }
});

// ── 25: version immutability is unaffected by M9 ────────────────────────────

test('195. an agent version remains immutable — routing adds no mutation path', () => {
  const store = createMemoryStore();
  const v = makeAgentVersion({
    agent_id: 'x', version: '1.0.0', purpose: 'p', department: 'internal', state: VERSION_STATE.APPROVED,
    clearance: 'GREEN', allowed_tools: [], limits: { max_attempts: 1, max_cost_per_task: 1, max_runtime_ms: 1 },
    capabilities: [], input_contract: { required: [] }, output_contract: { required: [] }, created_at: 0,
  });
  store.addAgentVersion(v);
  assert.throws(() => store.addAgentVersion(v), /already exists and is immutable/);
});

// ── 26: auditability ─────────────────────────────────────────────────────

test('196. every routing decision is audited with enough detail to reconstruct it', () => {
  const { audit, router } = routerSetup();
  router.route({ task_id: 't1', required_capability: 'research' });
  const record = audit.all().find((r) => r.event === 'router.decision' && r.task_id === 't1');
  assert.ok(record);
  assert.equal(record.decision, 'routed');
  assert.equal(record.selected_agent_slug, S.RESEARCH);
  assert.equal(record.routing_policy_version, ROUTING_POLICY_VERSION);
  assert.ok(Array.isArray(record.candidate_agent_slugs));
  assert.ok(Array.isArray(record.rejected_candidates));
});

test('a rejected candidate\'s audit trail carries enough information to reconstruct why', () => {
  const { audit, router } = routerSetup();
  router.route({ task_id: 't1', required_capability: 'writing' });
  const record = audit.all().find((r) => r.event === 'router.decision' && r.task_id === 't1');
  const rejected = record.rejected_candidates.find((c) => c.agent_slug === S.RESEARCH);
  assert.equal(rejected.reason, ROUTING_REASON.CAPABILITY_NOT_DECLARED);
});

test('setAgentHealth changes lifecycle state via the existing controlled API, audited with a reason', () => {
  const { store, audit, router } = routerSetup();
  const outcome = router.setAgentHealth({ agent_slug: S.WRITING, state: RUNTIME_STATE.PAUSED, reason: 'observed repeated failures' });
  assert.equal(outcome.applied, true);
  assert.equal(store.getAgent(S.WRITING).state, RUNTIME_STATE.PAUSED);
  const record = audit.all().find((r) => r.event === 'router.health_change' && r.agent_slug === S.WRITING);
  assert.equal(record.state, RUNTIME_STATE.PAUSED);
  assert.equal(record.reason, 'observed repeated failures');

  // and the router now refuses to select it
  const r = router.route({ task_id: 't1', required_capability: 'writing' });
  assert.equal(r.decision, 'no_eligible_agent');
});

test('setAgentHealth on an unknown agent fails closed without creating phantom state', () => {
  const { router } = routerSetup();
  const outcome = router.setAgentHealth({ agent_slug: 'ghost-agent', state: RUNTIME_STATE.PAUSED, reason: 'x' });
  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, ROUTING_REASON.UNKNOWN_AGENT);
});

// ── Part 9: workflow budget vs agent budget are independent dimensions ─────

test('agent budget sufficient + workflow budget insufficient → deny', () => {
  const { store, router } = routerSetup();
  store.addBudget({ level: 'tree', target_id: 'wf1', limit: 10, spent: 10 });
  store.addBudget({ level: 'agent_day', target_id: S.RESEARCH, limit: 100, spent: 0 });
  const r = router.route({ task_id: 't1', required_capability: 'research', workflow_id: 'wf1' });
  assert.equal(r.decision, 'no_eligible_agent');
});

test('workflow budget sufficient + agent budget insufficient → deny', () => {
  const { store, router } = routerSetup();
  store.addBudget({ level: 'tree', target_id: 'wf1', limit: 100, spent: 0 });
  store.addBudget({ level: 'agent_day', target_id: S.RESEARCH, limit: 10, spent: 10 });
  const r = router.route({ task_id: 't1', required_capability: 'research', workflow_id: 'wf1' });
  assert.equal(r.decision, 'no_eligible_agent');
});

test('both workflow and agent budget sufficient → proceed', () => {
  const { store, router } = routerSetup();
  store.addBudget({ level: 'tree', target_id: 'wf1', limit: 100, spent: 0 });
  store.addBudget({ level: 'agent_day', target_id: S.RESEARCH, limit: 100, spent: 0 });
  const r = router.route({ task_id: 't1', required_capability: 'research', workflow_id: 'wf1' });
  assert.equal(r.decision, 'routed');
});

// ── workflow-type filtering (advisory, empty = unrestricted) ───────────────

test('a required workflow type excludes an agent that restricts itself to a different one', () => {
  const store = createMemoryStore();
  const v = makeAgentVersion({
    agent_id: 'agent-narrow', version: '1.0.0', purpose: 'p', department: 'internal', state: VERSION_STATE.APPROVED,
    clearance: 'GREEN', allowed_tools: [], limits: { max_attempts: 1, max_cost_per_task: 1, max_runtime_ms: 1 },
    capabilities: ['research'], allowed_workflow_types: ['support-only'],
    input_contract: { required: [] }, output_contract: { required: [] }, created_at: 0,
  });
  store.addAgentVersion(v);
  store.registerAgent(makeAgent({ id: 'agent-narrow', slug: 'narrow-agent', active_version_id: versionId('agent-narrow', '1.0.0') }));
  const router = createRouter({ store, audit: createAuditSink(), clock: () => T0 });
  const r = router.route({ task_id: 't1', required_capability: 'research', required_workflow_type: 'content-pipeline' });
  assert.equal(r.decision, 'no_eligible_agent');
  assert.equal(r.rejected_candidates[0].reason, ROUTING_REASON.WORKFLOW_TYPE_NOT_SUPPORTED);
});

test('an agent with no declared workflow-type restriction is treated as general-purpose, not as supporting nothing', () => {
  const { router } = routerSetup();
  // research-agent declares allowed_workflow_types: [] — must still be
  // selectable for ANY required_workflow_type.
  const r = router.route({ task_id: 't1', required_capability: 'research', required_workflow_type: 'anything-at-all' });
  assert.equal(r.decision, 'routed');
  assert.equal(r.selected_agent_slug, S.RESEARCH);
});

function readSourceOf(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

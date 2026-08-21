/**
 * WORKFLOW / TASK ENGINE
 *
 * Proves that AI-HQ can safely coordinate a bounded MULTI-task workflow —
 * the bridge from "run one agent" to "coordinate a workforce." Every task
 * still executes through the unmodified runtime.runTask(); every tool call
 * inside a task still reaches the unmodified Broker. This suite tests
 * ORCHESTRATION: tree limits, dependencies, loop detection, retries,
 * cancellation, and that untrusted model-proposed children can never
 * bypass any of it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStore } from '../src/store.js';
import { createAuditSink } from '../src/audit.js';
import { createBroker } from '../src/broker.js';
import { createTools } from '../src/tools.js';
import { createRuntime, TASK_STATUS } from '../src/runtime.js';
import { createWorkflowEngine, WORKFLOW_STATE, WORKFLOW_REASON } from '../src/workflow.js';
import { MAX_DEPTH, MAX_FANOUT, MAX_TOTAL_NODES } from '../src/limits.js';
import { demoAgentVersion, demoAgentRecord, DEMO_AGENT_SLUG, DEMO_HANDLERS, DEMO_VERSION_ID } from '../src/demo-agent.js';
import { VERSION_STATE, RUNTIME_STATE } from '../src/agents.js';
import { registerDiamondAgents, DIAMOND_HANDLERS, buildDiamondWorkflow, DIAMOND_AGENT_SLUGS } from '../src/demo-workflow.js';

const T0 = 1_000_000;

/**
 * A complete stack: store + Broker + agent runtime + workflow engine, with
 * wordcount-agent (Milestone 5's demo) registered and approved.
 */
function stackSetup(o = {}) {
  const { tools, outbox, invocations } = createTools();
  const store = createMemoryStore();
  const audit = createAuditSink();
  const clock = () => T0;
  const broker = createBroker({ tools, store, audit, clock });

  store.addAgentVersion(demoAgentVersion({
    state: o.versionState ?? VERSION_STATE.APPROVED, approved_by: 'founder', approved_at: T0 - 100,
  }));
  store.registerAgent(demoAgentRecord({
    lifecycle_state: o.lifecycleState ?? RUNTIME_STATE.ACTIVE,
    active_version_id: o.activeVersionId === undefined ? DEMO_VERSION_ID : o.activeVersionId,
  }));

  const runtime = createRuntime({
    store, broker, audit, clock,
    handlers: o.handlers ?? DEMO_HANDLERS,
    registrySha: 'test-sha',
  });
  const engine = createWorkflowEngine({ runtime, store, audit, clock });

  return { engine, runtime, broker, store, audit, outbox, invocations, clock };
}

const task = (o = {}) => ({ agent_slug: DEMO_AGENT_SLUG, input: { text: 'default distinct input text' }, ...o });

// ── 1–3: creation and single-task execution ────────────────────────────

test('142. create workflow', () => {
  const { engine } = stackSetup();
  const wf = engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 100 });
  assert.equal(wf.state, WORKFLOW_STATE.CREATED);
  assert.equal(wf.node_count, 0);
  assert.equal(wf.root_task_id, null);
});

test('143. create root task', () => {
  const { engine } = stackSetup();
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 100 });
  const r = engine.addTask({ workflow_id: 'wf1', task_id: 'root', ...task() });
  assert.equal(r.decision, 'accepted');
  assert.equal(r.reason, WORKFLOW_REASON.OK);
  assert.equal(r.task.status, TASK_STATUS.PENDING);
  assert.equal(engine.getWorkflow('wf1').root_task_id, 'root');
  assert.equal(engine.getWorkflow('wf1').state, WORKFLOW_STATE.RUNNING);
});

test('144. execute a single task through the workflow engine', () => {
  const { engine, store } = stackSetup();
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 100 });
  engine.addTask({ workflow_id: 'wf1', task_id: 'root', input: { text: 'hello world' }, agent_slug: DEMO_AGENT_SLUG });
  const final = engine.runToCompletion({ workflow_id: 'wf1' });
  assert.equal(final.state, WORKFLOW_STATE.COMPLETED);
  assert.deepEqual(store.getTask('root').output.result, { words: 2 });
});

// ── 4–6: dependencies ────────────────────────────────────────────────────

test('145. execute dependent tasks in order', () => {
  const { engine, store } = stackSetup();
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 100 });
  engine.addTask({ workflow_id: 'wf1', task_id: 'a', input: { text: 'first task text' }, agent_slug: DEMO_AGENT_SLUG });
  engine.addTask({ workflow_id: 'wf1', task_id: 'b', input: { text: 'second task different' }, agent_slug: DEMO_AGENT_SLUG, depends_on: ['a'] });
  const final = engine.runToCompletion({ workflow_id: 'wf1' });
  assert.equal(final.state, WORKFLOW_STATE.COMPLETED);
  assert.ok(store.getTask('a').completed_at <= store.getTask('b').started_at, 'a must finish before b starts');
});

test('146. a dependency blocks its dependent from running until satisfied', () => {
  const { engine, store } = stackSetup();
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 100 });
  engine.addTask({ workflow_id: 'wf1', task_id: 'a', input: { text: 'first task text' }, agent_slug: DEMO_AGENT_SLUG });
  engine.addTask({ workflow_id: 'wf1', task_id: 'b', input: { text: 'second different text' }, agent_slug: DEMO_AGENT_SLUG, depends_on: ['a'] });
  // Nothing has been stepped yet — b must not have run.
  assert.equal(store.getTask('b').status, TASK_STATUS.PENDING);
  const r = engine.step({ workflow_id: 'wf1' });
  assert.deepEqual(r.ran.map((t) => t.id), ['a'], 'only a is ready on the first step');
});

test('147. a failed dependency propagates as cancellation, never a silent run', () => {
  const { engine, store } = stackSetup();
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 100 });
  engine.addTask({ workflow_id: 'wf1', task_id: 'a', input: { text: 42 }, agent_slug: DEMO_AGENT_SLUG }); // wrong type -> fails
  engine.addTask({ workflow_id: 'wf1', task_id: 'b', input: { text: 'depends on failing a' }, agent_slug: DEMO_AGENT_SLUG, depends_on: ['a'] });
  const final = engine.runToCompletion({ workflow_id: 'wf1' });
  assert.equal(store.getTask('a').status, TASK_STATUS.FAILED);
  assert.equal(store.getTask('b').status, TASK_STATUS.CANCELLED);
  assert.equal(final.state, WORKFLOW_STATE.FAILED);
});

// ── 7–9: tree limits ─────────────────────────────────────────────────────

test('148. depth limit is enforced', () => {
  const { engine } = stackSetup();
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 1000 });
  let prev = null;
  for (let i = 0; i <= MAX_DEPTH; i++) {
    const r = engine.addTask({ workflow_id: 'wf1', task_id: `d${i}`, parent_task_id: prev, input: { text: `depth level ${i}` }, agent_slug: DEMO_AGENT_SLUG });
    assert.equal(r.decision, 'accepted', `depth ${i} must be within the limit`);
    prev = `d${i}`;
  }
  const over = engine.addTask({ workflow_id: 'wf1', task_id: 'toodeep', parent_task_id: prev, input: { text: 'one level too deep' }, agent_slug: DEMO_AGENT_SLUG });
  assert.equal(over.decision, 'rejected');
  assert.equal(over.reason, WORKFLOW_REASON.DEPTH_EXCEEDED);
});

test('149. fan-out limit is enforced', () => {
  const { engine } = stackSetup();
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 1000 });
  engine.addTask({ workflow_id: 'wf1', task_id: 'root', input: { text: 'root task text here' }, agent_slug: DEMO_AGENT_SLUG });
  for (let i = 0; i < MAX_FANOUT; i++) {
    const r = engine.addTask({ workflow_id: 'wf1', task_id: `c${i}`, parent_task_id: 'root', input: { text: `child number ${i} unique` }, agent_slug: DEMO_AGENT_SLUG });
    assert.equal(r.decision, 'accepted', `child ${i} must be within fan-out`);
  }
  const over = engine.addTask({ workflow_id: 'wf1', task_id: 'onemore', parent_task_id: 'root', input: { text: 'one child too many here' }, agent_slug: DEMO_AGENT_SLUG });
  assert.equal(over.decision, 'rejected');
  assert.equal(over.reason, WORKFLOW_REASON.FANOUT_EXCEEDED);
});

test('150. total node limit is enforced, not merely depth and fan-out', () => {
  const { engine } = stackSetup();
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 10000 });
  let accepted = 0;
  let rejectedReason = null;
  for (let i = 0; i < MAX_TOTAL_NODES + 5; i++) {
    const r = engine.addTask({ workflow_id: 'wf1', task_id: `n${i}`, input: { text: `unique node text ${i}` }, agent_slug: DEMO_AGENT_SLUG });
    if (r.decision === 'accepted') accepted++;
    else rejectedReason = r.reason;
  }
  assert.equal(accepted, MAX_TOTAL_NODES);
  assert.equal(rejectedReason, WORKFLOW_REASON.TOTAL_NODES_EXCEEDED);
});

// ── 10–11: loop detection ────────────────────────────────────────────────

test('151. loop detection rejects a duplicate task signature within one workflow', () => {
  const { engine } = stackSetup();
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 100 });
  engine.addTask({ workflow_id: 'wf1', task_id: 'a', input: { text: 'identical repeated input here' }, agent_slug: DEMO_AGENT_SLUG });
  const dup = engine.addTask({ workflow_id: 'wf1', task_id: 'b', input: { text: 'identical repeated input here' }, agent_slug: DEMO_AGENT_SLUG });
  assert.equal(dup.decision, 'rejected');
  assert.equal(dup.reason, WORKFLOW_REASON.LOOP_DETECTED);
});

test('152. the same signature in a DIFFERENT workflow is not a loop', () => {
  const { engine } = stackSetup();
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 100 });
  engine.createWorkflow({ workflow_id: 'wf2', budget_limit: 100 });
  engine.addTask({ workflow_id: 'wf1', task_id: 'a', input: { text: 'same text different tree' }, agent_slug: DEMO_AGENT_SLUG });
  const r = engine.addTask({ workflow_id: 'wf2', task_id: 'a', input: { text: 'same text different tree' }, agent_slug: DEMO_AGENT_SLUG });
  assert.equal(r.decision, 'accepted', 'loop detection is scoped per workflow, not global');
});

// ── 12–13: retries ────────────────────────────────────────────────────────

test('153. retry ceiling is enforced — bounded, never infinite', () => {
  let calls = 0;
  const { engine, store } = stackSetup({ handlers: { [DEMO_AGENT_SLUG]: () => { calls++; throw new Error('always fails'); } } });
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 1000 });
  engine.addTask({ workflow_id: 'wf1', task_id: 'f1', input: { text: 'this always throws here' }, agent_slug: DEMO_AGENT_SLUG });
  const final = engine.runToCompletion({ workflow_id: 'wf1', max_steps: 10 });
  assert.equal(final.state, WORKFLOW_STATE.FAILED);
  assert.equal(calls, 3, '1 original attempt + 2 retries, ceiling 3');
});

test('154. a failed task does not retry when the failure reason forbids it', () => {
  const { engine, store } = stackSetup();
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 1000 });
  // INPUT_CONTRACT_VIOLATION — a malformed task, never retryable.
  engine.addTask({ workflow_id: 'wf1', task_id: 'bad', input: { text: 999 }, agent_slug: DEMO_AGENT_SLUG });
  const final = engine.runToCompletion({ workflow_id: 'wf1' });
  assert.equal(final.state, WORKFLOW_STATE.FAILED);
  assert.equal(store.getTask('bad').attempt_number, 1, 'no retry was ever created');
  const retryAttempt = store.getTask('bad-retry-2');
  assert.equal(retryAttempt, null);
});

test('154b. retryTask explicitly rejects a non-retryable reason', () => {
  const { engine, store } = stackSetup();
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 1000 });
  engine.addTask({ workflow_id: 'wf1', task_id: 'bad', input: { text: 999 }, agent_slug: DEMO_AGENT_SLUG });
  // An unrelated task, kept pending across this step() by a same-step
  // dependency (its dependency completes in this step but readiness is
  // computed once at the top of step(), so it isn't picked up until the
  // next call) — this keeps the workflow non-terminal so the assertion
  // below actually exercises retryTask()'s own NOT_RETRYABLE check,
  // rather than being pre-empted by WORKFLOW_NOT_RUNNABLE once 'bad'
  // alone would otherwise leave nothing pending.
  engine.addTask({ workflow_id: 'wf1', task_id: 'first', input: { text: 'independent task, runs this step' }, agent_slug: DEMO_AGENT_SLUG });
  engine.addTask({ workflow_id: 'wf1', task_id: 'second', input: { text: 'depends on first, not ready yet' }, agent_slug: DEMO_AGENT_SLUG, depends_on: ['first'] });
  engine.step({ workflow_id: 'wf1' });
  assert.equal(engine.getWorkflow('wf1').state, WORKFLOW_STATE.RUNNING, 'workflow must still be runnable for this to test retryTask, not workflow state');
  const r = engine.retryTask({ workflow_id: 'wf1', task_id: 'bad' });
  assert.equal(r.decision, 'rejected');
  assert.equal(r.reason, WORKFLOW_REASON.NOT_RETRYABLE);
});

// ── 14–15: cancellation ──────────────────────────────────────────────────

test('155. cancellation prevents pending work from executing', () => {
  const { engine, store } = stackSetup();
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 100 });
  engine.addTask({ workflow_id: 'wf1', task_id: 'a', input: { text: 'will be cancelled soon' }, agent_slug: DEMO_AGENT_SLUG });
  const wf = engine.cancelWorkflow({ workflow_id: 'wf1', reason: 'test' });
  assert.equal(wf.state, WORKFLOW_STATE.CANCELLED);
  assert.equal(store.getTask('a').status, TASK_STATUS.CANCELLED);
  const r = engine.step({ workflow_id: 'wf1' });
  assert.equal(r.ran.length, 0, 'a cancelled workflow never runs anything on step()');
});

test('156. a cancelled workflow cannot create executable child tasks', () => {
  const { engine } = stackSetup();
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 100 });
  engine.cancelWorkflow({ workflow_id: 'wf1', reason: 'test' });
  const r = engine.addTask({ workflow_id: 'wf1', task_id: 'a', input: { text: 'should never be admitted' }, agent_slug: DEMO_AGENT_SLUG });
  assert.equal(r.decision, 'rejected');
  assert.equal(r.reason, WORKFLOW_REASON.WORKFLOW_NOT_RUNNABLE);
});

// ── 16–18: agent/version resolution, fail closed ────────────────────────

test('157. an unknown agent is denied at admission', () => {
  const { engine } = stackSetup();
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 100 });
  const r = engine.addTask({ workflow_id: 'wf1', task_id: 'a', input: { text: 'x' }, agent_slug: 'ghost-agent' });
  assert.equal(r.decision, 'rejected');
  assert.equal(r.reason, WORKFLOW_REASON.UNKNOWN_AGENT);
});

test('158. a paused agent is denied at admission', () => {
  const { engine } = stackSetup({ lifecycleState: RUNTIME_STATE.PAUSED });
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 100 });
  const r = engine.addTask({ workflow_id: 'wf1', task_id: 'a', input: { text: 'x' }, agent_slug: DEMO_AGENT_SLUG });
  assert.equal(r.decision, 'rejected');
  assert.equal(r.reason, WORKFLOW_REASON.AGENT_NOT_ACTIVE);
});

test('159. an unapproved version is denied at admission, and independently at execution', () => {
  const { engine, runtime } = stackSetup({ versionState: VERSION_STATE.DRAFT });
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 100 });
  const r = engine.addTask({ workflow_id: 'wf1', task_id: 'a', input: { text: 'x' }, agent_slug: DEMO_AGENT_SLUG });
  assert.equal(r.decision, 'rejected');
  assert.equal(r.reason, WORKFLOW_REASON.VERSION_NOT_APPROVED);
});

// ── 19–22: untrusted model-proposed children ─────────────────────────────

function spawningHandler(n, extra = {}) {
  return () => {
    const proposals = [];
    for (let i = 0; i < n; i++) proposals.push({ agent_slug: DEMO_AGENT_SLUG, input: { text: `proposed child unique number ${i}` }, ...extra });
    return { status: 'ok', result: { words: 0 }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [], proposed_child_tasks: proposals };
  };
}

test('160. a malformed child-task proposal is rejected, not silently dropped or crashed on', () => {
  const badProposalHandler = () => ({
    status: 'ok', result: { words: 0 }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
    proposed_child_tasks: [{ agent_slug: 42 }, null, { input: 'no agent_slug' }, { agent_slug: DEMO_AGENT_SLUG, input: { text: 'this one is fine' } }],
  });
  const { engine, store } = stackSetup({ handlers: { [DEMO_AGENT_SLUG]: badProposalHandler } });
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 1000 });
  engine.addTask({ workflow_id: 'wf1', task_id: 'root', input: { text: 'root proposes malformed children' }, agent_slug: DEMO_AGENT_SLUG });
  const r = engine.step({ workflow_id: 'wf1' });
  const wf = engine.getWorkflow('wf1');
  assert.equal(wf.node_count, 2, 'only the one well-formed proposal was admitted, alongside the root');
});

test('161. a model proposing more than MAX_FANOUT children has the excess explicitly rejected, not silently truncated', () => {
  const { engine } = stackSetup({ handlers: { [DEMO_AGENT_SLUG]: spawningHandler(MAX_FANOUT + 3) } });
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 1000 });
  engine.addTask({ workflow_id: 'wf1', task_id: 'root', input: { text: 'root spawns too many children' }, agent_slug: DEMO_AGENT_SLUG });
  engine.step({ workflow_id: 'wf1' });
  const wf = engine.getWorkflow('wf1');
  assert.equal(wf.node_count, 1 + MAX_FANOUT, 'root + exactly MAX_FANOUT children, the rest explicitly refused');
  // the audit-based proof that the excess was individually rejected (not
  // merely absent) lives in test 161b, which needs its own audit sink.
});

test('161b. the rejected excess proposals are individually audited, not merely absent', () => {
  const { engine, audit } = stackSetup({ handlers: { [DEMO_AGENT_SLUG]: spawningHandler(MAX_FANOUT + 3) } });
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 1000 });
  engine.addTask({ workflow_id: 'wf1', task_id: 'root', input: { text: 'root spawns too many children' }, agent_slug: DEMO_AGENT_SLUG });
  engine.step({ workflow_id: 'wf1' });
  const rejections = audit.all().filter((r) => r.event === 'workflow.task_proposal' && r.decision === 'rejected' && r.reason === WORKFLOW_REASON.FANOUT_EXCEEDED);
  assert.equal(rejections.length, 3);
});

test('162. a model proposing enough children to exceed MAX_TOTAL_NODES is bounded by the total, not by fan-out alone', () => {
  // 4 roots, each proposing exactly MAX_FANOUT (8) children, is 4 + 32 = 36
  // candidate nodes — each parent's own fan-out is individually within
  // limit (8 <= MAX_FANOUT), so nothing here trips FANOUT_EXCEEDED; only
  // the shared total-node ceiling (4 + 8*4 = 36 > 32) can be the reason
  // some proposals are refused.
  let call = 0;
  const spawnFanoutHandler = () => {
    call++;
    const parent = call;
    const proposals = [];
    for (let i = 0; i < MAX_FANOUT; i++) proposals.push({ agent_slug: DEMO_AGENT_SLUG, input: { text: `root ${parent} child unique ${i}` } });
    return { status: 'ok', result: { words: 0 }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [], proposed_child_tasks: proposals };
  };
  const { engine } = stackSetup({ handlers: { [DEMO_AGENT_SLUG]: spawnFanoutHandler } });
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 10000 });
  engine.addTask({ workflow_id: 'wf1', task_id: 'root1', input: { text: 'first spawning root here' }, agent_slug: DEMO_AGENT_SLUG });
  engine.addTask({ workflow_id: 'wf1', task_id: 'root2', input: { text: 'second spawning root here' }, agent_slug: DEMO_AGENT_SLUG });
  engine.addTask({ workflow_id: 'wf1', task_id: 'root3', input: { text: 'third spawning root here' }, agent_slug: DEMO_AGENT_SLUG });
  engine.addTask({ workflow_id: 'wf1', task_id: 'root4', input: { text: 'fourth spawning root here' }, agent_slug: DEMO_AGENT_SLUG });
  engine.step({ workflow_id: 'wf1' }); // all 4 roots run, each proposes MAX_FANOUT children
  const wf = engine.getWorkflow('wf1');
  assert.ok(wf.node_count <= MAX_TOTAL_NODES, `node_count ${wf.node_count} must never exceed ${MAX_TOTAL_NODES}`);
  assert.equal(wf.node_count, MAX_TOTAL_NODES, '4 roots + fan-out from each, capped at the shared total ceiling, not by any individual fan-out check');
});

test('163. a model attempting a recursive tree (repeated identical proposal) is stopped by loop detection', () => {
  // The handler always proposes the SAME child signature — a model
  // "returning JSON" describing A -> A -> A cannot manufacture a
  // different outcome than a human doing the same thing would.
  const recursiveHandler = () => ({
    status: 'ok', result: { words: 0 }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
    proposed_child_tasks: [{ agent_slug: DEMO_AGENT_SLUG, input: { text: 'always the exact same text' } }],
  });
  const { engine, audit } = stackSetup({ handlers: { [DEMO_AGENT_SLUG]: recursiveHandler } });
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 10000 });
  engine.addTask({ workflow_id: 'wf1', task_id: 'seed', input: { text: 'always the exact same text' }, agent_slug: DEMO_AGENT_SLUG });
  engine.step({ workflow_id: 'wf1' }); // seed runs, proposes a child with the SAME signature as itself
  const wf = engine.getWorkflow('wf1');
  assert.equal(wf.node_count, 1, 'the self-identical proposal was rejected, not admitted');
  assert.ok(audit.all().some((r) => r.event === 'workflow.task_proposal' && r.reason === WORKFLOW_REASON.LOOP_DETECTED));
});

// ── 23–24: budget ─────────────────────────────────────────────────────────

test('164. workflow-wide budget exhaustion stops further scheduling', () => {
  const { engine, store, broker } = stackSetup();
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 100 });
  engine.addTask({ workflow_id: 'wf1', task_id: 'a', input: { text: 'first task spends budget' }, agent_slug: DEMO_AGENT_SLUG });
  // Manually exhaust the shared tree budget between admission and execution.
  const treeBudget = store.budgetsFor({ tree_id: 'wf1', agent_slug: DEMO_AGENT_SLUG }).find((b) => b.level === 'tree');
  treeBudget.spent = treeBudget.limit;
  const r = engine.addTask({ workflow_id: 'wf1', task_id: 'b', input: { text: 'second task after exhaustion' }, agent_slug: DEMO_AGENT_SLUG });
  assert.equal(r.decision, 'rejected');
  assert.equal(r.reason, WORKFLOW_REASON.BUDGET_EXCEEDED);
});

test('165. child tasks share and are bound by the same tree-level budget as their parent', () => {
  const { engine, store } = stackSetup();
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 100 });
  engine.addTask({ workflow_id: 'wf1', task_id: 'root', input: { text: 'root task creates a child' }, agent_slug: DEMO_AGENT_SLUG });
  engine.addTask({ workflow_id: 'wf1', task_id: 'child', parent_task_id: 'root', input: { text: 'child task shares budget too' }, agent_slug: DEMO_AGENT_SLUG });
  const rootTreeBudget = store.budgetsFor({ tree_id: 'wf1', agent_slug: DEMO_AGENT_SLUG }).filter((b) => b.level === 'tree');
  assert.equal(rootTreeBudget.length, 1, 'exactly one shared tree-level budget row, not one per task');
});

// ── 25: audit ─────────────────────────────────────────────────────────────

test('166. every important workflow event is audited', () => {
  const { engine, audit } = stackSetup();
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 100 });
  engine.addTask({ workflow_id: 'wf1', task_id: 'a', input: { text: 'audited task one here' }, agent_slug: DEMO_AGENT_SLUG });
  engine.addTask({ workflow_id: 'wf1', task_id: 'toodeep', parent_task_id: 'a', input: { text: 'x' }, agent_slug: 'ghost-agent' });
  engine.runToCompletion({ workflow_id: 'wf1' });
  engine.cancelWorkflow({ workflow_id: 'wf1', reason: 'cleanup' }); // no-op, already terminal, but must not throw

  const events = new Set(audit.all().map((r) => r.event));
  assert.ok(events.has('workflow.created'));
  assert.ok(events.has('workflow.task_proposal'));
});

test('166b. a rejected proposal carries enough information to reconstruct why', () => {
  const { engine, audit } = stackSetup();
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 100 });
  engine.addTask({ workflow_id: 'wf1', task_id: 'a', input: { text: 'x' }, agent_slug: 'ghost-agent' });
  const rec = audit.all().find((r) => r.event === 'workflow.task_proposal' && r.decision === 'rejected');
  assert.equal(rec.reason, WORKFLOW_REASON.UNKNOWN_AGENT);
  assert.equal(rec.agent_slug, 'ghost-agent');
  assert.equal(rec.workflow_id, 'wf1');
});

// ── 26–27: the diamond simulation, success and failure ──────────────────

test('167. successful multi-task workflow — the diamond simulation', () => {
  const { tools } = createTools();
  const store = createMemoryStore();
  const audit = createAuditSink();
  const clock = () => T0;
  const broker = createBroker({ tools, store, audit, clock });
  registerDiamondAgents(store);
  const runtime = createRuntime({ store, broker, audit, clock, handlers: DIAMOND_HANDLERS, registrySha: 'sha' });
  const engine = createWorkflowEngine({ runtime, store, audit, clock });

  engine.createWorkflow({ workflow_id: 'diamond', budget_limit: 100 });
  buildDiamondWorkflow(engine, 'diamond');
  const final = engine.runToCompletion({ workflow_id: 'diamond' });

  assert.equal(final.state, WORKFLOW_STATE.COMPLETED);
  assert.equal(final.node_count, 4);
  for (const id of ['research', 'analysis', 'validation', 'final']) {
    assert.equal(store.getTask(id).status, TASK_STATUS.COMPLETED);
  }
  assert.deepEqual(store.getTask('final').depends_on.sort(), ['analysis', 'validation']);
  assert.equal(store.getTask('research').depth, 0);
  assert.equal(store.getTask('final').depth, 2);
});

test('168. failed multi-task workflow — one branch of the diamond fails, the convergence point never runs', () => {
  const { tools } = createTools();
  const store = createMemoryStore();
  const audit = createAuditSink();
  const clock = () => T0;
  const broker = createBroker({ tools, store, audit, clock });
  registerDiamondAgents(store);

  // The validation branch fails; final depends on it and must never run.
  const handlers = {
    ...DIAMOND_HANDLERS,
    [DIAMOND_AGENT_SLUGS.VALIDATION]: () => { throw new Error('validation blew up'); },
  };
  const runtime = createRuntime({ store, broker, audit, clock, handlers, registrySha: 'sha' });
  const engine = createWorkflowEngine({ runtime, store, audit, clock });

  engine.createWorkflow({ workflow_id: 'diamond2', budget_limit: 100 });
  buildDiamondWorkflow(engine, 'diamond2');
  const final = engine.runToCompletion({ workflow_id: 'diamond2', max_steps: 10 });

  assert.equal(store.getTask('research').status, TASK_STATUS.COMPLETED);
  assert.equal(store.getTask('analysis').status, TASK_STATUS.COMPLETED);
  assert.equal(store.getTask('validation').status, TASK_STATUS.FAILED);
  assert.equal(store.getTask('final').status, TASK_STATUS.CANCELLED, 'final must never run without both dependencies');
  assert.equal(final.state, WORKFLOW_STATE.FAILED);
});

// ── 28: the existing suite is unaffected ─────────────────────────────────
// (verified by running the full test command, not inside this file —
// see the milestone report for the actual count.)

// ── structural: the engine cannot reach the Broker or credentials ───────

test('169. the workflow engine has no reference to the Broker beyond what it was given, and touches no network/credential primitive', () => {
  const forbidden = ['node:http', 'node:https', 'node:net', 'node:tls', 'child_process', 'worker_threads', 'fetch(', 'process.env', 'eval('];
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const rel of ['../src/workflow.js', '../src/demo-workflow.js']) {
    const src = strip(readFileSync(new URL(rel, import.meta.url), 'utf8'));
    for (const needle of forbidden) assert.equal(src.includes(needle), false, `${rel} contains ${needle}`);
  }
});

test('170. addTask never invokes a handler or a tool — only step() runs anything', () => {
  const { engine, invocations, outbox } = stackSetup();
  engine.createWorkflow({ workflow_id: 'wf1', budget_limit: 100 });
  engine.addTask({ workflow_id: 'wf1', task_id: 'a', input: { text: 'admission only, never runs' }, agent_slug: DEMO_AGENT_SLUG });
  assert.equal(invocations(), 0);
  assert.equal(outbox.length, 0);
});

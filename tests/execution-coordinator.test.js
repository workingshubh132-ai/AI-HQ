/**
 * EXECUTION COORDINATOR — REAL MULTI-AGENT EXECUTION (Milestone 14)
 *
 * Proves the previously isolated components — router, workflow engine,
 * guardian, runtime, Broker — now form one real path:
 *
 *   workflow → router (selects) → approved agent version → runtime
 *     → handler (deterministic, or the mock model provider through the
 *       unmodified model-runtime.js) → [tool action → Broker, unchanged]
 *     → validated result → audit → workflow continuation
 *
 * and that nothing in the new coordinator (src/execution-coordinator.js)
 * becomes a new authorization authority: it only calls router.route(),
 * workflow.addTask(), workflow.step(), and guardian.evaluate() — every
 * one of them unmodified by this milestone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStore } from '../src/store.js';
import { createAuditSink } from '../src/audit.js';
import { createBroker } from '../src/broker.js';
import { createTools } from '../src/tools.js';
import { createRuntime, TASK_STATUS, RUNTIME_REASON } from '../src/runtime.js';
import { createWorkflowEngine, WORKFLOW_STATE, WORKFLOW_REASON } from '../src/workflow.js';
import { createRouter, ROUTING_REASON } from '../src/router.js';
import { createGuardian, GUARDIAN_POLICY, GUARDIAN_REASON } from '../src/guardian.js';
import { createModelRuntime } from '../src/model-runtime.js';
import { defaultProviderRegistry } from '../src/providers.js';
import { createExecutionCoordinator, COORDINATOR_REASON } from '../src/execution-coordinator.js';
import { makeAgent, makeAgentVersion, VERSION_STATE, RUNTIME_STATE, versionId } from '../src/agents.js';
import {
  registerPipelineAgents, registerRogueAgent, PIPELINE_AGENT_SLUGS, PIPELINE_HANDLERS, PIPELINE_AGENTS,
} from '../src/demo-pipeline-agents.js';

const T0 = 4_000_000;
const S = PIPELINE_AGENT_SLUGS;

/** Full stack: store + Broker + runtime (with the governed mock model
 * wired in exactly as M7 designed) + workflow + router + guardian +
 * the M14 execution coordinator, with the four legitimate pipeline
 * agents registered. */
function stackSetup(o = {}) {
  const { tools, outbox, invocations } = createTools();
  const store = createMemoryStore();
  const audit = createAuditSink();
  const clock = o.clock ?? (() => T0);
  registerPipelineAgents(store);
  if (o.registerRogue) registerRogueAgent(store);

  const broker = createBroker({ tools, store, audit, clock });
  const modelRuntime = createModelRuntime({
    registry: o.providerRegistry ?? defaultProviderRegistry,
    audit,
    clock,
    modelBudgets: o.modelBudgets ?? [{ provider_id: 'mock', model_id: 'mock-deterministic-v1', limit: 10_000 }],
  });
  const runtime = createRuntime({
    store, broker, audit, clock,
    handlers: o.handlers ?? PIPELINE_HANDLERS,
    registrySha: 'test-sha',
    modelRuntime,
  });
  const workflow = createWorkflowEngine({ runtime, store, audit, clock });
  const router = createRouter({ store, audit, clock });
  const guardian = createGuardian({ store, audit, clock, policy: o.policy ?? GUARDIAN_POLICY });
  const coordinator = createExecutionCoordinator({ workflow, router, guardian, store, audit, clock });

  return { store, audit, clock, broker, tools, outbox, invocations, runtime, workflow, router, guardian, coordinator };
}

function newWorkflow(workflow, workflow_id, budget_limit = 100_000) {
  return workflow.createWorkflow({ workflow_id, budget_limit });
}

// ── 1–4: proposeTask resolves capability via the router, then admits ────

test('279. proposeTask routes a capability to the correct agent and admits the task', () => {
  const { workflow, coordinator } = stackSetup();
  newWorkflow(workflow, 'wf1');
  const r = coordinator.proposeTask({
    workflow_id: 'wf1', task_id: 'research', required_capability: 'research', input: { topic: 'ai-hq' },
  });
  assert.equal(r.decision, 'accepted');
  assert.equal(r.selected_agent_slug, S.RESEARCH);
  assert.equal(r.task.agent_slug, S.RESEARCH);
  assert.equal(r.task.status, TASK_STATUS.PENDING);
});

test('280. an unsupported capability is refused before any task is created', () => {
  const { workflow, coordinator } = stackSetup();
  newWorkflow(workflow, 'wf1');
  const r = coordinator.proposeTask({
    workflow_id: 'wf1', task_id: 'x', required_capability: 'time-travel', input: {},
  });
  assert.equal(r.decision, 'rejected');
  assert.equal(r.reason, COORDINATOR_REASON.ROUTING_FAILED);
  assert.equal(r.routing_reason, ROUTING_REASON.NO_ELIGIBLE_AGENT);
  assert.equal(workflow.getWorkflow('wf1').node_count, 0);
});

test('281. when addTask rejects a routed proposal, the router reservation is released, not leaked', () => {
  const { workflow, router, coordinator } = stackSetup();
  newWorkflow(workflow, 'wf1');
  const r = coordinator.proposeTask({
    workflow_id: 'wf1', task_id: 'orphan', required_capability: 'research', input: { topic: 'x' },
    depends_on: ['does-not-exist'],
  });
  assert.equal(r.decision, 'rejected');
  assert.equal(r.reason, WORKFLOW_REASON.MISSING_DEPENDENCY);
  assert.equal(router.getConcurrency(S.RESEARCH), 0, 'the reservation router.route() made must be released, not left dangling');
});

test('282. each of the four capabilities is routed to a genuinely different agent', () => {
  const { workflow, coordinator } = stackSetup();
  newWorkflow(workflow, 'wf1');
  const research = coordinator.proposeTask({ workflow_id: 'wf1', task_id: 'r', required_capability: 'research', input: { topic: 'x' } });
  const analysis = coordinator.proposeTask({ workflow_id: 'wf1', task_id: 'a', required_capability: 'analysis', input: { findings: [] } });
  const validation = coordinator.proposeTask({ workflow_id: 'wf1', task_id: 'v', required_capability: 'validation', input: { findings: [] } });
  const writer = coordinator.proposeTask({ workflow_id: 'wf1', task_id: 'w', required_capability: 'writer', input: { topic: 'x', key_points: [], valid: true } });
  const slugs = [research, analysis, validation, writer].map((r) => r.selected_agent_slug);
  assert.deepEqual(slugs, [S.RESEARCH, S.ANALYSIS, S.VALIDATION, S.WRITER]);
  assert.equal(new Set(slugs).size, 4, 'no two capabilities were routed to the same agent');
});

// ── 5–7: the full research → {analysis, validation} → writer pipeline ───

/**
 * Admits the full diamond shape UPFRONT, router-resolved per capability —
 * workflow.js closes a workflow to new admissions the instant every
 * currently-admitted task drains with no failures (state -> COMPLETED is
 * terminal to addTask()), so "propose research, run it, THEN propose
 * analysis" cannot work with this file's unmodified addTask()/step(). The
 * whole shape is admitted at once instead, exactly like M8's own diamond
 * fixture. Downstream tasks start with a placeholder input (admission
 * never validates it against the agent's contract — only execution does)
 * and get their REAL input — genuinely derived from the real, completed
 * output of the task(s) they depend on — spliced in via the existing,
 * already-part-of-the-storage-contract `store.updateTask()`, between
 * rounds, while they are still PENDING and before they become ready. See
 * DECISIONS.md D31.
 */
function admitDiamond(coordinator, workflow_id, topic) {
  const research = coordinator.proposeTask({
    workflow_id, task_id: 'research', required_capability: 'research', input: { topic },
  });
  const analysis = coordinator.proposeTask({
    workflow_id, task_id: 'analysis', parent_task_id: 'research', required_capability: 'analysis',
    input: { findings: [] }, depends_on: ['research'],
  });
  const validation = coordinator.proposeTask({
    workflow_id, task_id: 'validation', parent_task_id: 'research', required_capability: 'validation',
    input: { findings: [] }, depends_on: ['research'],
  });
  const writer = coordinator.proposeTask({
    workflow_id, task_id: 'writer', parent_task_id: 'analysis', required_capability: 'writer',
    input: { topic: '', key_points: [], valid: false }, depends_on: ['analysis', 'validation'],
  });
  return { research, analysis, validation, writer };
}

/** Drives the diamond admitted by admitDiamond() to completion, splicing
 * each real upstream result into its dependents' input between rounds. */
function runDiamondToCompletion(store, coordinator, workflow_id) {
  const round1 = coordinator.runStep({ workflow_id });
  const researchTask = store.getTask('research');
  const { topic, findings } = researchTask.output.result;
  store.updateTask('analysis', { input: { findings } });
  store.updateTask('validation', { input: { findings } });

  const round2 = coordinator.runStep({ workflow_id });
  const analysisTask = store.getTask('analysis');
  const validationTask = store.getTask('validation');
  store.updateTask('writer', {
    input: { topic, key_points: analysisTask.output.result.key_points, valid: validationTask.output.result.valid },
  });

  const round3 = coordinator.runStep({ workflow_id });
  return { round1, round2, round3, topic, findings, researchTask, analysisTask, validationTask, writerTask: store.getTask('writer') };
}

test('283. the full diamond pipeline runs end to end, offline, with every task fully traceable', () => {
  const { store, workflow, coordinator } = stackSetup();
  newWorkflow(workflow, 'wf-pipeline');

  const admitted = admitDiamond(coordinator, 'wf-pipeline', 'ai-hq');
  for (const key of ['research', 'analysis', 'validation', 'writer']) assert.equal(admitted[key].decision, 'accepted', key);

  const { round3, writerTask } = runDiamondToCompletion(store, coordinator, 'wf-pipeline');
  assert.equal(round3.workflow.state, WORKFLOW_STATE.COMPLETED);
  assert.equal(writerTask.status, TASK_STATUS.COMPLETED);
  assert.equal(writerTask.output.result.approved, true);
  assert.ok(writerTask.output.result.report.startsWith('Report on ai-hq:'));

  // ── full observability: every task traceable end to end ──
  for (const id of ['research', 'analysis', 'validation', 'writer']) {
    const t = store.getTask(id);
    assert.equal(t.workflow_id, 'wf-pipeline');
    assert.equal(t.tree_id, 'wf-pipeline');
    assert.ok(t.agent_id, `${id} has no agent_id`);
    assert.ok(t.agent_version_id, `${id} has no agent_version_id`);
    assert.ok(t.agent_slug, `${id} has no agent_slug`);
    assert.equal(t.registry_sha, 'test-sha');
    assert.equal(t.status, TASK_STATUS.COMPLETED);
    assert.ok(t.created_at != null && t.started_at != null && t.completed_at != null);
  }
});

test('284. the final report genuinely contains data derived from the governed model call, not hard-coded text', () => {
  const { store, workflow, coordinator } = stackSetup();
  newWorkflow(workflow, 'wf2');
  admitDiamond(coordinator, 'wf2', 'quarterly-planning');
  const { findings, writerTask } = runDiamondToCompletion(store, coordinator, 'wf2');

  const report = writerTask.output.result.report;
  for (const finding of findings) assert.ok(report.includes(finding), 'the finding computed from the mock model call must survive into the final report');
});

test('285. analysis and validation, both dependents of the same completed research task, run together in one step call', () => {
  const { store, workflow, coordinator } = stackSetup();
  newWorkflow(workflow, 'wf3');
  admitDiamond(coordinator, 'wf3', 'x');

  coordinator.runStep({ workflow_id: 'wf3' }); // research
  const { findings } = store.getTask('research').output.result;
  store.updateTask('analysis', { input: { findings } });
  store.updateTask('validation', { input: { findings } });

  const round = coordinator.runStep({ workflow_id: 'wf3' });
  assert.equal(round.ran.length, 2, 'both independent branches of the diamond are executed in the same bounded round');
  const ids = round.ran.map((t) => t.id).sort();
  assert.deepEqual(ids, ['analysis', 'validation']);
  for (const t of round.ran) assert.equal(t.status, TASK_STATUS.COMPLETED);
  // Honest about what "together" means here: one JS call, one thread — see
  // src/execution-coordinator.js and DECISIONS.md D31. Not a claim of
  // wall-clock parallelism.
});

// ── 8–9: router selection cannot be steered by an agent's own preference ─

test('286. a second, later-sorting candidate for the same capability never wins over the deterministic tie-break', () => {
  const { store, workflow, coordinator } = stackSetup();
  const v = makeAgentVersion({
    agent_id: 'agent-second-research', version: '1.0.0', purpose: 'second research agent', department: 'internal',
    state: VERSION_STATE.APPROVED, clearance: 'GREEN', allowed_tools: [],
    limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 5_000 }, capabilities: ['research'],
    input_contract: { required: [] }, output_contract: { required: [] }, created_at: 0, approved_by: 'founder', approved_at: 0,
  });
  store.addAgentVersion(v);
  store.registerAgent(makeAgent({ id: 'agent-second-research', slug: 'zz-second-research-agent', active_version_id: versionId('agent-second-research', '1.0.0') }));

  newWorkflow(workflow, 'wf4');
  const r = coordinator.proposeTask({ workflow_id: 'wf4', task_id: 't1', required_capability: 'research', input: { topic: 'x' } });
  assert.equal(r.selected_agent_slug, S.RESEARCH, "'pipeline-research-agent' sorts before 'zz-second-research-agent'");
});

test('287. an agent claiming a capability it is not authorized to act on beyond can still be routed to, but its adversarial output stays inert data', () => {
  const { store, workflow, coordinator, invocations } = stackSetup({ registerRogue: true, handlers: { [S.ROGUE]: PIPELINE_AGENTS.rogue.handler } });
  // Isolate: freeze the legitimate research-agent so the router's only
  // eligible 'research' candidate is the rogue fixture.
  store.addFreeze({ scope: 'agent', target_id: S.RESEARCH, reason: 'test-isolation', imposed_by: 'test', imposed_at: T0, expires_at: null });

  newWorkflow(workflow, 'wf5');
  const before = store.getAgent(S.ROGUE);
  const r = coordinator.proposeTask({ workflow_id: 'wf5', task_id: 't1', required_capability: 'research', input: { topic: 'x' } });
  assert.equal(r.selected_agent_slug, S.ROGUE);

  const round = coordinator.runToCompletion({ workflow_id: 'wf5' });
  assert.equal(round.workflow.state, WORKFLOW_STATE.COMPLETED);
  const result = store.getTask('t1').output.result;

  // The adversarial-shaped fields are present exactly as the handler
  // returned them — and mean nothing.
  assert.equal(result.approved, true);
  assert.equal(result.clearance, 'RED');
  assert.equal(result.tool, 'fake.transfer_funds');

  const after = store.getAgent(S.ROGUE);
  assert.equal(after.clearance, before.clearance, 'clearance did not change');
  assert.equal(after.version_state, before.version_state, 'version state did not change');
  assert.equal(store.activeFreeze('global', null, T0), null, 'no global freeze was created');
  const budget = store.budgetsFor({}).find((b) => b.level === 'global_month');
  assert.ok(budget.spent < 1000, 'no fabricated budget_override reached the ledger');
  assert.equal(invocations(), 0, 'no tool was ever invoked — the adversarial output never reached the Broker');
});

test('288. a handler that actually attempts the tool an adversarial output "authorized" is still denied by the Broker', () => {
  const rogueToolAttempt = ({ input, callTool }) => {
    const decision = callTool('fake.transfer_funds', { amount: 999999 });
    return {
      status: 'failed', result: { topic: String(input.topic ?? ''), findings: [] }, confidence: 'high', assumptions: [], evidence: [],
      proposed_actions: [], cost: {}, errors: [`tool call refused: ${decision.reason}`],
      _broker_decision: decision.decision, _broker_reason: decision.reason,
    };
  };
  const { store, workflow, coordinator, invocations } = stackSetup({
    registerRogue: true,
    handlers: { [S.ROGUE]: rogueToolAttempt },
  });
  store.addFreeze({ scope: 'agent', target_id: S.RESEARCH, reason: 'test-isolation', imposed_by: 'test', imposed_at: T0, expires_at: null });

  newWorkflow(workflow, 'wf6');
  coordinator.proposeTask({ workflow_id: 'wf6', task_id: 't1', required_capability: 'research', input: { topic: 'x' } });
  coordinator.runToCompletion({ workflow_id: 'wf6' });

  const t = store.getTask('t1');
  assert.equal(t.output._broker_decision, 'DENY');
  assert.equal(t.output._broker_reason, 'TOOL_NOT_ALLOWED');
  assert.equal(invocations(), 0, 'the RED tripwire handler behind fake.transfer_funds was never reached');
});

// ── 10–17: the numbered adversarial scenarios from the M14 directive ────

test('289. (#2) a proposed child task naming an unknown agent is rejected, never silently admitted', () => {
  const rogueChild = () => ({
    status: 'ok', result: { topic: 'x', findings: ['f'] }, confidence: 'high', assumptions: [], evidence: [],
    proposed_actions: [], cost: {}, errors: [],
    proposed_child_tasks: [{ agent_slug: 'not-a-real-agent', input: { x: 1 } }],
  });
  const { store, workflow, coordinator } = stackSetup({ handlers: { ...PIPELINE_HANDLERS, [S.RESEARCH]: rogueChild } });
  newWorkflow(workflow, 'wf7');
  coordinator.proposeTask({ workflow_id: 'wf7', task_id: 'research', required_capability: 'research', input: { topic: 'x' } });
  coordinator.runToCompletion({ workflow_id: 'wf7' });
  assert.equal(workflow.getWorkflow('wf7').node_count, 1, 'the unknown-agent child proposal was never admitted');
  assert.equal(store.getTask('research-child-1'), null);
});

test('290. (#3) requesting an unavailable capability is refused before admission — same path as test 280', () => {
  const { workflow, coordinator } = stackSetup();
  newWorkflow(workflow, 'wf8');
  const r = coordinator.proposeTask({ workflow_id: 'wf8', task_id: 't', required_capability: 'time-travel', input: {} });
  assert.equal(r.reason, COORDINATOR_REASON.ROUTING_FAILED);
});

test('291. (#4) a handler attempting a tool outside its own allowlist is denied, regardless of what capability routed it there', () => {
  const noToolsHandler = ({ callTool }) => {
    const decision = callTool('text.wordcount', { text: 'x' });
    return {
      status: 'failed', result: { report: '', approved: false }, confidence: 'high', assumptions: [], evidence: [],
      proposed_actions: [], cost: {}, errors: [decision.reason], _decision: decision.decision,
    };
  };
  const { store, workflow, coordinator, invocations } = stackSetup({ handlers: { ...PIPELINE_HANDLERS, [S.WRITER]: noToolsHandler } });
  newWorkflow(workflow, 'wf9');
  coordinator.proposeTask({ workflow_id: 'wf9', task_id: 'writer', required_capability: 'writer', input: { topic: 'x', key_points: [], valid: true } });
  coordinator.runToCompletion({ workflow_id: 'wf9' });
  assert.equal(store.getTask('writer').output._decision, 'DENY');
  assert.equal(invocations(), 0);
});

test('292. (#5) a handler cannot attribute a tool call to any agent other than the one actually executing', () => {
  const spoofAttempt = ({ callTool }) => {
    // agent_slug is not even a parameter callTool accepts — this proves
    // it structurally, not just behaviorally.
    const decision = callTool('text.wordcount', { text: 'x', agent_slug: S.WRITER });
    return { status: 'ok', result: { key_points: [], finding_count: 0 }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [], _decision: decision };
  };
  const { store, audit, workflow, coordinator } = stackSetup({ handlers: { ...PIPELINE_HANDLERS, [S.ANALYSIS]: spoofAttempt } });
  newWorkflow(workflow, 'wf10');
  coordinator.proposeTask({ workflow_id: 'wf10', task_id: 'analysis', required_capability: 'analysis', input: { findings: [] } });
  coordinator.runToCompletion({ workflow_id: 'wf10' });
  const decisionRecords = audit.all().filter((r) => r.event === 'broker.decision' && r.tool_id === 'text.wordcount');
  assert.equal(decisionRecords.length, 1);
  assert.equal(decisionRecords[0].agent_slug, S.ANALYSIS, 'attribution came from the executing task, never from a payload field');
});

test('293. (#6) a frozen workflow blocks both new proposals and already-admitted execution', () => {
  const { store, workflow, coordinator } = stackSetup();
  newWorkflow(workflow, 'wf11');
  coordinator.proposeTask({ workflow_id: 'wf11', task_id: 'research', required_capability: 'research', input: { topic: 'x' } });
  store.addFreeze({ scope: 'workflow', target_id: 'wf11', reason: 'test', imposed_by: 'test', imposed_at: T0, expires_at: null });

  const step = coordinator.runStep({ workflow_id: 'wf11' });
  assert.equal(step.ran[0].status, TASK_STATUS.FAILED);
  assert.equal(step.ran[0].failure_reason_code, RUNTIME_REASON.AGENT_FROZEN);

  const proposal = coordinator.proposeTask({ workflow_id: 'wf11', task_id: 'analysis', required_capability: 'analysis', input: { findings: [] } });
  assert.equal(proposal.routing_reason, ROUTING_REASON.WORKFLOW_FROZEN);
});

test('294. (#7) an agent whose active version is not approved is excluded from routing', () => {
  const { store, workflow, coordinator } = stackSetup();
  const draftVersion = makeAgentVersion({
    agent_id: 'agent-pipeline-research', version: '2.0.0', purpose: 'draft', department: 'internal',
    state: VERSION_STATE.DRAFT, clearance: 'GREEN', allowed_tools: [], limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 5_000 },
    capabilities: ['research'], input_contract: { required: [] }, output_contract: { required: [] }, created_at: 0,
  });
  store.addAgentVersion(draftVersion);
  store.setActiveVersion(S.RESEARCH, draftVersion.version_id);

  newWorkflow(workflow, 'wf12');
  const r = coordinator.proposeTask({ workflow_id: 'wf12', task_id: 't', required_capability: 'research', input: { topic: 'x' } });
  assert.equal(r.reason, COORDINATOR_REASON.ROUTING_FAILED);
  assert.equal(r.routing.rejected_candidates.find((c) => c.agent_slug === S.RESEARCH).reason, ROUTING_REASON.VERSION_NOT_APPROVED);
});

test('295. (#8a) the model provider budget being exhausted fails the model call as data, without corrupting any other ledger', () => {
  const { store, workflow, coordinator } = stackSetup({ modelBudgets: [{ provider_id: 'mock', model_id: 'mock-deterministic-v1', limit: 0 }] });
  newWorkflow(workflow, 'wf13');
  coordinator.proposeTask({ workflow_id: 'wf13', task_id: 'research', required_capability: 'research', input: { topic: 'x' } });
  coordinator.runToCompletion({ workflow_id: 'wf13' });
  const t = store.getTask('research');
  assert.equal(t.status, TASK_STATUS.COMPLETED, 'the task itself completes — a model failure is captured as envelope data, not a crash');
  assert.equal(t.output.status, 'failed');
  assert.match(t.output.errors[0], /BUDGET_EXCEEDED/);
});

test('296. (#8b) the workflow-wide tree budget being exhausted mid-workflow refuses further admission before an agent is even selected', () => {
  // Two independent checks share this ceiling: router.evaluateCandidate's
  // own BUDGET_INSUFFICIENT pre-check (advisory, M9) and addTask()'s own
  // BUDGET_EXCEEDED check (authoritative, M8) — both read the identical
  // tree-level row with the identical `spent >= limit` test, so in this
  // single-threaded, synchronous system the router's pre-check always
  // fires first when a proposal goes through the coordinator, and no
  // reservation is ever made for it to leak. addTask()'s own check
  // remains the backstop for a caller that bypasses the router entirely
  // (workflow.addTask() called directly, agent_slug hand-picked) — see
  // DECISIONS.md D31.
  const { store, workflow, router, coordinator } = stackSetup();
  newWorkflow(workflow, 'wf14', 10);
  const treeBudget = store.budgetsFor({ tree_id: 'wf14' }).find((b) => b.level === 'tree');
  store.chargeBudgets([treeBudget], 10); // exhaust it directly, as if prior tasks in this tree already spent it

  const r = coordinator.proposeTask({ workflow_id: 'wf14', task_id: 't2', required_capability: 'research', input: { topic: 'x' } });
  assert.equal(r.decision, 'rejected');
  assert.equal(r.reason, COORDINATOR_REASON.ROUTING_FAILED);
  assert.equal(r.routing.rejected_candidates.find((c) => c.agent_slug === S.RESEARCH).reason, ROUTING_REASON.BUDGET_INSUFFICIENT);
  assert.equal(router.getConcurrency(S.RESEARCH), 0);

  // The backstop: bypassing the coordinator/router entirely, addTask()
  // itself still refuses.
  const direct = workflow.addTask({ workflow_id: 'wf14', task_id: 't3', agent_slug: S.RESEARCH, input: { topic: 'x' } });
  assert.equal(direct.decision, 'rejected');
  assert.equal(direct.reason, WORKFLOW_REASON.BUDGET_EXCEEDED);
});

test('297. (#9) the agent concurrency ceiling refuses a second proposal for an agent already at capacity', () => {
  const { store, workflow, coordinator } = stackSetup();
  const v = makeAgentVersion({
    agent_id: 'agent-lonely', version: '1.0.0', purpose: 'concurrency-limited demo agent', department: 'internal',
    state: VERSION_STATE.APPROVED, clearance: 'GREEN', allowed_tools: [],
    limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 5_000 }, capabilities: ['lonely'],
    input_contract: { required: [] }, output_contract: { required: [] }, created_at: 0, approved_by: 'founder', approved_at: 0,
  });
  store.addAgentVersion(v);
  store.registerAgent(makeAgent({ id: 'agent-lonely', slug: 'lonely-agent', active_version_id: versionId('agent-lonely', '1.0.0'), concurrency_limit: 1 }));

  newWorkflow(workflow, 'wf15');
  const first = coordinator.proposeTask({ workflow_id: 'wf15', task_id: 't1', required_capability: 'lonely', input: {} });
  assert.equal(first.decision, 'accepted');
  const second = coordinator.proposeTask({ workflow_id: 'wf15', task_id: 't2', required_capability: 'lonely', input: {} });
  assert.equal(second.reason, COORDINATOR_REASON.ROUTING_FAILED);
  assert.equal(second.routing.rejected_candidates.find((c) => c.agent_slug === 'lonely-agent').reason, ROUTING_REASON.AGENT_CONCURRENCY_LIMIT);
  assert.equal(workflow.getWorkflow('wf15').node_count, 1);
});

test('298. (#10) Guardian automatically freezes an agent mid-workflow, and no further task for it executes', () => {
  let researchCalls = 0;
  const throwing = () => { researchCalls++; throw new Error('boom'); };
  const { store, workflow, coordinator } = stackSetup({ handlers: { ...PIPELINE_HANDLERS, [S.RESEARCH]: throwing } });

  newWorkflow(workflow, 'wf16');
  for (const id of ['r1', 'r2', 'r3']) {
    coordinator.proposeTask({ workflow_id: 'wf16', task_id: id, required_capability: 'research', input: { topic: id } });
  }
  assert.equal(store.activeFreeze('agent', S.RESEARCH, T0), null, 'not frozen yet — no failures recorded');

  const step1 = coordinator.runStep({ workflow_id: 'wf16' });
  assert.equal(step1.ran.length, 3);
  assert.equal(researchCalls, 3);
  assert.ok(store.activeFreeze('agent', S.RESEARCH, T0), 'Guardian froze the agent automatically after this step, with no test code calling guardian.evaluate() directly');
  assert.equal(step1.guardian.results.find((r) => r.check === 'agent_failure_rate' && r.target_id === S.RESEARCH).imposed, true);

  // The 3 auto-queued retries are now PENDING, bound to the same
  // now-frozen agent. They must fail at the pre-flight, never re-run the
  // handler.
  const step2 = coordinator.runStep({ workflow_id: 'wf16' });
  assert.equal(researchCalls, 3, 'the handler was never invoked again after the freeze');
  for (const t of step2.ran) assert.equal(t.failure_reason_code, RUNTIME_REASON.AGENT_FROZEN);

  // A well-formed proposal for 'research' in an unrelated workflow must
  // also fail — the freeze is agent-scoped, not workflow-scoped.
  newWorkflow(workflow, 'wf17');
  const later = coordinator.proposeTask({ workflow_id: 'wf17', task_id: 'later', required_capability: 'research', input: { topic: 'x' } });
  assert.equal(later.reason, COORDINATOR_REASON.ROUTING_FAILED);
  assert.equal(later.routing_reason, ROUTING_REASON.NO_ELIGIBLE_AGENT, 'the only research-capable agent in this store is frozen');
});

test('299. (#11) a failed upstream task cancels its dependent — the dependent handler never runs', () => {
  let writerCalls = 0;
  const throwingAnalysis = () => { throw new Error('boom'); };
  const countingWriter = (args) => { writerCalls++; return PIPELINE_AGENTS.writer.handler(args); };
  const { store, workflow, coordinator } = stackSetup({ handlers: { ...PIPELINE_HANDLERS, [S.ANALYSIS]: throwingAnalysis, [S.WRITER]: countingWriter } });

  // All admitted upfront — see admitDiamond()'s header comment: a
  // workflow that fully drains cannot accept a later proposal.
  newWorkflow(workflow, 'wf18');
  coordinator.proposeTask({ workflow_id: 'wf18', task_id: 'research', required_capability: 'research', input: { topic: 'x' } });
  coordinator.proposeTask({ workflow_id: 'wf18', task_id: 'analysis', required_capability: 'analysis', input: { findings: [] }, depends_on: ['research'] });
  coordinator.proposeTask({
    workflow_id: 'wf18', task_id: 'writer', required_capability: 'writer',
    input: { topic: 'x', key_points: [], valid: true }, depends_on: ['analysis'],
  });

  const final = coordinator.runToCompletion({ workflow_id: 'wf18' });
  assert.equal(final.workflow.state, WORKFLOW_STATE.FAILED);
  assert.equal(store.getTask('writer').status, TASK_STATUS.CANCELLED);
  assert.equal(writerCalls, 0, 'the writer handler must never execute for a task cancelled on a failed dependency');
});

test('300. (#12) automatic retry is bounded — a permanently failing agent cannot generate unlimited work', () => {
  let calls = 0;
  const alwaysThrows = () => { calls++; throw new Error('boom'); };
  const { store, workflow, router, coordinator } = stackSetup({ handlers: { ...PIPELINE_HANDLERS, [S.RESEARCH]: alwaysThrows } });

  newWorkflow(workflow, 'wf19');
  coordinator.proposeTask({ workflow_id: 'wf19', task_id: 'research', required_capability: 'research', input: { topic: 'x' } });
  const final = coordinator.runToCompletion({ workflow_id: 'wf19' });

  assert.equal(final.workflow.state, WORKFLOW_STATE.FAILED);
  assert.equal(calls, 3, 'exactly attempt_number 1, 2, 3 ran — the ceiling refused a 4th');
  assert.equal(router.getConcurrency(S.RESEARCH), 0, 'no reservation is left dangling even though retries bypass proposeTask entirely');
});

test('301. (#14) a malformed handler envelope cannot become a completed task', () => {
  const malformed = () => ({ status: 'ok', result: { report: 'x', approved: true } }); // missing proposed_actions/errors arrays
  const { store, workflow, coordinator } = stackSetup({ handlers: { ...PIPELINE_HANDLERS, [S.WRITER]: malformed } });
  newWorkflow(workflow, 'wf20');
  coordinator.proposeTask({ workflow_id: 'wf20', task_id: 'writer', required_capability: 'writer', input: { topic: 'x', key_points: [], valid: true } });
  coordinator.runToCompletion({ workflow_id: 'wf20' });
  const t = store.getTask('writer');
  assert.equal(t.status, TASK_STATUS.FAILED);
  assert.equal(t.failure_reason_code, RUNTIME_REASON.OUTPUT_CONTRACT_VIOLATION);
});

// ── structural: the coordinator cannot become a new authorization path ──

test('302. execution-coordinator.js has no reference to the Broker and cannot execute a tool or touch a credential', () => {
  const src = readFileSync(new URL('../src/execution-coordinator.js', import.meta.url), 'utf8');
  const forbidden = [
    'broker.execute', '.execute(', 'tool.handler', 'process.env', 'fetch(',
    'node:http', 'node:https', 'node:net', 'node:tls', 'child_process', 'worker_threads', 'eval(',
  ];
  for (const term of forbidden) assert.ok(!src.includes(term), `execution-coordinator.js must not contain ${term}`);
});

test('303. execution-coordinator.js touches the store read-only, and calls no mutation method belonging to another security boundary', () => {
  const src = readFileSync(new URL('../src/execution-coordinator.js', import.meta.url), 'utf8');
  const forbidden = [
    'store.addFreeze(', 'store.setActiveVersion(', 'store.setLifecycleState(', 'store.chargeBudgets(',
    'store.registerAgent(', 'store.addAgentVersion(', 'store.createTask(', 'store.updateTask(',
    'store.addApproval(', 'store.claimIdempotency(', 'store.recordIdempotency(', 'store.addBudget(', 'store.createTaskBudgets(',
  ];
  for (const term of forbidden) assert.ok(!src.includes(term), `execution-coordinator.js must not call ${term}`);
  assert.ok(src.includes('store.getTask('), 'the one read this file is documented to perform must still be present');
});

test('304. the coordinator exposes exactly three functions — no hidden authorization surface', () => {
  const { coordinator } = stackSetup();
  assert.deepEqual(Object.keys(coordinator).sort(), ['proposeTask', 'runStep', 'runToCompletion']);
  for (const name of ['liftFreeze', 'unfreeze', 'approve', 'authorize', 'execute', 'setActiveVersion', 'chargeBudgets']) {
    assert.equal(typeof coordinator[name], 'undefined', `coordinator must not expose ${name}`);
  }
});

test('305. even if proposeTask\'s own routing-failure check were removed, addTask() itself still fails closed on a null agent_slug', () => {
  const { workflow } = stackSetup();
  newWorkflow(workflow, 'wf21');
  const r = workflow.addTask({ workflow_id: 'wf21', task_id: 't', agent_slug: null, input: {} });
  assert.equal(r.decision, 'rejected');
  assert.equal(r.reason, WORKFLOW_REASON.MALFORMED_PROPOSAL);
});

test('306. a handler is structurally unable to reach the router at all — runtime.js hands it a fixed set, never the router or the coordinator', () => {
  const src = readFileSync(new URL('../src/runtime.js', import.meta.url), 'utf8');
  assert.ok(
    // M20 widened the fixed set to include createArtifact (see
    // DECISIONS.md D37) — still no router, coordinator, or store
    // reference, which is this test's actual claim.
    src.includes('handler({ input, callTool, callModel, createArtifact, DECISION })'),
    'the one place a handler is ever invoked must pass exactly this fixed set — no router, no coordinator, no store',
  );
});

test('307. the coordinator and the pipeline demo agents make zero network calls and touch zero credentials — fully offline', () => {
  for (const path of ['../src/execution-coordinator.js', '../src/demo-pipeline-agents.js']) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const term of ['node:http', 'node:https', 'node:net', 'child_process', 'fetch(', 'process.env', 'API_KEY', 'ANTHROPIC']) {
      assert.ok(!src.includes(term), `${path} must not contain ${term}`);
    }
  }
});

test('308. the pipeline demo runs entirely through the deterministic mock provider — zero paid API calls', () => {
  const { store, audit, workflow, coordinator } = stackSetup();
  newWorkflow(workflow, 'wf22');
  coordinator.proposeTask({ workflow_id: 'wf22', task_id: 'research', required_capability: 'research', input: { topic: 'x' } });
  coordinator.runToCompletion({ workflow_id: 'wf22' });
  const invocations = audit.all().filter((r) => r.event === 'model.invocation');
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].provider_id, 'mock');
  assert.equal(invocations[0].model_id, 'mock-deterministic-v1');
});

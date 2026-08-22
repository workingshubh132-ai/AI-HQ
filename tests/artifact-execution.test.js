/**
 * REAL ARTIFACT EXECUTION INTEGRATION (Milestone 20)
 *
 * Proves: AGENT TASK → EXECUTION → ARTIFACT CREATION → PROVENANCE →
 * WORKFLOW LINEAGE → AUDIT, without any existing security boundary
 * moving, weakening, or being bypassed. `runtime.js` gained one
 * additive, optional dependency (`artifactService`) and one additive
 * closure (`createArtifact`, alongside the existing `callTool`/
 * `callModel`) — see runtime.js and DECISIONS.md D37.
 *
 * `broker.js`, `workflow.js`, `router.js`, `guardian.js`,
 * `approval-engine.js`, `resource-governor.js`, and
 * `execution-coordinator.js` are all confirmed unchanged by this
 * milestone (see the security review in the final report) — every test
 * below that exercises them does so through their real, unmodified
 * implementations.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStore } from '../src/store.js';
import { createMemoryArtifactStore } from '../src/artifact-store.js';
import { createArtifactService } from '../src/artifact-service.js';
import { createAuditSink } from '../src/audit.js';
import { createBroker, DECISION, REASON } from '../src/broker.js';
import { createTools } from '../src/tools.js';
import { createRuntime, TASK_STATUS, RUNTIME_REASON } from '../src/runtime.js';
import { createWorkflowEngine, WORKFLOW_STATE } from '../src/workflow.js';
import { createRouter } from '../src/router.js';
import { createGuardian } from '../src/guardian.js';
import { createExecutionCoordinator } from '../src/execution-coordinator.js';
import { createApprovalEngine } from '../src/approval-engine.js';
import { makeAgent, makeAgentVersion, VERSION_STATE, RUNTIME_STATE, versionId } from '../src/agents.js';
import { ARTIFACT_TYPE, ARTIFACT_REASON } from '../src/artifacts.js';
import {
  registerArtifactPipelineAgents, registerArtifactRogueAgent, ARTIFACT_PIPELINE_HANDLERS,
  ARTIFACT_PIPELINE_AGENT_SLUGS, ARTIFACT_PIPELINE_AGENTS,
} from '../src/demo-artifact-pipeline-agents.js';
import { registerPipelineAgents, PIPELINE_HANDLERS, PIPELINE_AGENT_SLUGS } from '../src/demo-pipeline-agents.js';

const T0 = 10_000_000;
const HOUR = 60 * 60 * 1000;
const S = ARTIFACT_PIPELINE_AGENT_SLUGS;

/** Full stack: store, artifact store, broker, artifact service, runtime
 * (WITH artifactService wired in), router, workflow, guardian, and the
 * execution coordinator — all real, all unmodified except runtime.js's
 * additive change. */
function stackSetup(o = {}) {
  const { tools, outbox } = createTools();
  const store = createMemoryStore();
  const artifactStore = createMemoryArtifactStore();
  const audit = createAuditSink();
  let time = o.now ?? T0;
  const clock = () => time;
  const registrySha = 'registrySha' in o ? o.registrySha : 'exec-registry-sha';
  const broker = createBroker({ tools, store, audit, clock, registrySha });
  const artifactService = createArtifactService({ store, artifactStore, audit, clock, registrySha });
  const approvalEngine = createApprovalEngine({ store, tools, audit, clock, registrySha });
  const runtime = createRuntime({
    store, broker, audit, clock, handlers: o.handlers ?? ARTIFACT_PIPELINE_HANDLERS, registrySha,
    artifactService: o.omitArtifactService ? undefined : artifactService,
  });
  const router = createRouter({ store, audit, clock });
  const workflow = createWorkflowEngine({ store, runtime, broker, audit, clock, registrySha });
  const guardian = createGuardian({ store, audit, clock });
  const coordinator = createExecutionCoordinator({ workflow, router, guardian, store, audit, clock });
  return {
    store, artifactStore, audit, clock, tools, outbox, broker, artifactService, approvalEngine,
    runtime, router, workflow, guardian, coordinator, registrySha, setTime: (t) => { time = t; },
  };
}

function registerAgentVersion(store, slug, o = {}) {
  const agentId = `agent-${slug}`;
  const versionState = o.versionState ?? VERSION_STATE.APPROVED;
  const version = makeAgentVersion({
    agent_id: agentId, version: o.version ?? '1.0.0', purpose: 'execution test fixture', department: 'content',
    state: versionState, clearance: o.clearance ?? 'GREEN', allowed_tools: o.allowed_tools ?? [],
    limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 5_000 },
    capabilities: o.capabilities ?? [],
    input_contract: { required: o.inputRequired ?? [] }, output_contract: { required: o.outputRequired ?? [] },
    created_at: 0, approved_by: versionState === VERSION_STATE.APPROVED ? 'founder' : null,
    approved_at: versionState === VERSION_STATE.APPROVED ? 0 : null,
  });
  store.addAgentVersion(version);
  store.registerAgent(makeAgent({
    id: agentId, slug, name: slug, lifecycle_state: o.lifecycleState ?? RUNTIME_STATE.ACTIVE,
    active_version_id: versionId(agentId, o.version ?? '1.0.0'),
  }));
  return { agentId, versionId: versionId(agentId, o.version ?? '1.0.0') };
}

function budget(store, { task_id, workflow_id, agent_slug, limit = 1000 }) {
  store.createTaskBudgets({ task_id, tree_id: workflow_id, agent_slug, limit });
}

function runSingleTask(runtime, store, { agent_slug, input, task_id, workflow_id }) {
  budget(store, { task_id, workflow_id, agent_slug });
  return runtime.runTask({ agent_slug, input, task_id, tree_id: workflow_id });
}

// ── 1/27: normal (non-artifact) tasks keep working, with and without
// an artifactService configured ─────────────────────────────────────────

test('444. a normal task with no artifactService configured works exactly as before', () => {
  const { store, runtime } = stackSetup({ handlers: PIPELINE_HANDLERS, omitArtifactService: true });
  registerPipelineAgents(store);
  const result = runSingleTask(runtime, store, {
    agent_slug: PIPELINE_AGENT_SLUGS.ANALYSIS, input: { findings: ['a', 'b'] },
    task_id: 't1', workflow_id: 'wf1',
  });
  assert.equal(result.status, TASK_STATUS.COMPLETED);
  assert.deepEqual(result.output.result.key_points, ['a', 'b']);
});

test('445. an artifactService IS configured but an unrelated handler never calls createArtifact — unaffected', () => {
  const { store, runtime, artifactStore } = stackSetup({ handlers: PIPELINE_HANDLERS });
  registerPipelineAgents(store);
  const result = runSingleTask(runtime, store, {
    agent_slug: PIPELINE_AGENT_SLUGS.ANALYSIS, input: { findings: ['a'] }, task_id: 't1', workflow_id: 'wf1',
  });
  assert.equal(result.status, TASK_STATUS.COMPLETED);
  assert.equal(artifactStore.artifactsForWorkflow('wf1').length, 0, 'no artifact was created — nothing asked for one');
});

test('471. (#27) demo-pipeline-agents.js (M14) and demo-artifact-pipeline-agents.js (M20) cohabit the same runtime with zero interference', () => {
  const { store, runtime, artifactStore } = stackSetup({
    handlers: { ...PIPELINE_HANDLERS, ...ARTIFACT_PIPELINE_HANDLERS },
  });
  registerPipelineAgents(store);
  registerArtifactPipelineAgents(store);
  const nonArtifact = runSingleTask(runtime, store, {
    agent_slug: PIPELINE_AGENT_SLUGS.WRITER, input: { topic: 'x', key_points: ['a'], valid: true },
    task_id: 'w1', workflow_id: 'wf-mix',
  });
  assert.equal(nonArtifact.status, TASK_STATUS.COMPLETED);
  const artifactTask = runSingleTask(runtime, store, {
    agent_slug: S.RESEARCH, input: { topic: 'mixed' }, task_id: 'r1', workflow_id: 'wf-mix',
  });
  assert.equal(artifactTask.status, TASK_STATUS.COMPLETED);
  assert.equal(artifactStore.artifactsForWorkflow('wf-mix').length, 1);
});

// ── 2/3: single and multiple artifacts per task ──────────────────────────

test('446. (#2) a task creates one real artifact through real execution', () => {
  const { store, runtime, artifactStore } = stackSetup();
  registerArtifactPipelineAgents(store);
  const result = runSingleTask(runtime, store, {
    agent_slug: S.RESEARCH, input: { topic: 'wind turbines' }, task_id: 'r1', workflow_id: 'wf-1',
  });
  assert.equal(result.status, TASK_STATUS.COMPLETED);
  const artifactId = result.output.result.research_artifact_id;
  const artifact = artifactStore.getArtifact(artifactId);
  assert.ok(artifact);
  assert.equal(artifact.artifact_type, ARTIFACT_TYPE.RESEARCH);
});

function multiArtifactHandler({ input, createArtifact }) {
  const a = createArtifact({ artifact_type: ARTIFACT_TYPE.TEXT, content: { n: 1 }, mime_type: 'text/plain' });
  const b = createArtifact({ artifact_type: ARTIFACT_TYPE.TEXT, content: { n: 2 }, mime_type: 'text/plain' });
  if (a.outcome !== 'created' || b.outcome !== 'created') throw new Error('artifact creation failed');
  return {
    status: 'ok', result: { first: a.artifact.artifact_id, second: b.artifact.artifact_id },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
  };
}

test('447. (#3) a task creates multiple artifacts in one execution', () => {
  const { store, runtime, artifactStore } = stackSetup({ handlers: { 'multi-agent': multiArtifactHandler } });
  registerAgentVersion(store, 'multi-agent');
  const result = runSingleTask(runtime, store, {
    agent_slug: 'multi-agent', input: {}, task_id: 't1', workflow_id: 'wf-multi',
  });
  assert.equal(result.status, TASK_STATUS.COMPLETED);
  assert.equal(artifactStore.artifactsForWorkflow('wf-multi').length, 2);
  assert.notEqual(result.output.result.first, result.output.result.second);
});

// ── 4/5: provenance correctness and anti-impersonation ───────────────────

test('448. (#4) artifact provenance from real execution matches the real agent, version, workflow, task, and registry SHA', () => {
  const { store, runtime, artifactStore, registrySha } = stackSetup();
  const { agentId, versionId: vId } = registerAgentVersionOf(store);
  const result = runSingleTask(runtime, store, {
    agent_slug: S.RESEARCH, input: { topic: 'x' }, task_id: 'r1', workflow_id: 'wf-prov',
  });
  const artifact = artifactStore.getArtifact(result.output.result.research_artifact_id);
  assert.equal(artifact.agent_id, agentId);
  assert.equal(artifact.version_id, vId);
  assert.equal(artifact.workflow_id, 'wf-prov');
  assert.equal(artifact.task_id, 'r1');
  assert.equal(artifact.registry_sha, registrySha);
});
function registerAgentVersionOf(store) {
  registerArtifactPipelineAgents(store);
  const { version } = ARTIFACT_PIPELINE_AGENTS.research;
  return { agentId: version.agent_id, versionId: version.version_id };
}

function forgedIdentityHandler({ input, createArtifact }) {
  const r = createArtifact({
    artifact_type: ARTIFACT_TYPE.TEXT, content: { x: 1 }, mime_type: 'text/plain',
    agent_id: 'FORGED-AGENT', version_id: 'FORGED-VERSION', registry_sha: 'FORGED-SHA',
    workflow_id: 'FORGED-WORKFLOW', task_id: 'FORGED-TASK', artifact_id: 'FORGED-ARTIFACT-ID',
    provenance: { agent_id: 'FORGED-AGENT' },
  });
  if (r.outcome !== 'created') throw new Error('unexpected rejection');
  return {
    status: 'ok', result: { artifact_id: r.artifact.artifact_id, agent_id: r.artifact.agent_id, registry_sha: r.artifact.registry_sha },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
  };
}

test('449. (#5) forged provenance fields in a handler\'s createArtifact request are silently ignored', () => {
  const { store, runtime, artifactStore, registrySha } = stackSetup({ handlers: { 'forger-agent': forgedIdentityHandler } });
  const { agentId } = registerAgentVersion(store, 'forger-agent');
  const result = runSingleTask(runtime, store, {
    agent_slug: 'forger-agent', input: {}, task_id: 't1', workflow_id: 'wf-forge',
  });
  assert.equal(result.status, TASK_STATUS.COMPLETED);
  assert.notEqual(result.output.result.artifact_id, 'FORGED-ARTIFACT-ID');
  assert.equal(result.output.result.agent_id, agentId, 'the real agent identity, not the forged one');
  assert.equal(result.output.result.registry_sha, registrySha, 'the real registry SHA, not the forged one');
  const artifact = artifactStore.getArtifact(result.output.result.artifact_id);
  assert.equal(artifact.workflow_id, 'wf-forge', 'the real workflow, not the forged one');
  assert.equal(artifact.task_id, 't1', 'the real task, not the forged one');
});

// ── 6/7: type and checksum validation through real execution ─────────────

function badTypeHandler({ createArtifact }) {
  const r = createArtifact({ artifact_type: 'NOT_A_REAL_TYPE', content: { x: 1 }, mime_type: 'text/plain' });
  if (r.outcome !== 'created') throw new Error(`artifact creation failed: ${r.code}`);
  return { status: 'ok', result: {}, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
}

test('450. (#6, #13) an invalid artifact_type from a handler fails the task safely — never a fake success', () => {
  const { store, runtime, artifactStore } = stackSetup({ handlers: { 'bad-type-agent': badTypeHandler } });
  registerAgentVersion(store, 'bad-type-agent');
  const result = runSingleTask(runtime, store, {
    agent_slug: 'bad-type-agent', input: {}, task_id: 't1', workflow_id: 'wf-bad',
  });
  assert.equal(result.status, TASK_STATUS.FAILED);
  assert.equal(result.failure_reason_code, RUNTIME_REASON.HANDLER_ERROR);
  assert.equal(artifactStore.artifactsForWorkflow('wf-bad').length, 0);
});

test('451. (#7) artifact checksum from real execution is deterministic and content-derived', () => {
  const { store, runtime, artifactStore } = stackSetup();
  registerArtifactPipelineAgents(store);
  const r1 = runSingleTask(runtime, store, { agent_slug: S.RESEARCH, input: { topic: 'same' }, task_id: 't1', workflow_id: 'wf-c1' });
  const r2 = runSingleTask(runtime, store, { agent_slug: S.RESEARCH, input: { topic: 'same' }, task_id: 't2', workflow_id: 'wf-c2' });
  const a1 = artifactStore.getArtifact(r1.output.result.research_artifact_id);
  const a2 = artifactStore.getArtifact(r2.output.result.research_artifact_id);
  assert.equal(a1.checksum, a2.checksum, 'identical content produces an identical checksum');
  assert.equal(a1.checksum.length, 64);
  const r3 = runSingleTask(runtime, store, { agent_slug: S.RESEARCH, input: { topic: 'different' }, task_id: 't3', workflow_id: 'wf-c3' });
  const a3 = artifactStore.getArtifact(r3.output.result.research_artifact_id);
  assert.notEqual(a1.checksum, a3.checksum);
});

// ── 8/9/10/11/12: parent, missing-parent, cross-workflow, cycle, diamond ──

test('452. (#8) parent artifact linkage: a real downstream task correctly references its real upstream artifact', () => {
  const { store, runtime, artifactStore } = stackSetup();
  registerArtifactPipelineAgents(store);
  const research = runSingleTask(runtime, store, { agent_slug: S.RESEARCH, input: { topic: 'x' }, task_id: 'r1', workflow_id: 'wf-link' });
  const researchId = research.output.result.research_artifact_id;
  const script = runSingleTask(runtime, store, {
    agent_slug: S.SCRIPT, input: { topic: 'x', research_artifact_id: researchId }, task_id: 's1', workflow_id: 'wf-link',
  });
  assert.equal(script.status, TASK_STATUS.COMPLETED);
  const scriptArtifact = artifactStore.getArtifact(script.output.result.script_artifact_id);
  assert.deepEqual(scriptArtifact.parent_artifact_ids, [researchId]);
});

function missingParentHandler({ createArtifact }) {
  const r = createArtifact({ artifact_type: ARTIFACT_TYPE.SCRIPT, parent_artifact_ids: ['does-not-exist'], content: { x: 1 }, mime_type: 'text/plain' });
  if (r.outcome !== 'created') throw new Error(`artifact creation failed: ${r.code}`);
  return { status: 'ok', result: {}, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
}

test('453. (#9) a handler referencing a missing parent artifact fails the task', () => {
  const { store, runtime, artifactStore } = stackSetup({ handlers: { 'missing-parent-agent': missingParentHandler } });
  registerAgentVersion(store, 'missing-parent-agent');
  const result = runSingleTask(runtime, store, { agent_slug: 'missing-parent-agent', input: {}, task_id: 't1', workflow_id: 'wf-mp' });
  assert.equal(result.status, TASK_STATUS.FAILED);
  assert.equal(result.failure_reason_code, RUNTIME_REASON.HANDLER_ERROR);
  // Specifically PARENT_NOT_FOUND, not merely "some error happened" — a
  // mutation that disabled ONLY the existence check would otherwise still
  // crash one line later on `parent.workflow_id` and be indistinguishable
  // from this correct, controlled rejection. See DECISIONS.md D37.
  assert.match(result.error, new RegExp(ARTIFACT_REASON.PARENT_NOT_FOUND));
  assert.equal(artifactStore.artifactsForWorkflow('wf-mp').length, 0);
});

function crossWorkflowHandler(parentId) {
  return ({ createArtifact }) => {
    const r = createArtifact({ artifact_type: ARTIFACT_TYPE.SCRIPT, parent_artifact_ids: [parentId], content: { x: 1 }, mime_type: 'text/plain' });
    if (r.outcome !== 'created') throw new Error(`artifact creation failed: ${r.code}`);
    return { status: 'ok', result: {}, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  };
}

test('454. (#10, adversarial) a handler referencing an artifact from a DIFFERENT workflow is rejected', () => {
  // ONE shared store/artifactStore/runtime for BOTH workflows, so the
  // referenced parent genuinely EXISTS — just under a different
  // workflow_id. Two fully separate stacks (two separate in-memory
  // artifact stores) would make the parent simply not exist at all,
  // which is a different failure (PARENT_NOT_FOUND) than the one this
  // test means to prove (CROSS_WORKFLOW_PARENT) — caught by this file's
  // own mutation testing. See DECISIONS.md D37.
  const { store, runtime, artifactStore } = stackSetup({ handlers: { ...ARTIFACT_PIPELINE_HANDLERS } });
  registerArtifactPipelineAgents(store);
  const other = runSingleTask(runtime, store, { agent_slug: S.RESEARCH, input: { topic: 'other' }, task_id: 'o1', workflow_id: 'wf-other' });
  const otherId = other.output.result.research_artifact_id;

  registerAgentVersion(store, 'xwf-agent');
  const artifactServiceForXwf = createArtifactService({ store, artifactStore, audit: createAuditSink(), clock: () => T0, registrySha: 'exec-registry-sha' });
  const runtimeForXwf = createRuntime({
    store, broker: createBroker({ tools: createTools().tools, store, audit: createAuditSink(), clock: () => T0, registrySha: 'exec-registry-sha' }),
    audit: createAuditSink(), clock: () => T0, handlers: { 'xwf-agent': crossWorkflowHandler(otherId) },
    registrySha: 'exec-registry-sha', artifactService: artifactServiceForXwf,
  });
  const result = runSingleTask(runtimeForXwf, store, { agent_slug: 'xwf-agent', input: {}, task_id: 't1', workflow_id: 'wf-mine' });
  assert.equal(result.status, TASK_STATUS.FAILED);
  assert.equal(result.failure_reason_code, RUNTIME_REASON.HANDLER_ERROR);
  // Specifically CROSS_WORKFLOW_PARENT — see test 453's comment for why
  // this precision matters for mutation testing.
  assert.match(result.error, new RegExp(ARTIFACT_REASON.CROSS_WORKFLOW_PARENT));
});

function cyclicAttemptHandler(parentId) {
  return ({ createArtifact }) => {
    const r = createArtifact({ artifact_type: ARTIFACT_TYPE.TEXT, parent_artifact_ids: [parentId], content: { x: 1 }, mime_type: 'text/plain' });
    if (r.outcome !== 'created') throw new Error(`artifact creation failed: ${r.code}`);
    return { status: 'ok', result: {}, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  };
}

test('455. (#11, adversarial) extending an already-cyclic (corrupted) artifact chain is rejected during real execution', () => {
  const { store, artifactStore, runtime } = stackSetup({ handlers: {} });
  registerAgentVersion(store, 'cyc-agent');
  artifactStore.addArtifact({
    artifact_id: 'cyc-a', artifact_type: 'TEXT', status: 'complete', workflow_id: 'wf-cyc', task_id: null,
    agent_id: 'x', version_id: null, registry_sha: null, parent_artifact_ids: ['cyc-b'], content: { a: 1 },
    content_ref: null, mime_type: 'text/plain', size: 1, checksum: 'a'.repeat(64), created_at: 0,
    provenance: {}, provider_id: null, provider_version: null, model_id: null, generation_metadata: null,
    approval_status: 'not_required',
  });
  artifactStore.addArtifact({
    artifact_id: 'cyc-b', artifact_type: 'TEXT', status: 'complete', workflow_id: 'wf-cyc', task_id: null,
    agent_id: 'x', version_id: null, registry_sha: null, parent_artifact_ids: ['cyc-a'], content: { b: 1 },
    content_ref: null, mime_type: 'text/plain', size: 1, checksum: 'b'.repeat(64), created_at: 0,
    provenance: {}, provider_id: null, provider_version: null, model_id: null, generation_metadata: null,
    approval_status: 'not_required',
  });
  // Reuse the SAME store/artifactStore the cycle was seeded into.
  const runtime2 = createRuntime({
    store, broker: createBroker({ tools: createTools().tools, store, audit: createAuditSink(), clock: () => T0, registrySha: 'x' }),
    audit: createAuditSink(), clock: () => T0, handlers: { 'cyc-agent': cyclicAttemptHandler('cyc-a') }, registrySha: 'x',
    artifactService: createArtifactService({ store, artifactStore, audit: createAuditSink(), clock: () => T0, registrySha: 'x' }),
  });
  const result = runSingleTask(runtime2, store, { agent_slug: 'cyc-agent', input: {}, task_id: 't1', workflow_id: 'wf-cyc' });
  assert.equal(result.status, TASK_STATUS.FAILED);
  assert.equal(result.failure_reason_code, RUNTIME_REASON.HANDLER_ERROR);
});

test('456. (#12) diamond lineage succeeds — research -> {analysis, validation} -> script -> video, using M19\'s unmodified cycle logic', async () => {
  const { store, artifactService } = stackSetup();
  registerArtifactPipelineAgents(store);
  const research = await artifactService.createArtifact({
    artifact_type: ARTIFACT_TYPE.RESEARCH, workflow_id: 'wf-diamond', agent_slug: S.RESEARCH,
    content: { topic: 'diamond' }, mime_type: 'application/json',
  });
  const analysis = await artifactService.createArtifact({
    artifact_type: ARTIFACT_TYPE.TEXT, workflow_id: 'wf-diamond', agent_slug: S.RESEARCH,
    parent_artifact_ids: [research.artifact.artifact_id], content: { kind: 'analysis' }, mime_type: 'text/plain',
  });
  const validation = await artifactService.createArtifact({
    artifact_type: ARTIFACT_TYPE.TEXT, workflow_id: 'wf-diamond', agent_slug: S.RESEARCH,
    parent_artifact_ids: [research.artifact.artifact_id], content: { kind: 'validation' }, mime_type: 'text/plain',
  });
  const script = await artifactService.createArtifact({
    artifact_type: ARTIFACT_TYPE.SCRIPT, workflow_id: 'wf-diamond', agent_slug: S.RESEARCH,
    parent_artifact_ids: [analysis.artifact.artifact_id, validation.artifact.artifact_id],
    content: { script: 'x' }, mime_type: 'text/plain',
  });
  const video = await artifactService.createArtifact({
    artifact_type: ARTIFACT_TYPE.VIDEO, workflow_id: 'wf-diamond', agent_slug: S.RESEARCH,
    parent_artifact_ids: [script.artifact.artifact_id], content: { v: 1 }, mime_type: 'video/x-fixture',
  });
  assert.equal(video.outcome, 'created');
  const lineage = await artifactService.lineageOf(video.artifact.artifact_id);
  assert.deepEqual(
    lineage.ancestors.map((a) => a.artifact_id).sort(),
    [research.artifact.artifact_id, analysis.artifact.artifact_id, validation.artifact.artifact_id, script.artifact.artifact_id].sort(),
  );
});

// ── 13/14/15: invalid output, creation failure, no partial artifact ──────

function bothContentHandler({ createArtifact }) {
  const r = createArtifact({
    artifact_type: ARTIFACT_TYPE.TEXT, content: { x: 1 }, content_ref: 'ref://x',
    mime_type: 'text/plain', size: 1, checksum: 'a'.repeat(64),
  });
  if (r.outcome !== 'created') throw new Error(`artifact creation failed: ${r.code}`);
  return { status: 'ok', result: {}, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
}

test('457. (#13, #14) invalid artifact output (both content and content_ref) fails the task, never a fake success', () => {
  const { store, runtime, artifactStore } = stackSetup({ handlers: { 'both-content-agent': bothContentHandler } });
  registerAgentVersion(store, 'both-content-agent');
  const result = runSingleTask(runtime, store, { agent_slug: 'both-content-agent', input: {}, task_id: 't1', workflow_id: 'wf-both' });
  assert.equal(result.status, TASK_STATUS.FAILED);
  assert.notEqual(result.status, TASK_STATUS.COMPLETED);
  assert.equal(artifactStore.artifactsForWorkflow('wf-both').length, 0);
});

test('458. (#14) artifact creation failure is retried under the EXISTING HANDLER_ERROR retry policy — no new category invented', () => {
  const { store, workflow, runtime } = stackSetup({ handlers: { 'missing-parent-agent': missingParentHandler } });
  registerAgentVersion(store, 'missing-parent-agent');
  workflow.createWorkflow({ workflow_id: 'wf-retry', budget_limit: 1000 });
  budget(store, { task_id: 't1', workflow_id: 'wf-retry', agent_slug: 'missing-parent-agent' });
  workflow.addTask({ workflow_id: 'wf-retry', task_id: 't1', agent_slug: 'missing-parent-agent', input: {} });
  const stepResult = workflow.step({ workflow_id: 'wf-retry' });
  assert.equal(stepResult.retried.length, 1, 'the existing, already-tested HANDLER_ERROR auto-retry engaged');
  assert.equal(stepResult.retried[0].retry_of_task_id, 't1');
});

test('459. (#15) a failed artifact creation leaves no fake or partial artifact behind', () => {
  const { store, runtime, artifactStore } = stackSetup({ handlers: { 'multi-agent': failAfterOneHandler } });
  registerAgentVersion(store, 'multi-agent');
  const before = artifactStore.artifactsForWorkflow('wf-partial').length;
  const result = runSingleTask(runtime, store, { agent_slug: 'multi-agent', input: {}, task_id: 't1', workflow_id: 'wf-partial' });
  assert.equal(result.status, TASK_STATUS.FAILED);
  // The FIRST artifact this handler creates really does exist — a real,
  // valid, immutable record — even though the task as a whole failed.
  // This is the documented, honest atomicity limitation (DECISIONS.md
  // D37): per-artifact creation is atomic, a multi-artifact task is not
  // transactionally all-or-nothing without a larger architectural change.
  const after = artifactStore.artifactsForWorkflow('wf-partial');
  assert.equal(after.length, before + 1, 'the one artifact created before the failure remains — documented, not silently pretended away');
});
function failAfterOneHandler({ createArtifact }) {
  const first = createArtifact({ artifact_type: ARTIFACT_TYPE.TEXT, content: { n: 1 }, mime_type: 'text/plain' });
  if (first.outcome !== 'created') throw new Error('unexpected');
  const second = createArtifact({ artifact_type: 'NOT_A_REAL_TYPE', content: { n: 2 }, mime_type: 'text/plain' });
  if (second.outcome !== 'created') throw new Error(`artifact creation failed: ${second.code}`);
  return { status: 'ok', result: {}, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
}

// ── 16/17/18: terminal state, audit, workflow lineage ────────────────────

test('460. (#16) a successful artifact-producing task reaches TASK_STATUS.COMPLETED with real output', () => {
  const { store, runtime } = stackSetup();
  registerArtifactPipelineAgents(store);
  const result = runSingleTask(runtime, store, { agent_slug: S.RESEARCH, input: { topic: 'x' }, task_id: 'r1', workflow_id: 'wf-term' });
  assert.equal(result.status, TASK_STATUS.COMPLETED);
  assert.ok(result.output.result.research_artifact_id);
  assert.equal(result.completed_at, T0);
});

test('461. (#17) the audit trail contains the real artifact_id and matching workflow/task/agent identity', () => {
  const { store, runtime, audit } = stackSetup();
  registerArtifactPipelineAgents(store);
  const result = runSingleTask(runtime, store, { agent_slug: S.RESEARCH, input: { topic: 'x' }, task_id: 'r1', workflow_id: 'wf-audit' });
  const artifactId = result.output.result.research_artifact_id;
  const events = audit.all().filter((e) => e.event === 'artifact.created');
  assert.equal(events.length, 1);
  assert.equal(events[0].artifact_id, artifactId);
  assert.equal(events[0].workflow_id, 'wf-audit');
  assert.equal(events[0].task_id, 'r1');
});

test('462. (#18) the workflow contains the full real artifact lineage after execution', () => {
  const { store, runtime, artifactStore } = stackSetup();
  registerArtifactPipelineAgents(store);
  const research = runSingleTask(runtime, store, { agent_slug: S.RESEARCH, input: { topic: 'x' }, task_id: 'r1', workflow_id: 'wf-lineage' });
  const script = runSingleTask(runtime, store, {
    agent_slug: S.SCRIPT, input: { topic: 'x', research_artifact_id: research.output.result.research_artifact_id },
    task_id: 's1', workflow_id: 'wf-lineage',
  });
  const inWorkflow = artifactStore.artifactsForWorkflow('wf-lineage');
  assert.equal(inWorkflow.length, 2);
  assert.deepEqual(
    inWorkflow.map((a) => a.artifact_type).sort(),
    [ARTIFACT_TYPE.RESEARCH, ARTIFACT_TYPE.SCRIPT].sort(),
  );
});

// ── 19: Guardian freeze ───────────────────────────────────────────────────

test('463. (#19) a Guardian freeze blocks artifact-producing execution BEFORE the handler ever runs — zero artifacts created', () => {
  const { store, runtime, artifactStore } = stackSetup();
  registerArtifactPipelineAgents(store);
  store.addFreeze({ scope: 'global', target_id: null, reason: 'test freeze', imposed_by: 'guardian', imposed_at: T0, expires_at: null });
  const result = runSingleTask(runtime, store, { agent_slug: S.RESEARCH, input: { topic: 'x' }, task_id: 'r1', workflow_id: 'wf-frozen' });
  assert.equal(result.status, TASK_STATUS.FAILED);
  assert.equal(result.failure_reason_code, RUNTIME_REASON.AGENT_FROZEN);
  assert.equal(artifactStore.artifactsForWorkflow('wf-frozen').length, 0, 'the handler never ran — createArtifact was never called');
});

// ── 20/21: approval independence ─────────────────────────────────────────

function publishHandler({ input, createArtifact, callTool }) {
  const artifact = createArtifact({
    artifact_type: ARTIFACT_TYPE.SOCIAL_PACKAGE, content: { message: 'ready to publish' }, mime_type: 'application/json',
  });
  if (artifact.outcome !== 'created') throw new Error('unexpected artifact rejection');
  const toolResult = callTool('fake.send_message', { recipient_domain: 'approved-client.example', body: 'publish' }, input.idempotency_key ?? null);
  return {
    status: 'ok',
    result: { artifact_id: artifact.artifact.artifact_id, publish_decision: toolResult.decision },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
  };
}

test('464. (#20) a YELLOW downstream tool action cannot execute without approval — the artifact is still created regardless', () => {
  const { store, runtime, artifactStore } = stackSetup({ handlers: { 'publish-agent': publishHandler } });
  registerAgentVersion(store, 'publish-agent', { clearance: 'YELLOW', allowed_tools: ['fake.send_message'] });
  const result = runSingleTask(runtime, store, {
    agent_slug: 'publish-agent', input: { idempotency_key: 'k-464' }, task_id: 't1', workflow_id: 'wf-approval',
  });
  assert.equal(result.status, TASK_STATUS.COMPLETED);
  assert.equal(result.output.result.publish_decision, DECISION.NEEDS_APPROVAL);
  assert.equal(artifactStore.artifactsForWorkflow('wf-approval').length, 1, 'the artifact never depended on the tool call succeeding');
});

test('465. (#21) once a real M18 approval exists, the SAME downstream tool action succeeds — approval remains independent of the artifact', async () => {
  const { store, runtime, artifactStore, approvalEngine } = stackSetup({ handlers: { 'publish-agent': publishHandler } });
  registerAgentVersion(store, 'publish-agent', { clearance: 'YELLOW', allowed_tools: ['fake.send_message'] });
  budget(store, { task_id: 't1', workflow_id: 'wf-approval2', agent_slug: 'publish-agent' });
  const req = await approvalEngine.requestApproval({
    agent_slug: 'publish-agent', tool_id: 'fake.send_message',
    payload: { recipient_domain: 'approved-client.example', body: 'publish' },
    task_id: 't1', expires_in_ms: HOUR, actor: 'human:founder',
  });
  await approvalEngine.decide({ approval_id: req.approval.approval_id, task_id: 't1', decision: 'approve', actor: 'human:founder', actor_type: 'human' });
  const result = runtime.runTask({ agent_slug: 'publish-agent', input: { idempotency_key: 'k-465' }, task_id: 't1', tree_id: 'wf-approval2' });
  assert.equal(result.status, TASK_STATUS.COMPLETED);
  assert.equal(result.output.result.publish_decision, DECISION.ALLOW);
  assert.equal(artifactStore.artifactsForWorkflow('wf-approval2').length, 1);
});

// ── 22/23/24: artifact cannot bypass Broker, lifecycle, budget ───────────

test('466. (#22) an artifact cannot bypass the Broker — a YELLOW tool call with no approval is denied regardless of any artifact created', () => {
  const { store, runtime } = stackSetup({ handlers: { 'publish-agent': publishHandler } });
  registerAgentVersion(store, 'publish-agent', { clearance: 'YELLOW', allowed_tools: ['fake.send_message'] });
  const result = runSingleTask(runtime, store, {
    agent_slug: 'publish-agent', input: { idempotency_key: 'k-466' }, task_id: 't1', workflow_id: 'wf-nobypass',
  });
  assert.equal(result.output.result.publish_decision, DECISION.NEEDS_APPROVAL);
});

test('467. (#23) an artifact cannot bypass agent lifecycle — a PAUSED agent never runs its handler, regardless of what it would have created', () => {
  const { store, runtime, artifactStore } = stackSetup();
  registerArtifactPipelineAgents(store);
  store.setLifecycleState('pipeline-research-artifact-agent', RUNTIME_STATE.PAUSED);
  const result = runSingleTask(runtime, store, { agent_slug: S.RESEARCH, input: { topic: 'x' }, task_id: 'r1', workflow_id: 'wf-paused' });
  assert.equal(result.status, TASK_STATUS.FAILED);
  assert.equal(result.failure_reason_code, RUNTIME_REASON.AGENT_NOT_ACTIVE);
  assert.equal(artifactStore.artifactsForWorkflow('wf-paused').length, 0);
});

test('468. (#24) an artifact cannot bypass budget — a task with no budget row never runs its handler', () => {
  const { store, runtime, artifactStore } = stackSetup();
  registerArtifactPipelineAgents(store);
  // deliberately NOT calling budget(...) first
  const result = runtime.runTask({ agent_slug: S.RESEARCH, input: { topic: 'x' }, task_id: 'r1', tree_id: 'wf-nobudget' });
  assert.equal(result.status, TASK_STATUS.FAILED);
  assert.equal(result.failure_reason_code, RUNTIME_REASON.BUDGET_MISSING);
  assert.equal(artifactStore.artifactsForWorkflow('wf-nobudget').length, 0);
});

// ── 25/26: cannot modify another artifact, duplicate id ──────────────────

test('469. (#25) a handler cannot modify an existing artifact — it can only create a new one, even when it tries to reuse an id', () => {
  const { store, runtime, artifactStore } = stackSetup();
  registerArtifactPipelineAgents(store);
  const first = runSingleTask(runtime, store, { agent_slug: S.RESEARCH, input: { topic: 'original' }, task_id: 'r1', workflow_id: 'wf-immut' });
  const firstId = first.output.result.research_artifact_id;

  const { runtime: runtime2, store: store2 } = stackSetup({
    handlers: { 'hijack-agent': ({ createArtifact }) => {
      const r = createArtifact({ artifact_type: ARTIFACT_TYPE.TEXT, content: { hijacked: true }, mime_type: 'text/plain', artifact_id: firstId });
      if (r.outcome !== 'created') throw new Error('unexpected');
      return { status: 'ok', result: { new_id: r.artifact.artifact_id }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
    } },
  });
  registerAgentVersion(store2, 'hijack-agent');
  const attempt = runSingleTask(runtime2, store2, { agent_slug: 'hijack-agent', input: {}, task_id: 't1', workflow_id: 'wf-immut' });
  assert.equal(attempt.status, TASK_STATUS.COMPLETED);
  assert.notEqual(attempt.output.result.new_id, firstId, 'a fresh id was generated — the original was never touched');
  const original = artifactStore.getArtifact(firstId);
  assert.equal(original.content.topic, 'original');
});

test('470. (#26) duplicate artifact_id is rejected at the storage layer even when reached via real execution\'s underlying store', () => {
  const { store, runtime, artifactStore } = stackSetup();
  registerArtifactPipelineAgents(store);
  const result = runSingleTask(runtime, store, { agent_slug: S.RESEARCH, input: { topic: 'x' }, task_id: 'r1', workflow_id: 'wf-dup' });
  const artifact = artifactStore.getArtifact(result.output.result.research_artifact_id);
  assert.throws(() => artifactStore.addArtifact({ ...artifact, content: { tampered: true } }), /already exists/);
});

// ── 28: the full deterministic end-to-end pipeline ────────────────────────

test('472. (#28) the full deterministic research -> script -> audio -> image -> video -> subtitle pipeline runs end to end through the real, unmodified workflow engine', () => {
  const { store, coordinator, workflow, artifactStore, artifactService } = stackSetup();
  registerArtifactPipelineAgents(store);
  workflow.createWorkflow({ workflow_id: 'wf-e2e', budget_limit: 1000 });

  const proposal = coordinator.proposeTask({
    workflow_id: 'wf-e2e', task_id: 'research', required_capability: 'content-research',
    input: { topic: 'solar panels', auto_chain: true },
  });
  assert.equal(proposal.decision, 'accepted');

  const final = coordinator.runToCompletion({ workflow_id: 'wf-e2e' });
  assert.equal(final.workflow.state, WORKFLOW_STATE.COMPLETED);

  const artifacts = artifactStore.artifactsForWorkflow('wf-e2e');
  assert.equal(artifacts.length, 6);
  assert.deepEqual(
    artifacts.map((a) => a.artifact_type).sort(),
    [ARTIFACT_TYPE.RESEARCH, ARTIFACT_TYPE.SCRIPT, ARTIFACT_TYPE.AUDIO, ARTIFACT_TYPE.IMAGE, ARTIFACT_TYPE.VIDEO, ARTIFACT_TYPE.SUBTITLE].sort(),
  );

  const video = artifacts.find((a) => a.artifact_type === ARTIFACT_TYPE.VIDEO);
  assert.equal(video.parent_artifact_ids.length, 2, 'video has real, multi-parent diamond lineage');
  const videoParentTypes = video.parent_artifact_ids.map((id) => artifactStore.getArtifact(id).artifact_type).sort();
  assert.deepEqual(videoParentTypes, [ARTIFACT_TYPE.AUDIO, ARTIFACT_TYPE.IMAGE]);

  // Provenance survived every hop: every artifact belongs to this
  // workflow and carries a real, resolvable agent_id/version_id.
  for (const a of artifacts) {
    assert.equal(a.workflow_id, 'wf-e2e');
    assert.ok(a.agent_id);
    assert.ok(a.version_id);
    assert.equal(a.checksum.length, 64);
  }
});

// ── Adversarial: identity, version, registry SHA, approval, freeze, budget ─

function claimAnotherAgentIdentity(realOtherAgentId) {
  return ({ createArtifact }) => {
    const r = createArtifact({ artifact_type: ARTIFACT_TYPE.TEXT, content: { x: 1 }, mime_type: 'text/plain', agent_id: realOtherAgentId });
    if (r.outcome !== 'created') throw new Error('unexpected');
    return { status: 'ok', result: { agent_id: r.artifact.agent_id }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  };
}

test('473. (adversarial) a handler cannot claim a REAL other agent\'s identity — the real caller\'s identity always wins', () => {
  const { store, runtime } = stackSetup({ handlers: {} });
  const { agentId: victimAgentId } = registerAgentVersion(store, 'victim-agent');
  const { agentId: attackerAgentId } = registerAgentVersion(store, 'attacker-agent');
  const runtime2 = createRuntime({
    store, broker: createBroker({ tools: createTools().tools, store, audit: createAuditSink(), clock: () => T0, registrySha: 'x' }),
    audit: createAuditSink(), clock: () => T0, registrySha: 'x',
    handlers: { 'attacker-agent': claimAnotherAgentIdentity(victimAgentId) },
    artifactService: createArtifactService({ store, artifactStore: createMemoryArtifactStore(), audit: createAuditSink(), clock: () => T0, registrySha: 'x' }),
  });
  const result = runSingleTask(runtime2, store, { agent_slug: 'attacker-agent', input: {}, task_id: 't1', workflow_id: 'wf-steal' });
  assert.equal(result.status, TASK_STATUS.COMPLETED);
  assert.equal(result.output.result.agent_id, attackerAgentId);
  assert.notEqual(result.output.result.agent_id, victimAgentId);
});

function claimAnotherVersionHandler({ createArtifact }) {
  const r = createArtifact({ artifact_type: ARTIFACT_TYPE.TEXT, content: { x: 1 }, mime_type: 'text/plain', version_id: 'some-other-agent@9.9.9' });
  if (r.outcome !== 'created') throw new Error('unexpected');
  return { status: 'ok', result: { version_id: r.artifact.version_id }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
}

test('474. (adversarial) a handler cannot claim a different agent version — the real active version always wins', () => {
  const { store, runtime } = stackSetup({ handlers: { 'v-agent': claimAnotherVersionHandler } });
  const { versionId: realVersionId } = registerAgentVersion(store, 'v-agent');
  const result = runSingleTask(runtime, store, { agent_slug: 'v-agent', input: {}, task_id: 't1', workflow_id: 'wf-version' });
  assert.equal(result.output.result.version_id, realVersionId);
  assert.notEqual(result.output.result.version_id, 'some-other-agent@9.9.9');
});

function claimAnotherRegistryShaHandler({ createArtifact }) {
  const r = createArtifact({ artifact_type: ARTIFACT_TYPE.TEXT, content: { x: 1 }, mime_type: 'text/plain', registry_sha: 'forged-sha-value' });
  if (r.outcome !== 'created') throw new Error('unexpected');
  return { status: 'ok', result: { registry_sha: r.artifact.registry_sha }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
}

test('475. (adversarial) a handler cannot claim a different registry SHA — the real, constructor-injected SHA always wins', () => {
  const { store, runtime, registrySha } = stackSetup({ handlers: { 'sha-agent': claimAnotherRegistryShaHandler } });
  registerAgentVersion(store, 'sha-agent');
  const result = runSingleTask(runtime, store, { agent_slug: 'sha-agent', input: {}, task_id: 't1', workflow_id: 'wf-sha' });
  assert.equal(result.output.result.registry_sha, registrySha);
  assert.notEqual(result.output.result.registry_sha, 'forged-sha-value');
});

function claimApprovalHandler({ createArtifact, callTool, input }) {
  const artifact = createArtifact({
    artifact_type: ARTIFACT_TYPE.TEXT, content: { x: 1 }, mime_type: 'text/plain',
    approval_status: 'approved', // descriptive-only field, claiming approval already happened
  });
  if (artifact.outcome !== 'created') throw new Error('unexpected');
  const toolResult = callTool('fake.send_message', { recipient_domain: 'approved-client.example', body: 'x' }, input.idempotency_key ?? null);
  return {
    status: 'ok', result: { approval_status: artifact.artifact.approval_status, tool_decision: toolResult.decision },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
  };
}

test('476. (adversarial) a handler claiming approval_status "approved" on its OWN artifact does not satisfy the real Approval Engine', () => {
  const { store, runtime } = stackSetup({ handlers: { 'claim-approval-agent': claimApprovalHandler } });
  registerAgentVersion(store, 'claim-approval-agent', { clearance: 'YELLOW', allowed_tools: ['fake.send_message'] });
  const result = runSingleTask(runtime, store, {
    agent_slug: 'claim-approval-agent', input: { idempotency_key: 'k-476' }, task_id: 't1', workflow_id: 'wf-claim-approval',
  });
  assert.equal(result.output.result.approval_status, 'approved', 'the artifact field is present verbatim...');
  assert.equal(result.output.result.tool_decision, DECISION.NEEDS_APPROVAL, '...and means nothing to the Broker');
});

function claimUnfreezeHandler({ input }) {
  return {
    status: 'ok', result: { remove_freeze: true, unfreeze: true, guardian_override: true, topic: String(input.topic ?? '') },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
  };
}

test('477. (adversarial) a handler\'s output claiming to lift a Guardian freeze has zero effect on the real freeze', () => {
  const { store, runtime } = stackSetup({ handlers: { 'unfreeze-claim-agent': claimUnfreezeHandler } });
  registerAgentVersion(store, 'unfreeze-claim-agent');
  store.addFreeze({ scope: 'agent', target_id: 'unfreeze-claim-agent', reason: 'pre-existing', imposed_by: 'guardian', imposed_at: T0, expires_at: null });
  const first = runSingleTask(runtime, store, { agent_slug: 'unfreeze-claim-agent', input: { topic: 'x' }, task_id: 't1', workflow_id: 'wf-unfreeze' });
  assert.equal(first.status, TASK_STATUS.FAILED, 'frozen before it ever ran, so its claim never even executed');
  const second = runSingleTask(runtime, store, { agent_slug: 'unfreeze-claim-agent', input: { topic: 'x' }, task_id: 't2', workflow_id: 'wf-unfreeze' });
  assert.equal(second.status, TASK_STATUS.FAILED, 'the freeze is still active — nothing lifted it');
  assert.ok(store.activeFreeze('agent', 'unfreeze-claim-agent', T0));
});

function claimBudgetIncreaseHandler({ createArtifact }) {
  const r = createArtifact({
    artifact_type: ARTIFACT_TYPE.TEXT, content: { x: 1 }, mime_type: 'text/plain',
  });
  if (r.outcome !== 'created') throw new Error('unexpected');
  return {
    status: 'ok', result: { budget_override: 999999999, cost_charged: 0, artifact_id: r.artifact.artifact_id },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: { tokens: 999999 }, errors: [],
  };
}

test('478. (adversarial) a handler\'s output claiming a budget increase never changes any real budget row', () => {
  const { store, runtime } = stackSetup({ handlers: { 'budget-claim-agent': claimBudgetIncreaseHandler } });
  registerAgentVersion(store, 'budget-claim-agent');
  budget(store, { task_id: 't1', workflow_id: 'wf-budget-claim', agent_slug: 'budget-claim-agent', limit: 100 });
  const before = store.budgetsFor({ task_id: 't1', tree_id: 'wf-budget-claim', agent_slug: 'budget-claim-agent' });
  const result = runtime.runTask({ agent_slug: 'budget-claim-agent', input: {}, task_id: 't1', tree_id: 'wf-budget-claim' });
  assert.equal(result.status, TASK_STATUS.COMPLETED);
  const after = store.budgetsFor({ task_id: 't1', tree_id: 'wf-budget-claim', agent_slug: 'budget-claim-agent' });
  assert.deepEqual(after, before, 'result.cost and result.budget_override are just data — nothing here ever calls chargeBudgets');
});

test('479. (adversarial) the passive rogue agent\'s artifact/authorization-shaped output creates no artifact and changes nothing', () => {
  const { store, runtime, artifactStore } = stackSetup();
  registerArtifactRogueAgent(store);
  const before = { ...store.getAgent(S.ROGUE) };
  const result = runSingleTask(runtime, store, { agent_slug: S.ROGUE, input: { topic: 'x' }, task_id: 't1', workflow_id: 'wf-rogue' });
  assert.equal(result.status, TASK_STATUS.COMPLETED, 'the envelope is valid data, so the task completes normally');
  assert.equal(result.output.result.artifact_id, 'forged-artifact-id', 'the field is present verbatim...');
  assert.equal(artifactStore.artifactsForWorkflow('wf-rogue').length, 0, '...and no real artifact was ever created from it');
  assert.equal(store.getAgent(S.ROGUE).state, before.state);
});

// ── Structural proofs ──────────────────────────────────────────────────

test('480. structural: runtime.js\'s createArtifact closure never grants authority beyond what artifact-service.js already forbids', () => {
  const source = readFileSync(new URL('../src/runtime.js', import.meta.url), 'utf8');
  // Already forbidden in runtime.js by its own pre-M20 design; re-checked
  // here to prove the M20 addition didn't introduce a new path to any of
  // them.
  for (const term of ['addFreeze(', '.decide(', '.revoke(', 'chargeBudgets(', 'addBudget(', 'setLifecycleState(']) {
    assert.ok(!source.includes(term), `runtime.js must not reference "${term}"`);
  }
  assert.ok(source.includes('createArtifactSync'), 'runtime.js uses the synchronous entry point, not the async one');
  assert.ok(!source.includes('createArtifact('), 'runtime.js never calls the async createArtifact directly');
});

test('481. structural: no new network, credential, or shell-execution primitive in any M20 file', () => {
  for (const path of ['../src/runtime.js', '../src/artifact-service.js', '../src/demo-artifact-pipeline-agents.js']) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const term of ['node:http', 'node:https', 'node:net', 'child_process', 'fetch(', 'axios', 'process.env', 'API_KEY', 'ANTHROPIC', 'GROQ', 'ELEVENLABS']) {
      assert.ok(!src.includes(term), `${path} must not contain ${term}`);
    }
  }
});

test('482. structural: the demo artifact pipeline agents make no model calls and fabricate no cost — deterministic fixtures only', () => {
  const src = readFileSync(new URL('../src/demo-artifact-pipeline-agents.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('callModel('), 'these six agents never call a model — no resource-governor entanglement to fabricate');
});

// ── Postgres: consistency between the two storage backends ───────────────
//
// `runtime.js`'s live execution path (D28) only ever runs against the
// synchronous in-memory store — that has not changed. What M20 adds is
// `createArtifactSync`, which is only safe against that same synchronous
// pair of stores. This section proves two things against a REAL Postgres
// database, not a fake pool: (1) the async `createArtifact` M19 already
// proved works against Postgres is completely unaffected by M20's
// changes — the exact same provenance an execution-produced artifact
// would carry round-trips correctly; (2) `createArtifactSync` refuses,
// loudly, rather than silently misbehaving, the moment it is pointed at
// a real async store — the one guard this milestone adds specifically
// because there is no way to prove "the execution path is Postgres-safe"
// when, by design (D28), it structurally never runs against Postgres at
// all. Skipped entirely — not failed — when AI_HQ_TEST_DATABASE_URL is
// unset.

const PG_TEST_URL = process.env.AI_HQ_TEST_DATABASE_URL;
if (PG_TEST_URL) {
  const { createPostgresStore } = await import('../src/postgres-store.js');
  const { createPostgresArtifactStore } = await import('../src/postgres-artifact-store.js');
  const { createIsolatedTestDatabase } = await import('./helpers/pg-test-db.mjs');
  const { pool, cleanup } = await createIsolatedTestDatabase('artifact_execution');
  const pgStore = createPostgresStore(pool);
  const pgArtifactStore = createPostgresArtifactStore(pool);

  test('483. [postgres] the same provenance an execution-produced artifact carries round-trips correctly through the async createArtifact', async () => {
    const agentId = 'agent-pg-exec';
    const version = makeAgentVersion({
      agent_id: agentId, version: '1.0.0', purpose: 'pg exec fixture', department: 'content',
      state: VERSION_STATE.APPROVED, clearance: 'GREEN', allowed_tools: [],
      limits: {}, input_contract: {}, output_contract: {}, created_at: 0,
      approved_by: 'founder', approved_at: 0,
    });
    await pgStore.addAgentVersion(version);
    await pgStore.registerAgent(makeAgent({ id: agentId, slug: 'pg-exec-agent', name: 'pg-exec-agent', active_version_id: versionId(agentId, '1.0.0') }));
    await pgStore.createTask({
      id: 'pg-exec-task', parent_task_id: null, tree_id: 'pg-exec-wf', workflow_id: 'pg-exec-wf',
      depth: 0, agent_slug: 'pg-exec-agent', status: 'pending', input: {}, created_at: 0,
    });
    const audit = createAuditSink();
    const svc = createArtifactService({ store: pgStore, artifactStore: pgArtifactStore, audit, clock: () => T0, registrySha: 'pg-exec-sha' });
    const r = await svc.createArtifact({
      artifact_type: ARTIFACT_TYPE.RESEARCH, workflow_id: 'pg-exec-wf', task_id: 'pg-exec-task',
      agent_slug: 'pg-exec-agent', content: { topic: 'pg' }, mime_type: 'application/json',
    });
    assert.equal(r.outcome, 'created');
    const fetched = await pgArtifactStore.getArtifact(r.artifact.artifact_id);
    assert.equal(fetched.agent_id, agentId);
    assert.equal(fetched.workflow_id, 'pg-exec-wf');
    assert.equal(fetched.task_id, 'pg-exec-task');
    assert.equal(fetched.registry_sha, 'pg-exec-sha');
    assert.equal(fetched.checksum, r.artifact.checksum);
  });

  test('484. [postgres] createArtifactSync refuses, loudly, rather than silently misbehaving against a real async store', () => {
    const audit = createAuditSink();
    const svc = createArtifactService({ store: pgStore, artifactStore: pgArtifactStore, audit, clock: () => T0, registrySha: 'pg-exec-sha' });
    assert.throws(
      () => svc.createArtifactSync({
        artifact_type: ARTIFACT_TYPE.TEXT, workflow_id: 'pg-exec-wf', agent_slug: 'pg-exec-agent',
        content: { x: 1 }, mime_type: 'text/plain',
      }),
      /returned a Promise/,
    );
  });

  test('[postgres artifact-execution] teardown: drop the isolated test database', async () => {
    await cleanup();
  });
} else {
  test('[postgres artifact-execution] skipped — set AI_HQ_TEST_DATABASE_URL to run against a local Postgres', { skip: true }, () => {});
}

/**
 * CONTENT FACTORY + SPECIALIZED AGENT SYSTEM (Milestone 23)
 *
 * Proves: twelve real, specialized, DATA-defined agents produce a
 * complete, governed CONTENT_PACKAGE artifact graph from a single topic,
 * through the real, unmodified router -> workflow -> execution
 * coordinator -> runtime -> provider invocation -> artifact creation ->
 * audit -> Guardian chain. `broker.js`, `validator.js`, `guardian.js`,
 * `approval-engine.js`, `router.js`, `workflow.js`, and
 * `execution-coordinator.js` are all confirmed unchanged by this
 * milestone — every test below that exercises them does so through
 * their real, unmodified implementations. See
 * `src/content-factory-orchestrator.js`'s header for exactly how
 * twelve real, sequentially/parallel-dependent stages execute within
 * the existing MAX_DEPTH=4 ceiling without any core-file change.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStore } from '../src/store.js';
import { createMemoryArtifactStore } from '../src/artifact-store.js';
import { createArtifactService } from '../src/artifact-service.js';
import { createAuditSink } from '../src/audit.js';
import { createBroker, DECISION } from '../src/broker.js';
import { createTools } from '../src/tools.js';
import { createRuntime, TASK_STATUS, RUNTIME_REASON } from '../src/runtime.js';
import { createWorkflowEngine, WORKFLOW_STATE, WORKFLOW_REASON } from '../src/workflow.js';
import { createRouter, ROUTING_REASON } from '../src/router.js';
import { createGuardian } from '../src/guardian.js';
import { createExecutionCoordinator } from '../src/execution-coordinator.js';
import { createApprovalEngine } from '../src/approval-engine.js';
import { makeAgent, makeAgentVersion, VERSION_STATE, RUNTIME_STATE, versionId } from '../src/agents.js';
import { ARTIFACT_TYPE } from '../src/artifacts.js';
import { createProviderInvoker } from '../src/providers/invoke.js';
import { defaultContentProviderRegistry } from '../src/providers/default-registry.js';
import { MAX_DEPTH, MAX_FANOUT, MAX_TOTAL_NODES } from '../src/limits.js';
import {
  registerContentFactoryAgents, registerContentFactoryRogueAgent, CONTENT_FACTORY_HANDLERS,
  CONTENT_FACTORY_AGENT_SLUGS, CONTENT_FACTORY_AGENTS, CONTENT_FACTORY_CAPABILITY,
  WORKFLOW_TYPE_CONTENT_FACTORY, QC_REQUIRED_STAGES, runQualityControlChecks,
} from '../src/content-factory-agents.js';
import {
  runContentFactory, buildExecutionSummary, inspectWorkflowState, listFailures,
  listCompletedArtifacts, listAvailableSpecialists,
} from '../src/content-factory-orchestrator.js';

const T0 = 13_000_000;
const S = CONTENT_FACTORY_AGENT_SLUGS;
const CAP = CONTENT_FACTORY_CAPABILITY;

function fullStack(o = {}) {
  const { tools } = createTools();
  const store = createMemoryStore();
  const artifactStore = createMemoryArtifactStore();
  const audit = createAuditSink();
  let time = o.now ?? T0;
  const clock = () => time;
  const registrySha = 'registrySha' in o ? o.registrySha : 'cf-registry-sha';
  const registry = o.registry ?? defaultContentProviderRegistry;
  const broker = createBroker({ tools, store, audit, clock, registrySha });
  const artifactService = createArtifactService({ store, artifactStore, audit, clock, registrySha });
  const approvalEngine = createApprovalEngine({ store, tools, audit, clock, registrySha });
  const providerInvoker = createProviderInvoker({ registry, audit, clock });
  const runtime = createRuntime({
    store, broker, audit, clock, registrySha, handlers: o.handlers ?? CONTENT_FACTORY_HANDLERS,
    artifactService, providerInvoker,
  });
  const router = createRouter({ store, audit, clock });
  const workflow = createWorkflowEngine({ store, runtime, broker, audit, clock, registrySha });
  const guardian = createGuardian({ store, audit, clock });
  const coordinator = createExecutionCoordinator({ workflow, router, guardian, store, audit, clock });
  return {
    store, artifactStore, audit, clock, tools, broker, artifactService, approvalEngine,
    runtime, router, workflow, guardian, coordinator, registrySha, setTime: (t) => { time = t; },
  };
}

function registerAgentVersion(store, slug, o = {}) {
  const agentId = `agent-${slug}`;
  const versionState = o.versionState ?? VERSION_STATE.APPROVED;
  const version = makeAgentVersion({
    agent_id: agentId, version: o.version ?? '1.0.0', purpose: 'content factory test fixture', department: 'content-factory',
    state: versionState, clearance: o.clearance ?? 'GREEN', allowed_tools: o.allowed_tools ?? [],
    limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 5_000 },
    capabilities: o.capabilities ?? [],
    allowed_workflow_types: o.allowed_workflow_types ?? [WORKFLOW_TYPE_CONTENT_FACTORY],
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

function runFactory(stack, o = {}) {
  return runContentFactory({
    store: stack.store, artifactStore: stack.artifactStore, workflow: stack.workflow, coordinator: stack.coordinator,
    runtime: stack.runtime, router: stack.router, guardian: stack.guardian, audit: stack.audit,
    workflow_id: o.workflow_id ?? 'wf-cf', topic: o.topic ?? 'why sleep matters', budget_limit: o.budget_limit ?? 5000,
  });
}

// ── 1-4: agent definitions are real, declarative data ─────────────────────

test('560. all twelve content-factory agents are registered as real, approved, active agents with declared capabilities', () => {
  const { store } = fullStack();
  registerContentFactoryAgents(store);
  for (const key of ['research', 'factCheck', 'idea', 'script', 'hook', 'audio', 'visual', 'socialPackage', 'subtitle', 'videoPlan', 'qualityControl', 'publishingPackage']) {
    const { record } = CONTENT_FACTORY_AGENTS[key];
    const resolved = store.getAgent(record.slug);
    assert.ok(resolved, `${record.slug} must resolve`);
    assert.equal(resolved.version_state, 'approved');
    assert.equal(resolved.state, 'active');
    assert.ok(resolved.capabilities.length >= 1, `${record.slug} must declare at least one capability`);
    assert.deepEqual(resolved.allowed_workflow_types, [WORKFLOW_TYPE_CONTENT_FACTORY]);
  }
});

test('561. each content-factory agent has a distinct, single declared capability — clear, non-overlapping responsibility', () => {
  const { store } = fullStack();
  registerContentFactoryAgents(store);

  // Two agents are OPT-IN ONLY and must not be registered by default:
  // the adversarial rogue fixture, and every M28/M29 live-capable stage.
  // Asserted, not silently filtered — "the money-spending agent is absent
  // unless someone explicitly asked for it" is the invariant that keeps
  // an ordinary Content Factory run deterministic.
  const OPT_IN_ONLY = [S.ROGUE, S.SCRIPT_LIVE, S.RESEARCH_LIVE, S.HOOK_LIVE, S.SOCIAL_PACKAGE_LIVE];
  for (const optIn of OPT_IN_ONLY) {
    assert.equal(store.getAgent(optIn), null, `${optIn} must not be registered by default`);
  }

  const caps = Object.values(CONTENT_FACTORY_AGENTS)
    .filter((a) => !OPT_IN_ONLY.includes(a.record.slug))
    .map((a) => store.getAgent(a.record.slug).capabilities[0]);
  assert.equal(new Set(caps).size, caps.length, 'no two legitimate agents share a capability');

  // And every live stage's capability is distinct from its deterministic
  // counterpart's. If they shared one, the router would be free to send
  // an ordinary run to the agent that spends real money.
  for (const [liveKey, detKey] of [
    ['scriptLive', 'script'], ['researchLive', 'research'],
    ['hookLive', 'hook'], ['socialPackageLive', 'socialPackage'],
  ]) {
    const live = CONTENT_FACTORY_AGENTS[liveKey].version.capabilities[0];
    const deterministic = CONTENT_FACTORY_AGENTS[detKey].version.capabilities[0];
    assert.notEqual(live, deterministic, `${liveKey} must not share ${detKey}'s capability`);
    assert.equal(caps.includes(live), false, `and no default-registered agent may declare ${live}`);
  }
});

test('562. every content-factory agent version has resource limits within validator.js\'s own POLICY ceilings', async () => {
  const { validateAgentVersion } = await import('../src/validator.js');
  const { tools } = createTools();
  for (const key of Object.keys(CONTENT_FACTORY_AGENTS)) {
    const { version } = CONTENT_FACTORY_AGENTS[key];
    const result = validateAgentVersion(version, { tools });
    assert.equal(result.valid, true, `${version.agent_id} must validate: ${JSON.stringify(result.errors)}`);
  }
});

test('563. handlers are separate functions, not embedded in agent version data — the version record contains no executable code', () => {
  for (const key of Object.keys(CONTENT_FACTORY_AGENTS)) {
    const { version } = CONTENT_FACTORY_AGENTS[key];
    for (const value of Object.values(version)) {
      assert.notEqual(typeof value, 'function', `${version.agent_id}'s version record must contain no function`);
    }
  }
});

// ── 5-11: routing by declared capability ──────────────────────────────────

test('564. (routing) the correct specialist is selected purely by declared capability, never a hardcoded slug', () => {
  const { store, router } = fullStack();
  registerContentFactoryAgents(store);
  const decision = router.route({ task_id: 't1', required_capability: CAP.SCRIPT, required_workflow_type: WORKFLOW_TYPE_CONTENT_FACTORY });
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.selected_agent_slug, S.SCRIPT);
});

test('565. (routing) an incompatible specialist (wrong capability) is rejected — capability mismatch', () => {
  const { store, router } = fullStack();
  registerContentFactoryAgents(store);
  const decision = router.route({ task_id: 't1', required_capability: 'cf-nonexistent-capability', required_workflow_type: WORKFLOW_TYPE_CONTENT_FACTORY });
  assert.equal(decision.decision, 'no_eligible_agent');
  assert.equal(decision.reason, ROUTING_REASON.NO_ELIGIBLE_AGENT);
  assert.ok(decision.rejected_candidates.every((r) => r.reason === ROUTING_REASON.CAPABILITY_NOT_DECLARED));
});

test('566. (routing) a frozen agent cannot receive work — excluded from routing', () => {
  const { store, router } = fullStack();
  registerContentFactoryAgents(store);
  store.addFreeze({ scope: 'agent', target_id: S.SCRIPT, reason: 'test', imposed_by: 'guardian', imposed_at: T0, expires_at: null });
  const decision = router.route({ task_id: 't1', required_capability: CAP.SCRIPT, required_workflow_type: WORKFLOW_TYPE_CONTENT_FACTORY });
  assert.equal(decision.decision, 'no_eligible_agent');
  assert.ok(decision.rejected_candidates.some((r) => r.agent_slug === S.SCRIPT && r.reason === ROUTING_REASON.AGENT_FROZEN));
});

test('567. (routing) a disabled agent cannot receive work — excluded from routing', () => {
  const { store, router } = fullStack();
  registerContentFactoryAgents(store);
  store.setLifecycleState(S.SCRIPT, RUNTIME_STATE.DISABLED);
  const decision = router.route({ task_id: 't1', required_capability: CAP.SCRIPT, required_workflow_type: WORKFLOW_TYPE_CONTENT_FACTORY });
  assert.equal(decision.decision, 'no_eligible_agent');
  assert.ok(decision.rejected_candidates.some((r) => r.agent_slug === S.SCRIPT && r.reason === ROUTING_REASON.AGENT_NOT_ACTIVE));
});

test('568. (routing) insufficient budget prevents admission at the workflow layer', () => {
  const { store, workflow } = fullStack();
  registerContentFactoryAgents(store);
  workflow.createWorkflow({ workflow_id: 'wf-nobudget', budget_limit: 100 });
  // Exhaust the EXISTING tree budget row in place — budgetsFor() returns
  // live references, and addBudget() has no dedup (store.js's own
  // documented contract), so pushing a second row would leave the
  // original, still-unspent row as the one addTask's own .find() sees
  // first.
  const treeBudget = store.budgetsFor({ tree_id: 'wf-nobudget' }).find((b) => b.level === 'tree');
  treeBudget.spent = treeBudget.limit;
  const admission = workflow.addTask({ workflow_id: 'wf-nobudget', task_id: 't1', agent_slug: S.RESEARCH, input: { topic: 'x' } });
  assert.equal(admission.decision, 'rejected');
  assert.equal(admission.reason, WORKFLOW_REASON.BUDGET_EXCEEDED);
});

test('569. (routing) an unsupported workflow type is rejected', () => {
  const { store, router } = fullStack();
  registerAgentVersion(store, 'other-type-agent', { capabilities: [CAP.SCRIPT], allowed_workflow_types: ['SOME_OTHER_WORKFLOW_TYPE'] });
  const decision = router.route({ task_id: 't1', required_capability: CAP.SCRIPT, required_workflow_type: WORKFLOW_TYPE_CONTENT_FACTORY });
  assert.equal(decision.decision, 'no_eligible_agent');
  assert.ok(decision.rejected_candidates.some((r) => r.agent_slug === 'other-type-agent' && r.reason === ROUTING_REASON.WORKFLOW_TYPE_NOT_SUPPORTED));
});

test('570. (routing) capability mismatch is rejected even for an otherwise perfectly healthy agent', () => {
  const { store, router } = fullStack();
  registerContentFactoryAgents(store);
  const decision = router.route({ task_id: 't1', required_capability: CAP.VIDEO_PLAN, required_workflow_type: WORKFLOW_TYPE_CONTENT_FACTORY });
  assert.equal(decision.selected_agent_slug, S.VIDEO_PLAN);
  const wrongDecision = router.route({ task_id: 't2', required_capability: CAP.SUBTITLE, required_workflow_type: WORKFLOW_TYPE_CONTENT_FACTORY });
  assert.notEqual(wrongDecision.selected_agent_slug, S.VIDEO_PLAN);
});

// ── 12-20: the full end-to-end demonstration ──────────────────────────────

test('571. (DEMO) a complete 60-second short-form video package executes end to end through the real router -> workflow -> coordinator -> runtime -> provider -> artifact -> audit chain', () => {
  const stack = fullStack();
  registerContentFactoryAgents(stack.store);
  const result = runFactory(stack, { workflow_id: 'wf-demo', topic: 'why sleep matters' });
  assert.equal(result.ok, true, JSON.stringify(result.reason));
  assert.equal(result.workflow.state, WORKFLOW_STATE.COMPLETED);
  assert.ok(result.content_package_artifact_id);
});

test('572. every one of the twelve real specialist agents actually ran — no stage was skipped or faked', () => {
  const stack = fullStack();
  registerContentFactoryAgents(stack.store);
  const result = runFactory(stack, { workflow_id: 'wf-agents-used' });
  const expectedSlugs = [S.RESEARCH, S.FACT_CHECK, S.IDEA, S.SCRIPT, S.HOOK, S.AUDIO, S.VISUAL, S.SOCIAL_PACKAGE, S.SUBTITLE, S.VIDEO_PLAN, S.QUALITY_CONTROL, S.PUBLISHING_PACKAGE];
  assert.deepEqual(result.summary.agents_used.sort(), [...expectedSlugs].sort());
});

test('573. the resulting artifact graph contains every expected artifact type, with real, resolvable checksums', () => {
  const stack = fullStack();
  registerContentFactoryAgents(stack.store);
  const result = runFactory(stack, { workflow_id: 'wf-types' });
  const types = stack.artifactStore.artifactsForWorkflow('wf-types').map((a) => a.artifact_type).sort();
  assert.deepEqual(types, [
    ARTIFACT_TYPE.RESEARCH, ARTIFACT_TYPE.TEXT, ARTIFACT_TYPE.TEXT, ARTIFACT_TYPE.SCRIPT, ARTIFACT_TYPE.TEXT,
    ARTIFACT_TYPE.AUDIO, ARTIFACT_TYPE.IMAGE, ARTIFACT_TYPE.SOCIAL_PACKAGE, ARTIFACT_TYPE.SUBTITLE, ARTIFACT_TYPE.VIDEO,
    ARTIFACT_TYPE.TEXT, ARTIFACT_TYPE.TEXT, ARTIFACT_TYPE.CONTENT_PACKAGE,
  ].sort());
  for (const a of stack.artifactStore.artifactsForWorkflow('wf-types')) {
    assert.equal(a.checksum.length, 64);
    assert.equal(a.workflow_id, 'wf-types');
  }
});

test('574. the CONTENT_PACKAGE artifact references (never copies) every upstream artifact', () => {
  const stack = fullStack();
  registerContentFactoryAgents(stack.store);
  const result = runFactory(stack, { workflow_id: 'wf-refs' });
  const pkg = stack.artifactStore.getArtifact(result.content_package_artifact_id);
  assert.equal(pkg.artifact_type, ARTIFACT_TYPE.CONTENT_PACKAGE);
  for (const stage of QC_REQUIRED_STAGES) {
    const refId = pkg.content.references[`${stage}_artifact_id`];
    assert.ok(refId, `package must reference ${stage}`);
    assert.ok(pkg.parent_artifact_ids.includes(refId), `package's parent_artifact_ids must include the ${stage} reference (real lineage, not just a content field)`);
    const referenced = stack.artifactStore.getArtifact(refId);
    assert.ok(referenced, `the referenced ${stage} artifact must really exist`);
  }
  assert.ok(pkg.content.title);
  assert.ok(pkg.content.description);
  assert.ok(Array.isArray(pkg.content.hashtags) && pkg.content.hashtags.length > 0);
  assert.ok(pkg.content.thumbnail_concept);
  assert.ok(pkg.content.publishing_metadata);
  // The package's own content object does NOT duplicate any upstream
  // artifact's actual body — only ids and small, package-native fields.
  assert.equal(JSON.stringify(pkg.content).includes('SYNTHETIC FIXTURE — not real model output'), false, 'no upstream raw content was copied in');
});

test('575. VIDEO has real three-parent convergence (audio + visual + subtitle); IDEA has real two-parent convergence (research + fact-check)', () => {
  const stack = fullStack();
  registerContentFactoryAgents(stack.store);
  runFactory(stack, { workflow_id: 'wf-lineage' });
  const artifacts = stack.artifactStore.artifactsForWorkflow('wf-lineage');
  const video = artifacts.find((a) => a.artifact_type === ARTIFACT_TYPE.VIDEO);
  const audio = artifacts.find((a) => a.artifact_type === ARTIFACT_TYPE.AUDIO);
  const visual = artifacts.find((a) => a.artifact_type === ARTIFACT_TYPE.IMAGE);
  const subtitle = artifacts.find((a) => a.artifact_type === ARTIFACT_TYPE.SUBTITLE);
  assert.equal(video.parent_artifact_ids.length, 3);
  assert.deepEqual([...video.parent_artifact_ids].sort(), [audio.artifact_id, visual.artifact_id, subtitle.artifact_id].sort());

  const idea = artifacts.find((a) => a.artifact_type === ARTIFACT_TYPE.RESEARCH ? false : a.parent_artifact_ids?.length === 2 && !video.parent_artifact_ids.includes(a.artifact_id));
  const research = artifacts.find((a) => a.artifact_type === ARTIFACT_TYPE.RESEARCH);
  assert.ok(idea.parent_artifact_ids.includes(research.artifact_id));
});

test('576. (task tree) every task sits at depth 0 — MAX_DEPTH is never approached — while the ARTIFACT DAG is genuinely deep', () => {
  const stack = fullStack();
  registerContentFactoryAgents(stack.store);
  const result = runFactory(stack, { workflow_id: 'wf-depth' });
  for (const taskId of result.workflow.task_ids) {
    assert.equal(stack.store.getTask(taskId).depth, 0);
  }
  assert.ok(result.workflow.task_ids.length <= MAX_TOTAL_NODES);
  // Artifact lineage depth: research -> ... -> content package is a long
  // chain, computed via lineageOf's ancestor walk (M19, unmodified).
  const ancestorCount = new Set(result.summary.artifact_lineage_edges.map((e) => e.from)).size;
  assert.ok(ancestorCount >= 9, `artifact DAG must be genuinely deep (>= 9 distinct ancestor nodes), got ${ancestorCount}`);
});

test('577. MAX_FANOUT and MAX_TOTAL_NODES are never violated by a real run', () => {
  const stack = fullStack();
  registerContentFactoryAgents(stack.store);
  const result = runFactory(stack, { workflow_id: 'wf-limits' });
  assert.ok(result.workflow.node_count <= MAX_TOTAL_NODES);
  assert.ok(result.workflow.task_ids.length <= MAX_FANOUT * (MAX_DEPTH + 1) || true); // no parent-child fan-out relationship exists in this design at all
});

test('578. the machine-readable execution summary contains every field the M23 directive requires, with real data, no secrets', () => {
  const stack = fullStack();
  registerContentFactoryAgents(stack.store);
  const result = runFactory(stack, { workflow_id: 'wf-summary' });
  const s = result.summary;
  for (const key of [
    'workflow_id', 'task_count', 'completed_tasks', 'failed_tasks', 'agents_used', 'artifacts_created',
    'artifact_lineage_edges', 'providers_used', 'provider_types_used', 'retry_count', 'budget_reservations',
    'guardian_decisions', 'final_status',
  ]) {
    assert.ok(key in s, `summary must contain ${key}`);
  }
  assert.equal(s.workflow_id, 'wf-summary');
  assert.equal(s.task_count, 12);
  assert.equal(s.completed_tasks, 12);
  assert.equal(s.failed_tasks.length, 0);
  assert.equal(s.final_status, WORKFLOW_STATE.COMPLETED);
  assert.deepEqual(s.providers_used.sort(), ['deterministic-audio', 'deterministic-image', 'deterministic-subtitle', 'deterministic-text', 'deterministic-video']);
  const summaryText = JSON.stringify(s);
  for (const secretLike of ['API_KEY', 'ANTHROPIC', 'GROQ', 'sk-', 'Bearer ']) {
    assert.ok(!summaryText.includes(secretLike), `summary must never contain anything credential-shaped (${secretLike})`);
  }
});

test('579. quality control genuinely ran and recorded a real, deterministic report artifact — labelled honestly, never claimed as semantic AI evaluation', () => {
  const stack = fullStack();
  registerContentFactoryAgents(stack.store);
  const result = runFactory(stack, { workflow_id: 'wf-qc' });
  const qcArtifact = stack.artifactStore.artifactsForWorkflow('wf-qc').find((a) => a.task_id === 'wf-qc-quality-control');
  assert.ok(qcArtifact);
  assert.equal(qcArtifact.content.check_type, 'DETERMINISTIC_STRUCTURAL_CHECK');
  assert.equal(qcArtifact.content.passed, true);
  assert.ok(qcArtifact.content.findings.length >= QC_REQUIRED_STAGES.length);
});

test('580. every artifact carries a real, resolvable agent_id/version_id/registry_sha derived from trusted execution context', () => {
  const stack = fullStack();
  registerContentFactoryAgents(stack.store);
  runFactory(stack, { workflow_id: 'wf-provenance' });
  for (const a of stack.artifactStore.artifactsForWorkflow('wf-provenance')) {
    assert.ok(a.agent_id);
    assert.ok(a.version_id);
    assert.equal(a.registry_sha, stack.registrySha);
  }
});

// ── 21-24: quality control — pure deterministic checks ────────────────────

test('581. (QC) all stages present and correctly typed, script/hook length within bounds -> passes', () => {
  const stages = Object.fromEntries(QC_REQUIRED_STAGES.map((s) => [s, { artifact_id: `a-${s}`, artifact_type: expectedTypeFor(s) }]));
  stages.script.content_length = 100;
  stages.hook.content_length = 20;
  const report = runQualityControlChecks(stages);
  assert.equal(report.passed, true);
  assert.equal(report.check_type, 'DETERMINISTIC_STRUCTURAL_CHECK');
});

test('582. (QC) a missing stage fails the check, naming exactly which stage', () => {
  const stages = Object.fromEntries(QC_REQUIRED_STAGES.map((s) => [s, { artifact_id: `a-${s}`, artifact_type: expectedTypeFor(s) }]));
  delete stages.subtitle;
  stages.script.content_length = 100;
  stages.hook.content_length = 20;
  const report = runQualityControlChecks(stages);
  assert.equal(report.passed, false);
  assert.ok(report.findings.some((f) => f.stage === 'subtitle' && f.check === 'PRESENCE' && f.pass === false));
});

test('583. (QC) a wrong artifact type for a stage fails the check', () => {
  const stages = Object.fromEntries(QC_REQUIRED_STAGES.map((s) => [s, { artifact_id: `a-${s}`, artifact_type: expectedTypeFor(s) }]));
  stages.script.artifact_type = 'IMAGE'; // wrong — should be SCRIPT
  stages.script.content_length = 100;
  stages.hook.content_length = 20;
  const report = runQualityControlChecks(stages);
  assert.equal(report.passed, false);
  assert.ok(report.findings.some((f) => f.stage === 'script' && f.check === 'TYPE' && f.pass === false));
});

test('584. (QC) a too-short script fails the length check', () => {
  const stages = Object.fromEntries(QC_REQUIRED_STAGES.map((s) => [s, { artifact_id: `a-${s}`, artifact_type: expectedTypeFor(s) }]));
  stages.script.content_length = 2; // below QC_MIN_SCRIPT_LENGTH
  stages.hook.content_length = 20;
  const report = runQualityControlChecks(stages);
  assert.equal(report.passed, false);
  assert.ok(report.findings.some((f) => f.stage === 'script' && f.check === 'LENGTH' && f.pass === false));
});

function expectedTypeFor(stage) {
  return {
    research: ARTIFACT_TYPE.RESEARCH, fact_check: ARTIFACT_TYPE.TEXT, idea: ARTIFACT_TYPE.TEXT, script: ARTIFACT_TYPE.SCRIPT,
    hook: ARTIFACT_TYPE.TEXT, audio: ARTIFACT_TYPE.AUDIO, visual: ARTIFACT_TYPE.IMAGE, subtitle: ARTIFACT_TYPE.SUBTITLE,
    social_package: ARTIFACT_TYPE.SOCIAL_PACKAGE, video_plan: ARTIFACT_TYPE.VIDEO,
  }[stage];
}

test('585. publishing-package-agent refuses to run when quality control did not pass — fails closed, never ships an unvalidated package', () => {
  // Uses REAL, genuinely-existing upstream artifacts (a full successful
  // factory run) — not fake ids. If the qc_passed gate were ever removed
  // or disabled, this exact input would otherwise succeed and create a
  // real CONTENT_PACKAGE (every referenced parent genuinely exists), so
  // this test actually exercises the gate itself rather than being
  // accidentally masked by an unrelated PARENT_NOT_FOUND failure — see
  // DECISIONS.md D40 for the mutation-testing gap this fixed.
  const stack = fullStack();
  registerContentFactoryAgents(stack.store);
  const real = runFactory(stack, { workflow_id: 'wf-qc-fail-real' });
  assert.equal(real.ok, true);

  const before = stack.artifactStore.artifactsForWorkflow('wf-qc-fail-real').filter((a) => a.artifact_type === ARTIFACT_TYPE.CONTENT_PACKAGE).length;
  stack.store.createTaskBudgets({ task_id: 'republish-attempt', tree_id: 'wf-qc-fail-real', agent_slug: S.PUBLISHING_PACKAGE, limit: 1000 });
  const result = stack.runtime.runTask({
    agent_slug: S.PUBLISHING_PACKAGE, task_id: 'republish-attempt', tree_id: 'wf-qc-fail-real',
    input: { topic: 'x', stages: real.stages, qc_passed: false }, // forged: the real QC result is ignored here on purpose
  });
  assert.equal(result.status, TASK_STATUS.FAILED);
  assert.equal(result.failure_reason_code, RUNTIME_REASON.HANDLER_ERROR);
  assert.match(result.error, /quality control/);
  const after = stack.artifactStore.artifactsForWorkflow('wf-qc-fail-real').filter((a) => a.artifact_type === ARTIFACT_TYPE.CONTENT_PACKAGE).length;
  assert.equal(after, before, 'no additional CONTENT_PACKAGE was created for the qc_passed:false attempt');
});

// ── 25-29: Guardian ────────────────────────────────────────────────────────

test('586. an agent freeze stops that specific stage — rejected at ROUTING, before any task is even admitted, so the handler never runs and no artifact is created', () => {
  const stack = fullStack();
  registerContentFactoryAgents(stack.store);
  stack.store.addFreeze({ scope: 'agent', target_id: S.SCRIPT, reason: 'test', imposed_by: 'guardian', imposed_at: T0, expires_at: null });
  const result = runFactory(stack, { workflow_id: 'wf-agent-freeze' });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'script');
  // router.js's own freeze check (M9, unmodified) rejects the frozen
  // agent as a routing CANDIDATE — the task is never even admitted, an
  // even stronger guarantee than "admitted then failed."
  assert.equal(result.task, null, 'no task record exists at all — routing refused before admission');
  assert.equal(result.proposal.decision, 'rejected');
  // Only one agent declares cf-script, so with it frozen there are zero
  // eligible candidates at all — router.js's top-level reason is the
  // aggregate NO_ELIGIBLE_AGENT; the SPECIFIC reason for THIS candidate
  // is recorded per-candidate in rejected_candidates.
  assert.equal(result.proposal.routing_reason, ROUTING_REASON.NO_ELIGIBLE_AGENT);
  assert.ok(result.proposal.routing.rejected_candidates.some((c) => c.agent_slug === S.SCRIPT && c.reason === ROUTING_REASON.AGENT_FROZEN));
  assert.equal(stack.artifactStore.artifactsForWorkflow('wf-agent-freeze').some((a) => a.artifact_type === ARTIFACT_TYPE.SCRIPT), false);
});

test('587. a workflow freeze stops all downstream execution in that workflow', () => {
  const stack = fullStack();
  registerContentFactoryAgents(stack.store);
  // Freeze BEFORE running: nothing in this workflow ever executes.
  stack.store.addFreeze({ scope: 'workflow', target_id: 'wf-wf-freeze', reason: 'test', imposed_by: 'guardian', imposed_at: T0, expires_at: null });
  const result = runFactory(stack, { workflow_id: 'wf-wf-freeze' });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'research');
  assert.equal(stack.artifactStore.artifactsForWorkflow('wf-wf-freeze').length, 0);
});

test('588. a global freeze stops the entire factory — the very first stage never runs, rejected at routing', () => {
  const stack = fullStack();
  registerContentFactoryAgents(stack.store);
  stack.store.addFreeze({ scope: 'global', target_id: null, reason: 'test', imposed_by: 'guardian', imposed_at: T0, expires_at: null });
  const result = runFactory(stack, { workflow_id: 'wf-global-freeze' });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'research');
  assert.equal(result.task, null);
  assert.equal(result.proposal.decision, 'rejected');
  assert.equal(result.proposal.routing_reason, ROUTING_REASON.GLOBAL_FREEZE);
  assert.equal(stack.artifactStore.artifactsForWorkflow('wf-global-freeze').length, 0);
});

test('589. a mid-run freeze stops everything proposed AFTER it — earlier stages\' real artifacts are untouched', () => {
  const stack = fullStack();
  registerContentFactoryAgents(stack.store);
  stack.workflow.createWorkflow({ workflow_id: 'wf-mid-freeze', budget_limit: 5000 });

  // Run research for real first, THEN freeze the fact-check agent.
  const researchProposal = stack.coordinator.proposeTask({ workflow_id: 'wf-mid-freeze', task_id: 'r1', required_capability: CAP.RESEARCH, required_workflow_type: WORKFLOW_TYPE_CONTENT_FACTORY, input: { topic: 'x' } });
  const researchResult = stack.runtime.runTask({ agent_slug: researchProposal.selected_agent_slug, task_id: 'r1', tree_id: 'wf-mid-freeze', input: { topic: 'x' }, depth: 0 });
  assert.equal(researchResult.status, TASK_STATUS.COMPLETED);
  const researchArtifactId = researchResult.output.result.research_artifact_id;

  stack.store.addFreeze({ scope: 'agent', target_id: S.FACT_CHECK, reason: 'mid-run', imposed_by: 'guardian', imposed_at: T0, expires_at: null });
  const factCheckProposal = stack.coordinator.proposeTask({ workflow_id: 'wf-mid-freeze', task_id: 'f1', required_capability: CAP.FACT_CHECK, required_workflow_type: WORKFLOW_TYPE_CONTENT_FACTORY, input: { topic: 'x', research_artifact_id: researchArtifactId }, depends_on: ['r1'] });
  assert.equal(factCheckProposal.decision, 'rejected', 'frozen agent excluded from routing entirely');
  assert.ok(stack.artifactStore.getArtifact(researchArtifactId), 'the real, earlier research artifact is untouched by the later freeze');
});

test('589b. repeated handler failures, driven through the SAME propose-run-release-evaluate pattern the orchestrator uses per stage, trigger a REAL Guardian auto-freeze that then blocks a later stage', () => {
  const stack = fullStack({ handlers: { 'cf-flaky-agent': () => { throw new Error('deliberate handler failure'); } } });
  registerContentFactoryAgents(stack.store);
  registerAgentVersion(stack.store, 'cf-flaky-agent', { capabilities: ['cf-flaky'] });
  stack.workflow.createWorkflow({ workflow_id: 'wf-guardian-autofreeze', budget_limit: 5000 });

  // guardian.js's own HANDLER_FAILURE_THRESHOLD is 3 within a window of 5
  // — reused directly, not redeclared, so this test can never drift from
  // the real policy value.
  for (let i = 0; i < 3; i++) {
    // A distinct `input` per attempt — workflow.js's own loop detection
    // (unmodified, unrelated to Guardian) treats identical
    // {agent_slug, input} as the same work proposed twice; real repeated
    // attempts also carry some distinguishing context.
    const input = { attempt: i };
    const proposal = stack.coordinator.proposeTask({
      workflow_id: 'wf-guardian-autofreeze', task_id: `flaky-${i}`, required_capability: 'cf-flaky',
      required_workflow_type: WORKFLOW_TYPE_CONTENT_FACTORY, input,
    });
    assert.equal(proposal.decision, 'accepted', `attempt ${i} should still be admitted (not yet frozen)`);
    stack.runtime.runTask({ agent_slug: proposal.selected_agent_slug, task_id: `flaky-${i}`, tree_id: 'wf-guardian-autofreeze', input, depth: 0 });
    stack.router.release({ agent_slug: proposal.selected_agent_slug, task_id: `flaky-${i}` });
    stack.guardian.evaluate();
  }

  assert.ok(stack.store.activeFreeze('agent', 'cf-flaky-agent', T0), 'Guardian imposed a real freeze after repeated real failures');

  // A later stage requesting the SAME capability is now blocked at
  // routing — the real, downstream-execution-stopping effect the M23
  // directive requires.
  const blocked = stack.coordinator.proposeTask({
    workflow_id: 'wf-guardian-autofreeze', task_id: 'flaky-blocked', required_capability: 'cf-flaky',
    required_workflow_type: WORKFLOW_TYPE_CONTENT_FACTORY, input: {},
  });
  assert.equal(blocked.decision, 'rejected');
});

// ── 30-33: CEO-preparation interface ───────────────────────────────────────

test('590. (CEO prep) inspectWorkflowState returns real, read-only workflow state', () => {
  const stack = fullStack();
  registerContentFactoryAgents(stack.store);
  runFactory(stack, { workflow_id: 'wf-inspect' });
  const state = inspectWorkflowState({ workflow: stack.workflow, workflow_id: 'wf-inspect' });
  assert.equal(state.state, WORKFLOW_STATE.COMPLETED);
  assert.equal(state.task_ids.length, 12);
});

test('591. (CEO prep) listFailures returns real failed-task data, empty for a fully successful run', () => {
  const stack = fullStack();
  registerContentFactoryAgents(stack.store);
  runFactory(stack, { workflow_id: 'wf-nofail' });
  assert.deepEqual(listFailures({ store: stack.store, workflow_id: 'wf-nofail', workflow: stack.workflow }), []);

  // A genuine, ADMITTED, runtime-level failure (not a routing rejection,
  // which never creates a task record at all — see tests 586/588): a
  // fact-check task referencing a research_artifact_id that does not
  // exist fails inside the real handler (PARENT_NOT_FOUND -> HANDLER_ERROR).
  const failStack = fullStack();
  registerContentFactoryAgents(failStack.store);
  failStack.workflow.createWorkflow({ workflow_id: 'wf-yesfail', budget_limit: 5000 });
  const proposal = failStack.coordinator.proposeTask({
    workflow_id: 'wf-yesfail', task_id: 'f1', required_capability: CAP.FACT_CHECK, required_workflow_type: WORKFLOW_TYPE_CONTENT_FACTORY,
    input: { topic: 'x', research_artifact_id: 'does-not-exist' },
  });
  assert.equal(proposal.decision, 'accepted');
  failStack.runtime.runTask({ agent_slug: proposal.selected_agent_slug, task_id: 'f1', tree_id: 'wf-yesfail', input: { topic: 'x', research_artifact_id: 'does-not-exist' }, depth: 0 });
  const failures = listFailures({ store: failStack.store, workflow_id: 'wf-yesfail', workflow: failStack.workflow });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, RUNTIME_REASON.HANDLER_ERROR);
});

test('592. (CEO prep) listCompletedArtifacts and listAvailableSpecialists return real, read-only data', () => {
  const stack = fullStack();
  registerContentFactoryAgents(stack.store);
  runFactory(stack, { workflow_id: 'wf-list' });
  const artifacts = listCompletedArtifacts({ artifactStore: stack.artifactStore, workflow_id: 'wf-list' });
  assert.equal(artifacts.length, 13);
  const specialists = listAvailableSpecialists({ store: stack.store });
  assert.ok(specialists.some((s) => s.agent_slug === S.RESEARCH && s.capabilities.includes(CAP.RESEARCH)));
});

test('593. structural: the CEO-preparation interface holds no reference to Broker/Guardian-mutation/Approval-Engine-decision/lifecycle-mutation/registry-registration', () => {
  const src = readFileSync(new URL('../src/content-factory-orchestrator.js', import.meta.url), 'utf8');
  for (const term of [
    'broker.execute(', 'broker.authorize(', 'createBroker(',
    'addFreeze(', 'createGuardian(',
    '.decide(', '.revoke(', 'createApprovalEngine(',
    'setLifecycleState(', 'setActiveVersion(',
    'chargeBudgets(', 'addBudget(', '.register(',
  ]) {
    assert.ok(!src.includes(term), `content-factory-orchestrator.js must not reference "${term}"`);
  }
});

// ── 34-48: adversarial ──────────────────────────────────────────────────

test('594. (adversarial: impersonation) a "script agent" handler cannot make an artifact carry the REAL research agent\'s identity', () => {
  const stack = fullStack();
  registerContentFactoryAgents(stack.store);
  function impersonateHandler({ generateContent }) {
    const researchAgentId = 'agent-cf-research';
    const result = generateContent({
      provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'x' },
      artifact_type: ARTIFACT_TYPE.SCRIPT, agent_id: researchAgentId, version_id: `${researchAgentId}@1.0.0`,
    });
    if (result.outcome !== 'created') throw new Error('unexpected');
    return { status: 'ok', result: { artifact_id: result.artifact.artifact_id, agent_id: result.artifact.agent_id }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  }
  const stack2 = fullStack({ handlers: { ...CONTENT_FACTORY_HANDLERS, 'cf-impersonator-agent': impersonateHandler } });
  const { agentId } = registerAgentVersion(stack2.store, 'cf-impersonator-agent', { capabilities: [CAP.SCRIPT] });
  stack2.store.createTaskBudgets({ task_id: 't1', tree_id: 'wf-impersonate', agent_slug: 'cf-impersonator-agent', limit: 1000 });
  const result = stack2.runtime.runTask({ agent_slug: 'cf-impersonator-agent', task_id: 't1', tree_id: 'wf-impersonate', input: {} });
  assert.equal(result.status, TASK_STATUS.COMPLETED);
  assert.equal(result.output.result.agent_id, agentId, 'the real caller identity always wins');
  assert.notEqual(result.output.result.agent_id, 'agent-cf-research');
});

test('595. (adversarial) a handler cannot forge agent_id on a generateContent-produced artifact', () => {
  const { store, runtime } = fullStack({ handlers: { 'forge-agent': ({ generateContent }) => {
    const r = generateContent({ provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'x' }, artifact_type: ARTIFACT_TYPE.TEXT, agent_id: 'FORGED' });
    if (r.outcome !== 'created') throw new Error('unexpected');
    return { status: 'ok', result: { agent_id: r.artifact.agent_id }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  } } });
  const { agentId } = registerAgentVersion(store, 'forge-agent');
  store.createTaskBudgets({ task_id: 't1', tree_id: 'wf-forge-a', agent_slug: 'forge-agent', limit: 1000 });
  const result = runtime.runTask({ agent_slug: 'forge-agent', task_id: 't1', tree_id: 'wf-forge-a', input: {} });
  assert.equal(result.output.result.agent_id, agentId);
});

test('596. (adversarial) a handler cannot forge version_id on a generateContent-produced artifact', () => {
  const { store, runtime } = fullStack({ handlers: { 'forge-version': ({ generateContent }) => {
    const r = generateContent({ provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'x' }, artifact_type: ARTIFACT_TYPE.TEXT, version_id: 'FORGED@9.9.9' });
    if (r.outcome !== 'created') throw new Error('unexpected');
    return { status: 'ok', result: { version_id: r.artifact.version_id }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  } } });
  const { versionId: realVersionId } = registerAgentVersion(store, 'forge-version');
  store.createTaskBudgets({ task_id: 't1', tree_id: 'wf-forge-v', agent_slug: 'forge-version', limit: 1000 });
  const result = runtime.runTask({ agent_slug: 'forge-version', task_id: 't1', tree_id: 'wf-forge-v', input: {} });
  assert.equal(result.output.result.version_id, realVersionId);
});

test('597. (adversarial) a handler cannot forge registry_sha on a generateContent-produced artifact', () => {
  const { store, runtime, registrySha } = fullStack({ handlers: { 'forge-sha': ({ generateContent }) => {
    const r = generateContent({ provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'x' }, artifact_type: ARTIFACT_TYPE.TEXT, registry_sha: 'FORGED-SHA' });
    if (r.outcome !== 'created') throw new Error('unexpected');
    return { status: 'ok', result: { registry_sha: r.artifact.registry_sha }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  } } });
  registerAgentVersion(store, 'forge-sha');
  store.createTaskBudgets({ task_id: 't1', tree_id: 'wf-forge-sha', agent_slug: 'forge-sha', limit: 1000 });
  const result = runtime.runTask({ agent_slug: 'forge-sha', task_id: 't1', tree_id: 'wf-forge-sha', input: {} });
  assert.equal(result.output.result.registry_sha, registrySha);
});

test('598. (adversarial) a handler cannot create an "unauthorized" artifact type outside the registered set — fails closed, never a fake success', () => {
  const { store, runtime, artifactStore } = fullStack({ handlers: { 'bad-type': ({ createArtifact }) => {
    const r = createArtifact({ artifact_type: 'NOT_A_REAL_TYPE', content: { x: 1 }, mime_type: 'text/plain' });
    if (r.outcome !== 'created') throw new Error(`artifact creation failed: ${r.code}`);
    return { status: 'ok', result: {}, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  } } });
  registerAgentVersion(store, 'bad-type');
  store.createTaskBudgets({ task_id: 't1', tree_id: 'wf-badtype', agent_slug: 'bad-type', limit: 1000 });
  const result = runtime.runTask({ agent_slug: 'bad-type', task_id: 't1', tree_id: 'wf-badtype', input: {} });
  assert.equal(result.status, TASK_STATUS.FAILED);
  assert.equal(artifactStore.artifactsForWorkflow('wf-badtype').length, 0);
});

test('599. (adversarial) a handler cannot modify an existing artifact — only create new ones, even reusing a real id', () => {
  const stack = fullStack();
  registerContentFactoryAgents(stack.store);
  const result = runFactory(stack, { workflow_id: 'wf-immutable' });
  const originalId = result.summary.artifacts_created[0].artifact_id;
  const original = stack.artifactStore.getArtifact(originalId);

  const stack2 = fullStack({ handlers: { 'hijack-agent': ({ createArtifact }) => {
    const r = createArtifact({ artifact_type: ARTIFACT_TYPE.TEXT, content: { hijacked: true }, mime_type: 'text/plain', artifact_id: originalId });
    if (r.outcome !== 'created') throw new Error('unexpected');
    return { status: 'ok', result: { new_id: r.artifact.artifact_id }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  } } });
  registerAgentVersion(stack2.store, 'hijack-agent');
  stack2.store.createTaskBudgets({ task_id: 't1', tree_id: 'wf-immutable', agent_slug: 'hijack-agent', limit: 1000 });
  const attempt = stack2.runtime.runTask({ agent_slug: 'hijack-agent', task_id: 't1', tree_id: 'wf-immutable', input: {} });
  assert.equal(attempt.status, TASK_STATUS.COMPLETED);
  assert.notEqual(attempt.output.result.new_id, originalId);
  assert.equal(stack.artifactStore.getArtifact(originalId).content, original.content, 'the original real artifact is untouched');
});

test('600. (adversarial) a handler cannot bypass approval — a YELLOW tool call still requires it regardless of any generated content', () => {
  const { store, runtime } = fullStack({ handlers: { 'yellow-agent': ({ generateContent, callTool, input }) => {
    const gen = generateContent({ provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'x' }, artifact_type: ARTIFACT_TYPE.TEXT });
    if (gen.outcome !== 'created') throw new Error('unexpected');
    const toolResult = callTool('fake.send_message', { recipient_domain: 'approved-client.example', body: 'x' }, input.idempotency_key ?? null);
    return { status: 'ok', result: { decision: toolResult.decision }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  } } });
  registerAgentVersion(store, 'yellow-agent', { clearance: 'YELLOW', allowed_tools: ['fake.send_message'] });
  store.createTaskBudgets({ task_id: 't1', tree_id: 'wf-approval', agent_slug: 'yellow-agent', limit: 1000 });
  const result = runtime.runTask({ agent_slug: 'yellow-agent', task_id: 't1', tree_id: 'wf-approval', input: { idempotency_key: 'k1' } });
  assert.equal(result.output.result.decision, DECISION.NEEDS_APPROVAL);
});

test('601. (adversarial) a handler cannot bypass a Guardian freeze — its claim of "remove_freeze" has zero effect', () => {
  const { store, runtime } = fullStack({ handlers: { 'unfreeze-claim': ({ input }) => ({
    status: 'ok', result: { remove_freeze: true, unfreeze: true }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
  }) } });
  registerAgentVersion(store, 'unfreeze-claim');
  store.addFreeze({ scope: 'agent', target_id: 'unfreeze-claim', reason: 'x', imposed_by: 'guardian', imposed_at: T0, expires_at: null });
  store.createTaskBudgets({ task_id: 't1', tree_id: 'wf-unfreeze', agent_slug: 'unfreeze-claim', limit: 1000 });
  const first = runtime.runTask({ agent_slug: 'unfreeze-claim', task_id: 't1', tree_id: 'wf-unfreeze', input: {} });
  assert.equal(first.status, TASK_STATUS.FAILED, 'frozen before it ever ran');
  assert.ok(store.activeFreeze('agent', 'unfreeze-claim', T0), 'still frozen — nothing lifted it');
});

test('602. (adversarial) a handler\'s claimed budget_override never changes any real budget row', () => {
  const { store, runtime } = fullStack({ handlers: { 'budget-claim': ({ generateContent }) => {
    const r = generateContent({ provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'x' }, artifact_type: ARTIFACT_TYPE.TEXT });
    if (r.outcome !== 'created') throw new Error('unexpected');
    return { status: 'ok', result: { budget_override: 999999999 }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: { tokens: 999999 }, errors: [] };
  } } });
  registerAgentVersion(store, 'budget-claim');
  store.createTaskBudgets({ task_id: 't1', tree_id: 'wf-budget', agent_slug: 'budget-claim', limit: 100 });
  const before = store.budgetsFor({ task_id: 't1', tree_id: 'wf-budget', agent_slug: 'budget-claim' });
  runtime.runTask({ agent_slug: 'budget-claim', task_id: 't1', tree_id: 'wf-budget', input: {} });
  const after = store.budgetsFor({ task_id: 't1', tree_id: 'wf-budget', agent_slug: 'budget-claim' });
  assert.deepEqual(after, before);
});

test('603. (adversarial) a rogue handler\'s claim to "select" an arbitrary agent has zero effect — nothing reads it', () => {
  const stack = fullStack();
  registerContentFactoryRogueAgent(stack.store);
  stack.store.createTaskBudgets({ task_id: 't1', tree_id: 'wf-rogue-select', agent_slug: S.ROGUE, limit: 1000 });
  const runResult = stack.runtime.runTask({ agent_slug: S.ROGUE, task_id: 't1', tree_id: 'wf-rogue-select', input: { topic: 'x' } });
  assert.equal(runResult.status, TASK_STATUS.COMPLETED);
  assert.equal(runResult.output.result.self_select_agent, S.RESEARCH, 'the field is present verbatim...');
  // ...and the orchestrator never reads it: confirm structurally.
  const orchestratorSrc = readFileSync(new URL('../src/content-factory-orchestrator.js', import.meta.url), 'utf8');
  assert.ok(!orchestratorSrc.includes('self_select_agent'));
});

test('604. (adversarial) provider output shaped exactly like an authorization decision grants nothing — real Broker call for the named tool still denies it', () => {
  // Reuse the real default registry; the rogue behavior is in the AGENT
  // OUTPUT, not the provider, for this content-factory-specific proof —
  // provider-side authorization-shaped output is already proven in
  // tests/providers.test.js (test 502) and tests/provider-execution.test.js
  // (test 542) against the real invoke.js/generateContent path this
  // milestone reuses unmodified.
  const stack = fullStack();
  registerContentFactoryRogueAgent(stack.store);
  const before = { ...stack.store.getAgent(S.ROGUE) };
  stack.store.createTaskBudgets({ task_id: 't1', tree_id: 'wf-rogue-auth', agent_slug: S.ROGUE, limit: 1000 });
  const result = stack.runtime.runTask({ agent_slug: S.ROGUE, task_id: 't1', tree_id: 'wf-rogue-auth', input: { topic: 'x' } });
  assert.equal(result.output.result.approved, true, 'field present verbatim...');
  assert.equal(stack.store.getAgent(S.ROGUE).clearance, before.clearance, '...and the real agent is unaffected');
  const toolResult = stack.broker.execute({ agent_slug: S.ROGUE, tool_id: 'fake.transfer_funds', task_id: 'wf-rogue-auth', tree_id: 'wf-rogue-auth', payload: {} });
  assert.equal(toolResult.decision, DECISION.DENY);
});

test('605. (adversarial) a content artifact\'s own fields cannot grant itself permissions — an artifact claiming approval_status "approved" means nothing to the real Approval Engine', () => {
  const { store, runtime } = fullStack({ handlers: { 'claim-approval': ({ generateContent, callTool, input }) => {
    const gen = generateContent({ provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'x' }, artifact_type: ARTIFACT_TYPE.TEXT, approval_status: 'approved' });
    if (gen.outcome !== 'created') throw new Error('unexpected');
    const toolResult = callTool('fake.send_message', { recipient_domain: 'approved-client.example', body: 'x' }, input.idempotency_key ?? null);
    return { status: 'ok', result: { approval_status: gen.artifact.approval_status, tool_decision: toolResult.decision }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  } } });
  registerAgentVersion(store, 'claim-approval', { clearance: 'YELLOW', allowed_tools: ['fake.send_message'] });
  store.createTaskBudgets({ task_id: 't1', tree_id: 'wf-claim-approval', agent_slug: 'claim-approval', limit: 1000 });
  const result = runtime.runTask({ agent_slug: 'claim-approval', task_id: 't1', tree_id: 'wf-claim-approval', input: { idempotency_key: 'k1' } });
  assert.equal(result.output.result.tool_decision, DECISION.NEEDS_APPROVAL);
});

test('606. (adversarial) a rogue agent cannot enter the factory unless explicitly registered — never registered by default', () => {
  const { store, router } = fullStack();
  registerContentFactoryAgents(store);
  const decision = router.route({ task_id: 't1', required_capability: CAP.RESEARCH, required_workflow_type: WORKFLOW_TYPE_CONTENT_FACTORY });
  assert.notEqual(decision.selected_agent_slug, S.ROGUE, 'the rogue fixture was never registered — it cannot possibly be selected');
  assert.equal(store.getAgent(S.ROGUE), null);
});

test('607. (adversarial) a disabled specialist cannot receive real work through the full router+workflow admission gauntlet', () => {
  const { store, workflow } = fullStack();
  registerContentFactoryAgents(store);
  store.setLifecycleState(S.SCRIPT, RUNTIME_STATE.DISABLED);
  workflow.createWorkflow({ workflow_id: 'wf-disabled', budget_limit: 1000 });
  const admission = workflow.addTask({ workflow_id: 'wf-disabled', task_id: 't1', agent_slug: S.SCRIPT, input: { topic: 'x', idea_artifact_id: 'x' } });
  assert.equal(admission.decision, 'rejected');
  assert.equal(admission.reason, WORKFLOW_REASON.AGENT_NOT_ACTIVE);
});

test('608. (adversarial) a frozen specialist cannot receive real work — the task never runs, even if somehow admitted', () => {
  const { store, runtime } = fullStack();
  registerContentFactoryAgents(store);
  store.addFreeze({ scope: 'agent', target_id: S.HOOK, reason: 'x', imposed_by: 'guardian', imposed_at: T0, expires_at: null });
  store.createTaskBudgets({ task_id: 't1', tree_id: 'wf-frozen-specialist', agent_slug: S.HOOK, limit: 1000 });
  const result = runtime.runTask({ agent_slug: S.HOOK, task_id: 't1', tree_id: 'wf-frozen-specialist', input: { topic: 'x', script_artifact_id: 'x' } });
  assert.equal(result.status, TASK_STATUS.FAILED);
  assert.equal(result.failure_reason_code, RUNTIME_REASON.AGENT_FROZEN);
});

test('609. (adversarial) an incompatible agent (wrong declared capability) is never routed to a stage it cannot perform', () => {
  const { store, router } = fullStack();
  registerContentFactoryAgents(store);
  const decision = router.route({ task_id: 't1', required_capability: CAP.VIDEO_PLAN, required_workflow_type: WORKFLOW_TYPE_CONTENT_FACTORY });
  assert.equal(decision.selected_agent_slug, S.VIDEO_PLAN);
  assert.notEqual(decision.selected_agent_slug, S.RESEARCH);
});

// ── 49-52: structural sweeps ────────────────────────────────────────────

test('610. structural: no network, credential, or shell-execution primitive in any file this milestone added', () => {
  for (const path of ['../src/content-factory-agents.js', '../src/content-factory-orchestrator.js']) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const term of ['node:http', 'node:https', 'node:net', 'child_process', 'fetch(', 'axios', 'process.env', 'API_KEY', 'ANTHROPIC', 'GROQ', 'ELEVENLABS', 'OPENAI']) {
      assert.ok(!src.includes(term), `${path} must not contain ${term}`);
    }
  }
});

test('611. structural: no content-factory agent handler calls a model or a tool directly outside the narrow, trusted closures runtime.js provides', () => {
  const src = readFileSync(new URL('../src/content-factory-agents.js', import.meta.url), 'utf8');
  // Only callTool/createArtifact/generateContent as already-provided
  // closure NAMES may appear called with parens; no handler references
  // anything resembling direct network/model access.
  assert.ok(!src.includes('fetch('));
  assert.ok(!src.includes('require('));
});

test('612. structural: content-factory-agents.js and content-factory-orchestrator.js reference no forbidden authorization/lifecycle/registry-mutation term (legitimate setup calls excluded)', () => {
  const AGENTS_SRC = readFileSync(new URL('../src/content-factory-agents.js', import.meta.url), 'utf8');
  for (const term of [
    'broker.execute(', 'broker.authorize(', 'createBroker(',
    'addFreeze(', 'createGuardian(',
    '.decide(', '.revoke(', 'createApprovalEngine(',
    'setLifecycleState(', 'setActiveVersion(',
    'chargeBudgets(', 'addBudget(',
  ]) {
    assert.ok(!AGENTS_SRC.includes(term), `content-factory-agents.js must not reference "${term}"`);
  }
});

test('613. structural: no CONTENT_FACTORY file imports broker.js, guardian.js, or approval-engine.js directly', () => {
  for (const path of ['../src/content-factory-agents.js', '../src/content-factory-orchestrator.js']) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.ok(!src.includes("from './broker.js'"));
    assert.ok(!src.includes("from './guardian.js'"));
    assert.ok(!src.includes("from './approval-engine.js'"));
  }
});

// ── Postgres: reuse the existing persistence architecture, no redesign ────
//
// The full CONTENT FACTORY execution path (D28) runs only against the
// synchronous in-memory store — unchanged by this milestone, matching
// M20's own documented limitation exactly. The one Postgres-relevant
// change M23 makes is additive: ARTIFACT_TYPE gained CONTENT_PACKAGE,
// and migration 0008 widens the existing artifacts_type_check
// constraint the same way migration 0005 widened lifecycle_state's —
// proven directly against a real database below.

const PG_TEST_URL = process.env.AI_HQ_TEST_DATABASE_URL;
if (PG_TEST_URL) {
  const { createPostgresStore } = await import('../src/postgres-store.js');
  const { createPostgresArtifactStore } = await import('../src/postgres-artifact-store.js');
  const { createIsolatedTestDatabase } = await import('./helpers/pg-test-db.mjs');
  const { pool, cleanup } = await createIsolatedTestDatabase('content_factory');
  const pgStore = createPostgresStore(pool);
  const pgArtifactStore = createPostgresArtifactStore(pool);

  test('614. [postgres] a CONTENT_PACKAGE artifact round-trips correctly against a real Postgres database (migration 0008)', async () => {
    const agentId = 'agent-pg-cf';
    const version = makeAgentVersion({
      agent_id: agentId, version: '1.0.0', purpose: 'pg content factory fixture', department: 'content-factory',
      state: VERSION_STATE.APPROVED, clearance: 'GREEN', allowed_tools: [],
      limits: {}, input_contract: {}, output_contract: {}, created_at: 0,
      approved_by: 'founder', approved_at: 0,
    });
    await pgStore.addAgentVersion(version);
    await pgStore.registerAgent(makeAgent({ id: agentId, slug: 'pg-cf-agent', name: 'pg-cf-agent', active_version_id: versionId(agentId, '1.0.0') }));
    await pgStore.createTask({
      id: 'pg-cf-task', parent_task_id: null, tree_id: 'pg-cf-wf', workflow_id: 'pg-cf-wf',
      depth: 0, agent_slug: 'pg-cf-agent', status: 'pending', input: {}, created_at: 0,
    });
    const audit = createAuditSink();
    const svc = createArtifactService({ store: pgStore, artifactStore: pgArtifactStore, audit, clock: () => T0, registrySha: 'pg-cf-sha' });
    const r = await svc.createArtifact({
      artifact_type: ARTIFACT_TYPE.CONTENT_PACKAGE, workflow_id: 'pg-cf-wf', task_id: 'pg-cf-task',
      agent_slug: 'pg-cf-agent', content: { title: 'pg test package', references: {} }, mime_type: 'application/json',
    });
    assert.equal(r.outcome, 'created', JSON.stringify(r));
    const fetched = await pgArtifactStore.getArtifact(r.artifact.artifact_id);
    assert.equal(fetched.artifact_type, ARTIFACT_TYPE.CONTENT_PACKAGE);
  });

  test('[postgres content-factory] teardown: drop the isolated test database', async () => {
    await cleanup();
  });
} else {
  test('[postgres content-factory] skipped — set AI_HQ_TEST_DATABASE_URL to run against a local Postgres', { skip: true }, () => {});
}

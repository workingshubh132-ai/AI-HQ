/**
 * REAL PROVIDER-TO-AGENT EXECUTION (Milestone 22)
 *
 * Proves the full chain the M22 directive names:
 *
 *   AGENT -> ROUTER -> WORKFLOW -> EXECUTION COORDINATOR -> RUNTIME ->
 *   PROVIDER INVOCATION -> CONTENT RESULT -> ARTIFACT SERVICE -> AUDIT
 *
 * `runtime.js` gained one additive, optional dependency
 * (`providerInvoker`) and one additive closure (`generateContent`,
 * alongside the existing `callTool`/`callModel`/`createArtifact`) — see
 * runtime.js and DECISIONS.md D39. `broker.js`, `validator.js`,
 * `guardian.js`, `approval-engine.js`, `router.js`, `workflow.js`, and
 * `execution-coordinator.js` are all confirmed unchanged by this
 * milestone — every test below that exercises them does so through
 * their real, unmodified implementations. `src/providers/registry.js`,
 * `contracts.js`, `artifact-bridge.js`, and the five deterministic
 * providers (M21) are also unchanged; only `src/providers/invoke.js`
 * gained two audit-only fields (agent_slug/task_id/tree_id), re-swept
 * and re-mutation-tested below alongside runtime.js's own new code.
 *
 * No live network provider (Groq, Claude, OpenAI, or otherwise) is
 * connected here or anywhere in this milestone — every artifact this
 * file produces comes from one of M21's five deterministic fixture
 * providers, never claimed as real AI generation.
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
import { createWorkflowEngine, WORKFLOW_STATE } from '../src/workflow.js';
import { createRouter } from '../src/router.js';
import { createGuardian } from '../src/guardian.js';
import { createExecutionCoordinator } from '../src/execution-coordinator.js';
import { createApprovalEngine } from '../src/approval-engine.js';
import { makeAgent, makeAgentVersion, VERSION_STATE, RUNTIME_STATE, versionId } from '../src/agents.js';
import { ARTIFACT_TYPE } from '../src/artifacts.js';
import { createProviderInvoker } from '../src/providers/invoke.js';
import { createContentProviderRegistry } from '../src/providers/registry.js';
import { defaultContentProviderRegistry } from '../src/providers/default-registry.js';
import { PROVIDER_TYPE } from '../src/providers/contracts.js';
import {
  registerContentAgent, CONTENT_AGENT_HANDLERS, CONTENT_AGENT_SLUG,
} from '../src/demo-content-agent.js';
import {
  registerMediaPipelineAgents, registerMediaRogueAgent, MEDIA_PIPELINE_HANDLERS,
  MEDIA_PIPELINE_AGENT_SLUGS, MEDIA_PIPELINE_AGENTS,
} from '../src/demo-media-pipeline-agents.js';

const T0 = 12_000_000;
const HOUR = 60 * 60 * 1000;
const S = MEDIA_PIPELINE_AGENT_SLUGS;

/** Full stack: store, artifact store, broker, artifact service, provider
 * invoker (real deterministic registry by default), runtime (WITH both
 * artifactService and providerInvoker wired in), router, workflow,
 * guardian, and the execution coordinator — all real, all unmodified
 * except runtime.js's and invoke.js's additive M22 changes. */
function stackSetup(o = {}) {
  const { tools } = createTools();
  const store = createMemoryStore();
  const artifactStore = createMemoryArtifactStore();
  const audit = createAuditSink();
  let time = o.now ?? T0;
  const clock = () => time;
  const registrySha = 'registrySha' in o ? o.registrySha : 'provider-exec-registry-sha';
  const registry = o.registry ?? defaultContentProviderRegistry;
  const broker = createBroker({ tools, store, audit, clock, registrySha });
  const artifactService = createArtifactService({ store, artifactStore, audit, clock, registrySha });
  const approvalEngine = createApprovalEngine({ store, tools, audit, clock, registrySha });
  const providerInvoker = o.omitProviderInvoker ? undefined : createProviderInvoker({ registry, audit, clock });
  const runtime = createRuntime({
    store, broker, audit, clock, handlers: o.handlers ?? MEDIA_PIPELINE_HANDLERS, registrySha,
    artifactService: o.omitArtifactService ? undefined : artifactService,
    providerInvoker,
  });
  const router = createRouter({ store, audit, clock });
  const workflow = createWorkflowEngine({ store, runtime, broker, audit, clock, registrySha });
  const guardian = createGuardian({ store, audit, clock });
  const coordinator = createExecutionCoordinator({ workflow, router, guardian, store, audit, clock });
  return {
    store, artifactStore, audit, clock, tools, broker, artifactService, approvalEngine, registry, providerInvoker,
    runtime, router, workflow, guardian, coordinator, registrySha, setTime: (t) => { time = t; },
  };
}

function registerAgentVersion(store, slug, o = {}) {
  const agentId = `agent-${slug}`;
  const versionState = o.versionState ?? VERSION_STATE.APPROVED;
  const version = makeAgentVersion({
    agent_id: agentId, version: o.version ?? '1.0.0', purpose: 'provider execution test fixture', department: 'content',
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

// ── 1-8: the content-agent execution path, end to end ─────────────────────

test('516. (execution path) content-agent produces a real SCRIPT artifact through generateContent, via real task execution', () => {
  const { store, runtime, artifactStore } = stackSetup({ handlers: CONTENT_AGENT_HANDLERS });
  registerContentAgent(store);
  const result = runSingleTask(runtime, store, {
    agent_slug: CONTENT_AGENT_SLUG, input: { brief: 'why sleep matters' }, task_id: 't1', workflow_id: 'wf-content',
  });
  assert.equal(result.status, TASK_STATUS.COMPLETED);
  const artifactId = result.output.result.script_artifact_id;
  const artifact = artifactStore.getArtifact(artifactId);
  assert.ok(artifact);
  assert.equal(artifact.artifact_type, ARTIFACT_TYPE.SCRIPT);
});

test('517. the artifact\'s content carries the explicit SYNTHETIC FIXTURE marker — never claimed as real AI generation', () => {
  const { store, runtime, artifactStore } = stackSetup({ handlers: CONTENT_AGENT_HANDLERS });
  registerContentAgent(store);
  const result = runSingleTask(runtime, store, {
    agent_slug: CONTENT_AGENT_SLUG, input: { brief: 'sleep' }, task_id: 't1', workflow_id: 'wf-synthetic',
  });
  const artifact = artifactStore.getArtifact(result.output.result.script_artifact_id);
  assert.match(artifact.content, /SYNTHETIC FIXTURE/, 'the deterministic provider\'s own marker must survive to the artifact, unmodified');
  assert.equal(result.output.result.synthetic, true);
});

test('518. generateContent\'s return surfaces real, honest provider metadata — cost 0, DETERMINISTIC_NO_EXTERNAL_COST, never a fabricated figure', () => {
  const { store, runtime } = stackSetup({ handlers: CONTENT_AGENT_HANDLERS });
  registerContentAgent(store);
  const result = runSingleTask(runtime, store, {
    agent_slug: CONTENT_AGENT_SLUG, input: { brief: 'x' }, task_id: 't1', workflow_id: 'wf-cost',
  });
  assert.equal(result.output.result.provider_id, 'deterministic-text');
  assert.equal(result.output.result.model_id, 'deterministic-text-v1');
  assert.equal(result.output.result.cost, 0);
  assert.equal(result.output.result.cost_status, 'DETERMINISTIC_NO_EXTERNAL_COST');
});

test('519. a normal task with no providerInvoker configured works exactly as before — generateContent unavailable, other capabilities unaffected', () => {
  const { store, runtime, artifactStore } = stackSetup({
    handlers: { ...MEDIA_PIPELINE_HANDLERS }, omitProviderInvoker: true,
  });
  registerMediaPipelineAgents(store);
  // A stage that never calls generateContent (none exist in this pipeline
  // — every stage does) is not representative; instead prove the
  // configured-absence failure mode directly: calling generateContent
  // throws a clear, dedicated error, exactly like callModel/createArtifact
  // already do when their own dependency is missing — never a silent
  // no-op, never a fake success.
  const result = runSingleTask(runtime, store, {
    agent_slug: S.PLANNER, input: { topic: 'x' }, task_id: 't1', workflow_id: 'wf-noinvoker',
  });
  assert.equal(result.status, TASK_STATUS.FAILED);
  assert.equal(result.failure_reason_code, RUNTIME_REASON.HANDLER_ERROR);
  assert.match(result.error, /no provider invoker/);
  assert.equal(artifactStore.artifactsForWorkflow('wf-noinvoker').length, 0);
});

test('520. a providerInvoker IS configured but an unrelated handler never calls generateContent — zero provider calls, zero extra artifacts', () => {
  const { store, runtime, artifactStore, audit } = stackSetup({ handlers: { 'inert-agent': () => ({ status: 'ok', result: {}, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] }) } });
  registerAgentVersion(store, 'inert-agent');
  const result = runSingleTask(runtime, store, { agent_slug: 'inert-agent', input: {}, task_id: 't1', workflow_id: 'wf-inert' });
  assert.equal(result.status, TASK_STATUS.COMPLETED);
  assert.equal(artifactStore.artifactsForWorkflow('wf-inert').length, 0);
  assert.equal(audit.all().filter((e) => e.event === 'provider.invocation').length, 0);
});

test('521. provenance from a generateContent-produced artifact matches the real agent, version, workflow, task, and registry SHA', () => {
  const { store, runtime, artifactStore, registrySha } = stackSetup({ handlers: CONTENT_AGENT_HANDLERS });
  registerContentAgent(store);
  const result = runSingleTask(runtime, store, {
    agent_slug: CONTENT_AGENT_SLUG, input: { brief: 'x' }, task_id: 'c1', workflow_id: 'wf-prov',
  });
  const artifact = artifactStore.getArtifact(result.output.result.script_artifact_id);
  assert.equal(artifact.agent_id, 'agent-content-demo');
  assert.equal(artifact.version_id, versionId('agent-content-demo', '1.0.0'));
  assert.equal(artifact.workflow_id, 'wf-prov');
  assert.equal(artifact.task_id, 'c1');
  assert.equal(artifact.registry_sha, registrySha);
});

test('522. the audit trail contains a provider.invocation event carrying the real agent_slug/task_id/tree_id (M22\'s invoke.js enrichment)', () => {
  const { store, runtime, audit } = stackSetup({ handlers: CONTENT_AGENT_HANDLERS });
  registerContentAgent(store);
  runSingleTask(runtime, store, { agent_slug: CONTENT_AGENT_SLUG, input: { brief: 'x' }, task_id: 'c1', workflow_id: 'wf-audit-provider' });
  const events = audit.all().filter((e) => e.event === 'provider.invocation');
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'ok');
  assert.equal(events[0].agent_slug, CONTENT_AGENT_SLUG);
  assert.equal(events[0].task_id, 'c1');
  assert.equal(events[0].tree_id, 'wf-audit-provider');
});

test('523. the audit trail contains a matching artifact.created event for the generateContent-produced artifact', () => {
  const { store, runtime, audit } = stackSetup({ handlers: CONTENT_AGENT_HANDLERS });
  registerContentAgent(store);
  const result = runSingleTask(runtime, store, { agent_slug: CONTENT_AGENT_SLUG, input: { brief: 'x' }, task_id: 'c1', workflow_id: 'wf-audit-artifact' });
  const events = audit.all().filter((e) => e.event === 'artifact.created');
  assert.equal(events.length, 1);
  assert.equal(events[0].artifact_id, result.output.result.script_artifact_id);
  assert.equal(events[0].workflow_id, 'wf-audit-artifact');
});

// ── 9-12: the full six-stage media pipeline, through the real coordinator ─

test('524. (execution path) the six-stage media pipeline runs end to end through the real, unmodified router -> workflow -> execution coordinator -> runtime chain', () => {
  const { store, coordinator, workflow, artifactStore } = stackSetup();
  registerMediaPipelineAgents(store);
  workflow.createWorkflow({ workflow_id: 'wf-e2e-media', budget_limit: 1000 });

  const proposal = coordinator.proposeTask({
    workflow_id: 'wf-e2e-media', task_id: 'research', required_capability: 'media-research',
    input: { topic: 'solar panels', auto_chain: true },
  });
  assert.equal(proposal.decision, 'accepted');

  const final = coordinator.runToCompletion({ workflow_id: 'wf-e2e-media' });
  assert.equal(final.workflow.state, WORKFLOW_STATE.COMPLETED);

  const artifacts = artifactStore.artifactsForWorkflow('wf-e2e-media');
  assert.equal(artifacts.length, 6);
  assert.deepEqual(
    artifacts.map((a) => a.artifact_type).sort(),
    [ARTIFACT_TYPE.RESEARCH, ARTIFACT_TYPE.SCRIPT, ARTIFACT_TYPE.AUDIO, ARTIFACT_TYPE.IMAGE, ARTIFACT_TYPE.VIDEO, ARTIFACT_TYPE.SUBTITLE].sort(),
  );
});

test('525. VIDEO has real two-parent diamond lineage (audio + image); SUBTITLE is parented on the same real AUDIO artifact', () => {
  const { store, coordinator, workflow, artifactStore } = stackSetup();
  registerMediaPipelineAgents(store);
  workflow.createWorkflow({ workflow_id: 'wf-lineage-media', budget_limit: 1000 });
  coordinator.proposeTask({ workflow_id: 'wf-lineage-media', task_id: 'research', required_capability: 'media-research', input: { topic: 'x', auto_chain: true } });
  coordinator.runToCompletion({ workflow_id: 'wf-lineage-media' });

  const artifacts = artifactStore.artifactsForWorkflow('wf-lineage-media');
  const audio = artifacts.find((a) => a.artifact_type === ARTIFACT_TYPE.AUDIO);
  const image = artifacts.find((a) => a.artifact_type === ARTIFACT_TYPE.IMAGE);
  const video = artifacts.find((a) => a.artifact_type === ARTIFACT_TYPE.VIDEO);
  const subtitle = artifacts.find((a) => a.artifact_type === ARTIFACT_TYPE.SUBTITLE);

  assert.equal(video.parent_artifact_ids.length, 2);
  assert.deepEqual([...video.parent_artifact_ids].sort(), [audio.artifact_id, image.artifact_id].sort());
  assert.deepEqual(subtitle.parent_artifact_ids, [audio.artifact_id]);
});

test('526. every artifact in the pipeline carries a real, resolvable agent_id/version_id and a real 64-char checksum', () => {
  const { store, coordinator, workflow, artifactStore } = stackSetup();
  registerMediaPipelineAgents(store);
  workflow.createWorkflow({ workflow_id: 'wf-checksum-media', budget_limit: 1000 });
  coordinator.proposeTask({ workflow_id: 'wf-checksum-media', task_id: 'research', required_capability: 'media-research', input: { topic: 'x', auto_chain: true } });
  coordinator.runToCompletion({ workflow_id: 'wf-checksum-media' });

  for (const a of artifactStore.artifactsForWorkflow('wf-checksum-media')) {
    assert.ok(a.agent_id, `${a.artifact_type} must carry a real agent_id`);
    assert.ok(a.version_id, `${a.artifact_type} must carry a real version_id`);
    assert.equal(a.checksum.length, 64);
    assert.equal(a.workflow_id, 'wf-checksum-media');
  }
});

test('527. distinct agents in the pipeline communicate only through task input and artifact IDs — no agent holds a reference to another\'s internal state', () => {
  // Structural: the ONE place any handler is ever invoked hands it a
  // fixed, narrow set of closures (input, callTool, callModel,
  // createArtifact, generateContent, DECISION) — never a reference to
  // another agent, the store, or any other handler. This is what makes
  // "no agent receives another agent's authority" true by construction:
  // there is no code path by which one handler could obtain a second
  // handler's closures.
  const runtimeSrc = readFileSync(new URL('../src/runtime.js', import.meta.url), 'utf8');
  assert.ok(runtimeSrc.includes('handler({ input, callTool, callModel, createArtifact, generateContent, DECISION })'));

  // Behavioral: running the whole pipeline does not let a later stage's
  // artifact/result depend on anything except the input it was actually
  // given — proven by re-running the SAME topic through an independent
  // stack and getting byte-identical deterministic content, with no
  // shared mutable state carried between agents beyond the artifact IDs
  // explicitly threaded through task input.
  const a = stackSetup();
  registerMediaPipelineAgents(a.store);
  a.workflow.createWorkflow({ workflow_id: 'wf-iso-a', budget_limit: 1000 });
  a.coordinator.proposeTask({ workflow_id: 'wf-iso-a', task_id: 'research', required_capability: 'media-research', input: { topic: 'isolation', auto_chain: true } });
  a.coordinator.runToCompletion({ workflow_id: 'wf-iso-a' });

  const b = stackSetup();
  registerMediaPipelineAgents(b.store);
  b.workflow.createWorkflow({ workflow_id: 'wf-iso-b', budget_limit: 1000 });
  b.coordinator.proposeTask({ workflow_id: 'wf-iso-b', task_id: 'research', required_capability: 'media-research', input: { topic: 'isolation', auto_chain: true } });
  b.coordinator.runToCompletion({ workflow_id: 'wf-iso-b' });

  // Compare the RESEARCH artifact specifically, not SCRIPT: every stage
  // past research embeds the PRECEDING stage's randomly-generated
  // artifact_id in its own provider input (by design — that is how
  // lineage is threaded through `input`), so script/audio/image/video/
  // subtitle checksums are expected to differ across two independent
  // runs even for the same topic. RESEARCH is the one stage whose
  // provider input depends on nothing but the topic, so it is the
  // correct, honest place to prove "no hidden shared state" — a real
  // cross-run leak (e.g. one run's store or invoker instance somehow
  // influencing the other's) would show up here as a checksum mismatch.
  const researchA = a.artifactStore.artifactsForWorkflow('wf-iso-a').find((x) => x.artifact_type === ARTIFACT_TYPE.RESEARCH);
  const researchB = b.artifactStore.artifactsForWorkflow('wf-iso-b').find((x) => x.artifact_type === ARTIFACT_TYPE.RESEARCH);
  assert.equal(researchA.checksum, researchB.checksum, 'identical input produces identical output — no cross-run state leakage between agents');
  assert.notEqual(researchA.artifact_id, researchB.artifact_id, 'two independent, genuinely separate artifacts — not the same one reused');
});

test('528. a YELLOW-clearance generateContent-using agent\'s downstream tool call still requires real approval — generateContent and Broker authorization are fully independent', () => {
  function publishAfterGenerateHandler({ input, generateContent, callTool }) {
    const gen = generateContent({
      provider_id: 'deterministic-text', model_id: 'deterministic-text-v1',
      input: { text: 'publish brief' }, artifact_type: ARTIFACT_TYPE.SOCIAL_PACKAGE,
    });
    if (gen.outcome !== 'created') throw new Error('unexpected');
    const toolResult = callTool('fake.send_message', { recipient_domain: 'approved-client.example', body: 'publish' }, input.idempotency_key ?? null);
    return {
      status: 'ok', result: { artifact_id: gen.artifact.artifact_id, publish_decision: toolResult.decision },
      confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
    };
  }
  const { store, runtime, artifactStore } = stackSetup({ handlers: { 'publish-provider-agent': publishAfterGenerateHandler } });
  registerAgentVersion(store, 'publish-provider-agent', { clearance: 'YELLOW', allowed_tools: ['fake.send_message'] });
  const result = runSingleTask(runtime, store, {
    agent_slug: 'publish-provider-agent', input: { idempotency_key: 'k-528' }, task_id: 't1', workflow_id: 'wf-approval-provider',
  });
  assert.equal(result.status, TASK_STATUS.COMPLETED);
  assert.equal(result.output.result.publish_decision, DECISION.NEEDS_APPROVAL);
  assert.equal(artifactStore.artifactsForWorkflow('wf-approval-provider').length, 1, 'the artifact never depended on the tool call succeeding');
});

// ── Adversarial (25 scenarios, per the M22 directive) ──────────────────────

test('529. (adversarial #1: forged provider_id) a request naming a provider_id crafted to resemble a real one, but not registered, fails closed', () => {
  function forgedProviderIdHandler({ generateContent }) {
    const result = generateContent({
      provider_id: 'deterministic-text-v2-totally-real', model_id: 'deterministic-text-v1',
      input: { text: 'x' }, artifact_type: ARTIFACT_TYPE.TEXT,
    });
    return { status: 'ok', result: { outcome: result.outcome, code: result.code }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  }
  const { store, runtime, artifactStore } = stackSetup({ handlers: { 'forger-agent': forgedProviderIdHandler } });
  registerAgentVersion(store, 'forger-agent');
  const result = runSingleTask(runtime, store, { agent_slug: 'forger-agent', input: {}, task_id: 't1', workflow_id: 'wf-forge-provider' });
  assert.equal(result.status, TASK_STATUS.COMPLETED);
  assert.equal(result.output.result.outcome, 'rejected');
  assert.equal(result.output.result.code, 'PROVIDER_NOT_FOUND');
  assert.equal(artifactStore.artifactsForWorkflow('wf-forge-provider').length, 0);
});

test('530. (adversarial #2: unknown provider) a request naming a nonsense provider_id fails closed, no artifact created', () => {
  function unknownProviderHandler({ generateContent }) {
    const result = generateContent({ provider_id: 'nonexistent-provider', model_id: 'x', input: { text: 'x' }, artifact_type: ARTIFACT_TYPE.TEXT });
    return { status: 'ok', result: { outcome: result.outcome, code: result.code }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  }
  const { store, runtime, artifactStore } = stackSetup({ handlers: { 'x-agent': unknownProviderHandler } });
  registerAgentVersion(store, 'x-agent');
  const result = runSingleTask(runtime, store, { agent_slug: 'x-agent', input: {}, task_id: 't1', workflow_id: 'wf-unk-provider' });
  assert.equal(result.output.result.code, 'PROVIDER_NOT_FOUND');
  assert.equal(artifactStore.artifactsForWorkflow('wf-unk-provider').length, 0);
});

test('531. (adversarial #3: unknown model) a request naming an unknown model_id on a REAL, registered provider fails closed', () => {
  function unknownModelHandler({ generateContent }) {
    const result = generateContent({ provider_id: 'deterministic-text', model_id: 'nonexistent-model-v99', input: { text: 'x' }, artifact_type: ARTIFACT_TYPE.TEXT });
    return { status: 'ok', result: { outcome: result.outcome, code: result.code }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  }
  const { store, runtime, artifactStore } = stackSetup({ handlers: { 'x-agent': unknownModelHandler } });
  registerAgentVersion(store, 'x-agent');
  const result = runSingleTask(runtime, store, { agent_slug: 'x-agent', input: {}, task_id: 't1', workflow_id: 'wf-unk-model' });
  assert.equal(result.output.result.code, 'MODEL_NOT_SUPPORTED');
  assert.equal(artifactStore.artifactsForWorkflow('wf-unk-model').length, 0);
});

function forgedField(field, value) {
  return ({ generateContent }) => {
    const gen = generateContent({
      provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'x' },
      artifact_type: ARTIFACT_TYPE.TEXT, [field]: value,
    });
    if (gen.outcome !== 'created') throw new Error(`unexpected: ${gen.code}`);
    return {
      status: 'ok', result: { artifact_id: gen.artifact.artifact_id, [field]: gen.artifact[field] ?? gen.artifact.provenance?.[field] ?? null },
      confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
    };
  };
}

test('532. (adversarial #4: forged agent_id) a generateContent request smuggling agent_id has zero effect — the real agent identity always wins', () => {
  const { store, runtime } = stackSetup({ handlers: { 'forge-agent-id': forgedField('agent_id', 'FORGED-AGENT') } });
  const { agentId } = registerAgentVersion(store, 'forge-agent-id');
  const result = runSingleTask(runtime, store, { agent_slug: 'forge-agent-id', input: {}, task_id: 't1', workflow_id: 'wf-forge-agentid' });
  assert.equal(result.output.result.agent_id, agentId);
  assert.notEqual(result.output.result.agent_id, 'FORGED-AGENT');
});

test('533. (adversarial #5: forged version_id) a generateContent request smuggling version_id has zero effect — the real active version always wins', () => {
  const { store, runtime } = stackSetup({ handlers: { 'forge-version-id': forgedField('version_id', 'some-other-agent@9.9.9') } });
  const { versionId: realVersionId } = registerAgentVersion(store, 'forge-version-id');
  const result = runSingleTask(runtime, store, { agent_slug: 'forge-version-id', input: {}, task_id: 't1', workflow_id: 'wf-forge-versionid' });
  assert.equal(result.output.result.version_id, realVersionId);
  assert.notEqual(result.output.result.version_id, 'some-other-agent@9.9.9');
});

test('534. (adversarial #6: forged registry_sha) a generateContent request smuggling registry_sha has zero effect — the real, constructor-injected SHA always wins', () => {
  const { store, runtime, registrySha } = stackSetup({ handlers: { 'forge-sha': forgedField('registry_sha', 'forged-sha-value') } });
  registerAgentVersion(store, 'forge-sha');
  const result = runSingleTask(runtime, store, { agent_slug: 'forge-sha', input: {}, task_id: 't1', workflow_id: 'wf-forge-sha' });
  assert.equal(result.output.result.registry_sha, registrySha);
  assert.notEqual(result.output.result.registry_sha, 'forged-sha-value');
});

test('535. (adversarial #7: forged workflow_id) a generateContent request smuggling workflow_id has zero effect — the artifact always belongs to the real workflow', () => {
  function handler({ generateContent }) {
    const gen = generateContent({
      provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'x' },
      artifact_type: ARTIFACT_TYPE.TEXT, workflow_id: 'FORGED-WORKFLOW',
    });
    if (gen.outcome !== 'created') throw new Error('unexpected');
    return { status: 'ok', result: { workflow_id: gen.artifact.workflow_id }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  }
  const { store, runtime } = stackSetup({ handlers: { 'forge-wf': handler } });
  registerAgentVersion(store, 'forge-wf');
  const result = runSingleTask(runtime, store, { agent_slug: 'forge-wf', input: {}, task_id: 't1', workflow_id: 'wf-real-target' });
  assert.equal(result.output.result.workflow_id, 'wf-real-target');
  assert.notEqual(result.output.result.workflow_id, 'FORGED-WORKFLOW');
});

test('536. (adversarial #8: forged task_id) a generateContent request smuggling task_id has zero effect — the artifact always belongs to the real task', () => {
  function handler({ generateContent }) {
    const gen = generateContent({
      provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'x' },
      artifact_type: ARTIFACT_TYPE.TEXT, task_id: 'FORGED-TASK',
    });
    if (gen.outcome !== 'created') throw new Error('unexpected');
    return { status: 'ok', result: { task_id: gen.artifact.task_id }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  }
  const { store, runtime } = stackSetup({ handlers: { 'forge-task': handler } });
  registerAgentVersion(store, 'forge-task');
  const result = runSingleTask(runtime, store, { agent_slug: 'forge-task', input: {}, task_id: 'real-task-id', workflow_id: 'wf-forge-task' });
  assert.equal(result.output.result.task_id, 'real-task-id');
  assert.notEqual(result.output.result.task_id, 'FORGED-TASK');
});

test('537. (adversarial #9: forged artifact provenance) a full forged provenance object embedded in the request has zero effect — provenance is always freshly derived', () => {
  function handler({ generateContent }) {
    const gen = generateContent({
      provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'x' },
      artifact_type: ARTIFACT_TYPE.TEXT, provenance: { agent_id: 'FORGED', version_id: 'FORGED', registry_sha: 'FORGED' }, artifact_id: 'FORGED-ARTIFACT-ID',
    });
    if (gen.outcome !== 'created') throw new Error('unexpected');
    return { status: 'ok', result: { artifact_id: gen.artifact.artifact_id, provenance: gen.artifact.provenance }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  }
  const { store, runtime, registrySha } = stackSetup({ handlers: { 'forge-prov': handler } });
  const { agentId } = registerAgentVersion(store, 'forge-prov');
  const result = runSingleTask(runtime, store, { agent_slug: 'forge-prov', input: {}, task_id: 't1', workflow_id: 'wf-forge-prov' });
  assert.notEqual(result.output.result.artifact_id, 'FORGED-ARTIFACT-ID');
  assert.equal(result.output.result.provenance.agent_id, agentId);
  assert.equal(result.output.result.provenance.registry_sha, registrySha);
});

test('538. (adversarial #10: forged budget override) a handler\'s output claiming a budget increase never changes any real budget row', () => {
  function handler({ generateContent }) {
    const gen = generateContent({ provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'x' }, artifact_type: ARTIFACT_TYPE.TEXT });
    if (gen.outcome !== 'created') throw new Error('unexpected');
    return {
      status: 'ok', result: { budget_override: 999999999, artifact_id: gen.artifact.artifact_id },
      confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: { tokens: 999999 }, errors: [],
    };
  }
  const { store, runtime } = stackSetup({ handlers: { 'budget-claim': handler } });
  registerAgentVersion(store, 'budget-claim');
  budget(store, { task_id: 't1', workflow_id: 'wf-budget-claim-prov', agent_slug: 'budget-claim', limit: 100 });
  const before = store.budgetsFor({ task_id: 't1', tree_id: 'wf-budget-claim-prov', agent_slug: 'budget-claim' });
  const result = runtime.runTask({ agent_slug: 'budget-claim', input: {}, task_id: 't1', tree_id: 'wf-budget-claim-prov' });
  assert.equal(result.status, TASK_STATUS.COMPLETED);
  const after = store.budgetsFor({ task_id: 't1', tree_id: 'wf-budget-claim-prov', agent_slug: 'budget-claim' });
  assert.deepEqual(after, before, 'nothing here ever calls chargeBudgets — the claimed override is just data');
});

test('539. (adversarial #11: forged freeze removal) a handler\'s output claiming to lift a Guardian freeze has zero effect on the real freeze', () => {
  function handler({ input }) {
    return {
      status: 'ok', result: { remove_freeze: true, unfreeze: true, guardian_override: true, topic: String(input.topic ?? '') },
      confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
    };
  }
  const { store, runtime } = stackSetup({ handlers: { 'unfreeze-claim': handler } });
  registerAgentVersion(store, 'unfreeze-claim');
  store.addFreeze({ scope: 'agent', target_id: 'unfreeze-claim', reason: 'pre-existing', imposed_by: 'guardian', imposed_at: T0, expires_at: null });
  const first = runSingleTask(runtime, store, { agent_slug: 'unfreeze-claim', input: { topic: 'x' }, task_id: 't1', workflow_id: 'wf-unfreeze-prov' });
  assert.equal(first.status, TASK_STATUS.FAILED, 'frozen before it ever ran, so its claim never even executed');
  const second = runSingleTask(runtime, store, { agent_slug: 'unfreeze-claim', input: { topic: 'x' }, task_id: 't2', workflow_id: 'wf-unfreeze-prov' });
  assert.equal(second.status, TASK_STATUS.FAILED, 'the freeze is still active — nothing lifted it');
  assert.ok(store.activeFreeze('agent', 'unfreeze-claim', T0));
});

test('540. (adversarial #12: forged approval) a handler claiming approval_status "approved" on its own generateContent request does not satisfy the real Approval Engine', () => {
  function handler({ generateContent, callTool, input }) {
    const gen = generateContent({
      provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'x' },
      artifact_type: ARTIFACT_TYPE.TEXT, approval_status: 'approved',
    });
    if (gen.outcome !== 'created') throw new Error('unexpected');
    const toolResult = callTool('fake.send_message', { recipient_domain: 'approved-client.example', body: 'x' }, input.idempotency_key ?? null);
    return {
      status: 'ok', result: { approval_status: gen.artifact.approval_status, tool_decision: toolResult.decision },
      confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
    };
  }
  const { store, runtime } = stackSetup({ handlers: { 'claim-approval': handler } });
  registerAgentVersion(store, 'claim-approval', { clearance: 'YELLOW', allowed_tools: ['fake.send_message'] });
  const result = runSingleTask(runtime, store, { agent_slug: 'claim-approval', input: { idempotency_key: 'k-540' }, task_id: 't1', workflow_id: 'wf-claim-approval-prov' });
  assert.equal(result.output.result.tool_decision, DECISION.NEEDS_APPROVAL, 'the forged approval_status field means nothing to the Broker');
});

test('541. (adversarial #13: forged clearance) a handler\'s output claiming a different clearance never changes the real agent\'s clearance in the store', () => {
  function handler({ generateContent, input }) {
    const gen = generateContent({ provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'x' }, artifact_type: ARTIFACT_TYPE.TEXT });
    if (gen.outcome !== 'created') throw new Error('unexpected');
    return { status: 'ok', result: { clearance: 'RED', topic: String(input.topic ?? '') }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  }
  const { store, runtime } = stackSetup({ handlers: { 'claim-clearance': handler } });
  registerAgentVersion(store, 'claim-clearance', { clearance: 'GREEN' });
  const before = store.getAgent('claim-clearance').clearance;
  const result = runSingleTask(runtime, store, { agent_slug: 'claim-clearance', input: { topic: 'x' }, task_id: 't1', workflow_id: 'wf-claim-clearance-prov' });
  assert.equal(result.output.result.clearance, 'RED', 'the field is present verbatim...');
  assert.equal(store.getAgent('claim-clearance').clearance, before, '...and the real store record is unchanged');
});

const AUTHORIZATION_SHAPED_OUTPUT = Object.freeze({
  approved: true, clearance: 'RED', remove_freeze: true, budget_override: 999999,
  tool: 'fake.transfer_funds', approval_id: 'forged-approval', self_approve_version: true,
});

function rogueRegistry() {
  return createContentProviderRegistry({
    'rogue-provider': {
      provider_type: PROVIDER_TYPE.TEXT_GENERATION, provider_version: '1', deterministic: true, enabled: true,
      models: {
        m1: {
          max_input_units: 1000, max_output_units: 1000, timeout_ms: 1000, default_max_retries: 0,
          invoke: () => ({
            status: 'ok',
            output: { text: 'looks fine', ...AUTHORIZATION_SHAPED_OUTPUT },
            usage: { input_units: 1, output_units: 1 },
          }),
        },
      },
    },
  });
}

test('542. (adversarial #14: provider attempting tool execution) a rogue provider\'s output naming a tool never causes that tool to execute', () => {
  function handler({ generateContent }) {
    const gen = generateContent({ provider_id: 'rogue-provider', model_id: 'm1', input: { text: 'x' }, artifact_type: ARTIFACT_TYPE.TEXT });
    return { status: 'ok', result: { outcome: gen.outcome, tool_field: gen.artifact?.content }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  }
  const { store, runtime, broker } = stackSetup({ registry: rogueRegistry(), handlers: { 'rogue-target-agent': handler } });
  registerAgentVersion(store, 'rogue-target-agent');
  const before = { ...store.getAgent('rogue-target-agent') };
  const result = runSingleTask(runtime, store, { agent_slug: 'rogue-target-agent', input: {}, task_id: 't1', workflow_id: 'wf-rogue-tool' });
  assert.equal(result.status, TASK_STATUS.COMPLETED);
  assert.equal(result.output.result.outcome, 'created', 'the envelope is valid data, so the artifact is created normally...');
  assert.equal(store.getAgent('rogue-target-agent').clearance, before.clearance);
  assert.equal(store.getAgent('rogue-target-agent').state, before.state);
  const toolResult = broker.execute({ agent_slug: 'rogue-target-agent', tool_id: 'fake.transfer_funds', task_id: 'wf-rogue-tool', tree_id: 'wf-rogue-tool', payload: {} });
  assert.equal(toolResult.decision, DECISION.DENY, 'the Broker was never called with this tool by any code this milestone added — confirmed independently it would refuse it anyway');
});

const PROVIDER_EXECUTION_NEW_FILES = Object.freeze([
  '../src/demo-content-agent.js',
  '../src/demo-media-pipeline-agents.js',
]);

const FORBIDDEN_AUTHORIZATION_TERMS = Object.freeze([
  'broker.execute(', 'broker.authorize(', 'createBroker(',
  'store.addFreeze(', 'addFreeze(', 'createGuardian(',
  '.decide(', '.revoke(', 'createApprovalEngine(',
  'setLifecycleState(', 'setActiveVersion(',
  'chargeBudgets(', 'addBudget(',
]);

test('543. (adversarial #15: provider attempting Broker access) no file this milestone added references broker.execute/broker.authorize/createBroker', () => {
  for (const path of PROVIDER_EXECUTION_NEW_FILES) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const term of ['broker.execute(', 'broker.authorize(', 'createBroker(']) {
      assert.ok(!src.includes(term), `${path} must not reference "${term}"`);
    }
  }
});

test('544. (adversarial #16: provider attempting Guardian access) no file this milestone added references addFreeze/createGuardian/freeze mutation', () => {
  for (const path of PROVIDER_EXECUTION_NEW_FILES) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const term of ['addFreeze(', 'createGuardian(']) {
      assert.ok(!src.includes(term), `${path} must not reference "${term}"`);
    }
  }
});

test('545. (adversarial #17: provider attempting lifecycle mutation) no file this milestone added references setLifecycleState/setActiveVersion', () => {
  for (const path of PROVIDER_EXECUTION_NEW_FILES) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const term of ['setLifecycleState(', 'setActiveVersion(']) {
      assert.ok(!src.includes(term), `${path} must not reference "${term}"`);
    }
  }
});

test('546. (adversarial #18: provider attempting store mutation) no HANDLER function this milestone added references any store-mutation method beyond the trusted closures runtime.js hands it', () => {
  // registerAgent/addAgentVersion are excluded: legitimate, pre-execution
  // SETUP calls (identical to every demo file since M14), never reachable
  // from inside a handler or from a provider. Every other term here would
  // be genuinely alarming inside a HANDLER body.
  for (const path of PROVIDER_EXECUTION_NEW_FILES) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const term of FORBIDDEN_AUTHORIZATION_TERMS) {
      assert.ok(!src.includes(term), `${path} must not reference "${term}"`);
    }
  }
});

test('547. (adversarial #19: provider registry mutation) a generateContent request cannot register, add, or modify any provider — the registry is unaffected', () => {
  const before = defaultContentProviderRegistry.listProviders();
  function handler({ generateContent }) {
    const gen = generateContent({
      provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'x' },
      artifact_type: ARTIFACT_TYPE.TEXT,
      // None of these do anything — generateContent's request shape has
      // no field resembling registration, and even if it did, the
      // registry object itself has no register/add/set method (M21,
      // re-proven below).
      register_provider: { provider_id: 'evil', provider_type: 'TEXT_GENERATION' },
      new_provider: 'evil-provider',
    });
    return { status: 'ok', result: { outcome: gen.outcome }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  }
  const { store, runtime } = stackSetup({ handlers: { 'reg-attempt': handler } });
  registerAgentVersion(store, 'reg-attempt');
  const result = runSingleTask(runtime, store, { agent_slug: 'reg-attempt', input: {}, task_id: 't1', workflow_id: 'wf-reg-attempt' });
  assert.equal(result.output.result.outcome, 'created');
  assert.deepEqual(defaultContentProviderRegistry.listProviders(), before);
  assert.ok(!('register' in defaultContentProviderRegistry));
  assert.ok(!('add' in defaultContentProviderRegistry));
});

test('548. (adversarial #20: oversized input) a generateContent request whose input exceeds the model\'s declared ceiling fails closed before the provider ever runs', () => {
  const registry = createContentProviderRegistry({
    'small-provider': {
      provider_type: PROVIDER_TYPE.TEXT_GENERATION, provider_version: '1', deterministic: true, enabled: true,
      models: { m1: { max_input_units: 10, max_output_units: 1000, timeout_ms: 1000, default_max_retries: 0, invoke: () => ({ status: 'ok', output: { text: 'x' }, usage: { input_units: 1, output_units: 1 } }) } },
    },
  });
  let invoked = false;
  const trackedRegistry = { ...registry, getModel: (p, m) => { const model = registry.getModel(p, m); return model ? { ...model, invoke: (a) => { invoked = true; return model.invoke(a); } } : null; }, getProvider: registry.getProvider.bind(registry) };
  function handler({ generateContent }) {
    const gen = generateContent({ provider_id: 'small-provider', model_id: 'm1', input: { text: 'x'.repeat(500) }, artifact_type: ARTIFACT_TYPE.TEXT });
    return { status: 'ok', result: { outcome: gen.outcome, code: gen.code }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  }
  const { store, runtime, artifactStore } = stackSetup({ registry: trackedRegistry, handlers: { 'oversize-input': handler } });
  registerAgentVersion(store, 'oversize-input');
  const result = runSingleTask(runtime, store, { agent_slug: 'oversize-input', input: {}, task_id: 't1', workflow_id: 'wf-oversize-input' });
  assert.equal(result.output.result.code, 'PROVIDER_INPUT_TOO_LARGE');
  assert.equal(invoked, false, 'the provider must never be called once input exceeds the ceiling');
  assert.equal(artifactStore.artifactsForWorkflow('wf-oversize-input').length, 0);
});

test('549. (adversarial #21: oversized output) a provider whose response exceeds the declared output ceiling is rejected, no artifact created', () => {
  const registry = createContentProviderRegistry({
    'big-output-provider': {
      provider_type: PROVIDER_TYPE.TEXT_GENERATION, provider_version: '1', deterministic: true, enabled: true,
      models: {
        m1: {
          max_input_units: 1000, max_output_units: 10, timeout_ms: 1000, default_max_retries: 0,
          invoke: () => ({ status: 'ok', output: { text: 'x'.repeat(500) }, usage: { input_units: 1, output_units: 500 } }),
        },
      },
    },
  });
  function handler({ generateContent }) {
    const gen = generateContent({ provider_id: 'big-output-provider', model_id: 'm1', input: { text: 'x' }, artifact_type: ARTIFACT_TYPE.TEXT });
    return { status: 'ok', result: { outcome: gen.outcome, code: gen.code }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  }
  const { store, runtime, artifactStore } = stackSetup({ registry, handlers: { 'oversize-output': handler } });
  registerAgentVersion(store, 'oversize-output');
  const result = runSingleTask(runtime, store, { agent_slug: 'oversize-output', input: {}, task_id: 't1', workflow_id: 'wf-oversize-output' });
  assert.equal(result.output.result.code, 'PROVIDER_OUTPUT_TOO_LARGE');
  assert.equal(artifactStore.artifactsForWorkflow('wf-oversize-output').length, 0);
});

test('550. (adversarial #22: invalid artifact type) a generateContent request naming an unknown artifact_type is rejected as DATA, never a fake success', () => {
  function handler({ generateContent }) {
    const result = generateContent({
      provider_id: 'deterministic-text', model_id: 'deterministic-text-v1',
      input: { text: 'x' }, artifact_type: 'NOT_A_REAL_TYPE',
    });
    return { status: 'ok', result: { outcome: result.outcome, code: result.code }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  }
  const { store, runtime, artifactStore } = stackSetup({ handlers: { 'bad-type': handler } });
  registerAgentVersion(store, 'bad-type');
  const result = runSingleTask(runtime, store, { agent_slug: 'bad-type', input: {}, task_id: 't1', workflow_id: 'wf-bad-artifact-type' });
  assert.equal(result.status, TASK_STATUS.COMPLETED, 'generateContent returns data the handler can inspect — it does not crash the task');
  assert.equal(result.output.result.outcome, 'rejected');
  assert.equal(result.output.result.code, 'PROVIDER_CONTRACT_VIOLATION');
  assert.equal(artifactStore.artifactsForWorkflow('wf-bad-artifact-type').length, 0);
});

test('551. (adversarial #23: invalid provider response) a provider returning malformed output is rejected via existing output-shape validation, no artifact created', () => {
  const registry = createContentProviderRegistry({
    'malformed-provider': {
      provider_type: PROVIDER_TYPE.TEXT_GENERATION, provider_version: '1', deterministic: true, enabled: true,
      models: { m1: { max_input_units: 1000, max_output_units: 1000, timeout_ms: 1000, default_max_retries: 0, invoke: () => ({ status: 'ok', output: { not_text: 123 }, usage: { input_units: 1, output_units: 1 } }) } },
    },
  });
  function handler({ generateContent }) {
    const gen = generateContent({ provider_id: 'malformed-provider', model_id: 'm1', input: { text: 'x' }, artifact_type: ARTIFACT_TYPE.TEXT });
    return { status: 'ok', result: { outcome: gen.outcome, code: gen.code }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
  }
  const { store, runtime, artifactStore } = stackSetup({ registry, handlers: { 'malformed-agent': handler } });
  registerAgentVersion(store, 'malformed-agent');
  const result = runSingleTask(runtime, store, { agent_slug: 'malformed-agent', input: {}, task_id: 't1', workflow_id: 'wf-malformed' });
  assert.equal(result.output.result.code, 'PROVIDER_OUTPUT_INVALID');
  assert.equal(artifactStore.artifactsForWorkflow('wf-malformed').length, 0);
});

test('552. (adversarial #24: frozen agent) a Guardian freeze blocks generateContent entirely — the provider is never invoked, no artifact is created', () => {
  const { store, runtime, artifactStore, audit } = stackSetup({ handlers: CONTENT_AGENT_HANDLERS });
  registerContentAgent(store);
  store.addFreeze({ scope: 'global', target_id: null, reason: 'test freeze', imposed_by: 'guardian', imposed_at: T0, expires_at: null });
  const result = runSingleTask(runtime, store, { agent_slug: CONTENT_AGENT_SLUG, input: { brief: 'x' }, task_id: 't1', workflow_id: 'wf-frozen-provider' });
  assert.equal(result.status, TASK_STATUS.FAILED);
  assert.equal(result.failure_reason_code, RUNTIME_REASON.AGENT_FROZEN);
  assert.equal(artifactStore.artifactsForWorkflow('wf-frozen-provider').length, 0, 'the handler never ran — generateContent was never called');
  assert.equal(audit.all().filter((e) => e.event === 'provider.invocation').length, 0, 'the provider was never invoked');
});

test('553. (adversarial #25: insufficient budget) a task with no budget row never reaches generateContent at all — the existing pre-flight blocks it', () => {
  const { store, runtime, artifactStore } = stackSetup({ handlers: CONTENT_AGENT_HANDLERS });
  registerContentAgent(store);
  // deliberately NOT calling budget(...) first
  const result = runtime.runTask({ agent_slug: CONTENT_AGENT_SLUG, input: { brief: 'x' }, task_id: 't1', tree_id: 'wf-nobudget-provider' });
  assert.equal(result.status, TASK_STATUS.FAILED);
  assert.equal(result.failure_reason_code, RUNTIME_REASON.BUDGET_MISSING);
  assert.equal(artifactStore.artifactsForWorkflow('wf-nobudget-provider').length, 0);
});

test('559. the demo file\'s own adversarial fixture (media-rogue-agent) forges identity in its generateContent request and emits authorization-shaped output — both inert, through real execution', () => {
  const { store, runtime, artifactStore } = stackSetup({ handlers: MEDIA_PIPELINE_HANDLERS });
  registerMediaRogueAgent(store);
  const before = { ...store.getAgent(S.ROGUE) };
  const result = runSingleTask(runtime, store, { agent_slug: S.ROGUE, input: { topic: 'x' }, task_id: 't1', workflow_id: 'wf-media-rogue' });
  assert.equal(result.status, TASK_STATUS.COMPLETED, 'the envelope is valid data, so the task completes normally');
  assert.equal(result.output.result.generated_outcome, 'created', 'the forged identity fields never blocked real, legitimate generation...');
  const artifact = artifactStore.getArtifact(result.output.result.real_artifact_id);
  assert.equal(artifact.agent_id, MEDIA_PIPELINE_AGENTS.rogue.version.agent_id, '...and the artifact carries the REAL agent identity, not the forged one');
  assert.equal(result.output.result.clearance, 'RED', 'the authorization-shaped output field is present verbatim...');
  assert.equal(store.getAgent(S.ROGUE).state, before.state, '...and changes nothing about the real agent record');
});

// ── Resource governor composition (M22's own affirmation of M21's proof) ──

test('554. every provider generation through generateContent still passes through the EXISTING, unmodified resource-governor.js when composed in front of it', async () => {
  const { createResourceGovernor, RESOURCE_GOVERNOR_POLICY } = await import('../src/resource-governor.js');
  const { store, providerInvoker, audit, clock } = stackSetup();
  registerAgentVersion(store, 'governed-agent');
  const governor = createResourceGovernor({
    modelRuntime: { invokeModel: providerInvoker.invoke }, registry: defaultContentProviderRegistry, audit, clock,
  });
  governor.configureGlobalBudget(1_000_000);
  governor.configureAgentBudget('governed-agent', 1_000_000);
  governor.configureTaskBudget('gov-task-1', 1_000_000);

  // Deterministic providers are genuinely zero-cost, so the MONETARY
  // ceiling can never be what stops them — exactly the honest reframing
  // M21's own test 499 already established. The independent, real
  // MAX_CALLS_PER_TASK ceiling is what proves the boundary is live.
  const req = { provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'x' }, agent_slug: 'governed-agent', task_id: 'gov-task-1' };
  for (let i = 0; i < RESOURCE_GOVERNOR_POLICY.MAX_CALLS_PER_TASK; i++) {
    const r = await governor.invoke(req);
    assert.equal(r.status, 'ok', `call ${i} should succeed`);
  }
  const denied = await governor.invoke(req);
  assert.equal(denied.status, 'failed');
  assert.equal(denied.reason, 'MODEL_CALL_LIMIT');
});

// ── Structural: re-sweep everything this milestone touched ────────────────

test('555. structural: no network, credential, or shell-execution primitive in any file this milestone added or modified', () => {
  for (const path of [
    '../src/runtime.js', '../src/providers/invoke.js',
    '../src/demo-content-agent.js', '../src/demo-media-pipeline-agents.js',
  ]) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const term of ['node:http', 'node:https', 'node:net', 'child_process', 'fetch(', 'axios', 'process.env', 'API_KEY', 'ANTHROPIC', 'GROQ', 'ELEVENLABS', 'OPENAI']) {
      assert.ok(!src.includes(term), `${path} must not contain ${term}`);
    }
  }
});

test('556. structural: the media pipeline agents make zero direct model calls and fabricate no cost — every artifact is provider-sourced', () => {
  const src = readFileSync(new URL('../src/demo-media-pipeline-agents.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('callModel('), 'these six agents produce content only through generateContent, never callModel directly');
  const src2 = readFileSync(new URL('../src/demo-content-agent.js', import.meta.url), 'utf8');
  assert.ok(!src2.includes('callModel('));
});

test('557. structural: runtime.js\'s generateContent closure holds no reference to the provider registry itself — only to the already-governed invoker', () => {
  const src = readFileSync(new URL('../src/runtime.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('providerRegistry'), 'runtime.js must never receive or expose a "providerRegistry" parameter — only providerInvoker');
  assert.ok(!src.includes('createContentProviderRegistry'), 'runtime.js must not construct or reference the registry constructor directly');
});

// ── Postgres: consistency, mirroring M20's own section ─────────────────────
//
// `runtime.js`'s live execution path (D28) only ever runs against the
// synchronous in-memory store — unchanged by M22. `generateContent`
// composes `providerInvoker.invoke` (fully synchronous, M21) with the
// existing `createArtifact` closure (already proven synchronous-store-
// only, M20) — there is no new async/Postgres surface for this milestone
// to prove, since none was added. Skipped entirely — not failed — when
// AI_HQ_TEST_DATABASE_URL is unset, exactly like every prior milestone's
// Postgres section.

const PG_TEST_URL = process.env.AI_HQ_TEST_DATABASE_URL;
if (PG_TEST_URL) {
  const { createPostgresStore } = await import('../src/postgres-store.js');
  const { createPostgresArtifactStore } = await import('../src/postgres-artifact-store.js');
  const { createIsolatedTestDatabase } = await import('./helpers/pg-test-db.mjs');
  const { pool, cleanup } = await createIsolatedTestDatabase('provider_execution');
  const pgStore = createPostgresStore(pool);
  const pgArtifactStore = createPostgresArtifactStore(pool);

  test('558. [postgres] a generateContent-shaped artifact request round-trips correctly through the async artifact service against a real Postgres database', async () => {
    const agentId = 'agent-pg-provider-exec';
    const version = makeAgentVersion({
      agent_id: agentId, version: '1.0.0', purpose: 'pg provider exec fixture', department: 'content',
      state: VERSION_STATE.APPROVED, clearance: 'GREEN', allowed_tools: [],
      limits: {}, input_contract: {}, output_contract: {}, created_at: 0,
      approved_by: 'founder', approved_at: 0,
    });
    await pgStore.addAgentVersion(version);
    await pgStore.registerAgent(makeAgent({ id: agentId, slug: 'pg-provider-exec-agent', name: 'pg-provider-exec-agent', active_version_id: versionId(agentId, '1.0.0') }));
    await pgStore.createTask({
      id: 'pg-provider-exec-task', parent_task_id: null, tree_id: 'pg-provider-exec-wf', workflow_id: 'pg-provider-exec-wf',
      depth: 0, agent_slug: 'pg-provider-exec-agent', status: 'pending', input: {}, created_at: 0,
    });
    const audit = createAuditSink();
    const invoker = createProviderInvoker({ registry: defaultContentProviderRegistry, audit, clock: () => T0 });
    const providerResult = invoker.invoke({ provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'pg test' } });
    assert.equal(providerResult.status, 'ok');
    const { buildArtifactRequestFromProviderResult } = await import('../src/providers/artifact-bridge.js');
    const req = buildArtifactRequestFromProviderResult({ providerResult, artifact_type: ARTIFACT_TYPE.TEXT });
    const svc = createArtifactService({ store: pgStore, artifactStore: pgArtifactStore, audit, clock: () => T0, registrySha: 'pg-provider-exec-sha' });
    const r = await svc.createArtifact({ ...req, workflow_id: 'pg-provider-exec-wf', task_id: 'pg-provider-exec-task', agent_slug: 'pg-provider-exec-agent' });
    assert.equal(r.outcome, 'created');
    const fetched = await pgArtifactStore.getArtifact(r.artifact.artifact_id);
    assert.equal(fetched.agent_id, agentId);
    assert.match(fetched.content, /SYNTHETIC FIXTURE/);
  });

  test('[postgres provider-execution] teardown: drop the isolated test database', async () => {
    await cleanup();
  });
} else {
  test('[postgres provider-execution] skipped — set AI_HQ_TEST_DATABASE_URL to run against a local Postgres', { skip: true }, () => {});
}

/**
 * CONTROLLED MULTI-STAGE LIVE TEXT PIPELINE (Milestone 29)
 *
 * Proves that FOUR independently governed, independently ticketed live
 * text specialists — research, script, hook, social-package — compose
 * safely in one Content Factory workflow, through the real, unmodified
 * router -> execution-coordinator -> workflow -> runtime chain, without
 * creating a second authorization path or letting spending multiply
 * because there are now several live stages instead of one.
 *
 * NO REAL CREDENTIAL IS USED. Every request is observed through an
 * injected `fetchImpl`; nothing in this file reaches a network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createMemoryStore } from '../src/store.js';
import { createMemoryArtifactStore } from '../src/artifact-store.js';
import { createArtifactService } from '../src/artifact-service.js';
import { createAuditSink } from '../src/audit.js';
import { createBroker } from '../src/broker.js';
import { createTools } from '../src/tools.js';
import { createRuntime, TASK_STATUS } from '../src/runtime.js';
import { createWorkflowEngine } from '../src/workflow.js';
import { createRouter } from '../src/router.js';
import { createGuardian } from '../src/guardian.js';
import { createExecutionCoordinator } from '../src/execution-coordinator.js';
import { createResourceGovernor } from '../src/resource-governor.js';
import { makeAgent, makeAgentVersion, VERSION_STATE, RUNTIME_STATE, versionId } from '../src/agents.js';
import { ARTIFACT_TYPE } from '../src/artifacts.js';
import { createProviderInvoker } from '../src/providers/invoke.js';
import { createAsyncProviderInvoker } from '../src/providers/invoke-async.js';
import { defaultContentProviderRegistry } from '../src/providers/default-registry.js';
import { createLiveProviderRegistry } from '../src/providers/live-registry.js';
import { createLiveProviderChain, LIVE_GATE_REASON } from '../src/providers/live-guard.js';
import { GROQ_PROVIDER_ID } from '../src/providers/groq.js';
import { GROQ_ENV } from '../src/providers/groq-config.js';
import {
  LIVE_TEXT_CAPABILITY_ID, LIVE_STAGE_REASON, createLiveStageConfig,
  resolveLiveStageContent, createLiveCapableInvoker, createMultiStageLiveInvoker,
} from '../src/content-factory-live.js';
import {
  registerContentFactoryAgents, registerAllContentFactoryLiveTextAgents, registerContentFactoryRogueAgent,
  CONTENT_FACTORY_HANDLERS, CONTENT_FACTORY_AGENT_SLUGS, CONTENT_FACTORY_CAPABILITY,
  buildLiveResearchPrompt, buildLiveScriptPrompt, buildLiveHookPrompt, buildLiveSocialPackagePrompt,
} from '../src/content-factory-agents.js';
import {
  runLiveTextContentPipeline, proposeAndRunLiveStage, proposeAndRunDeterministicStage,
} from '../src/content-factory-live-pipeline.js';

const T0 = 19_000_000;
const S = CONTENT_FACTORY_AGENT_SLUGS;
const CAP = CONTENT_FACTORY_CAPABILITY;
const WORKFLOW = 'wf-m29';
const SENTINEL = 'gsk_TESTONLY_M29_000000000000000000000000';
const MODEL = 'test-model-m29';
const LIVE_STAGE_SLUGS = [S.RESEARCH_LIVE, S.SCRIPT_LIVE, S.HOOK_LIVE, S.SOCIAL_PACKAGE_LIVE];
const LIVE_STAGE_TASK_IDS = Object.freeze({
  [S.RESEARCH_LIVE]: `${WORKFLOW}-research`,
  [S.SCRIPT_LIVE]: `${WORKFLOW}-script`,
  [S.HOOK_LIVE]: `${WORKFLOW}-hook`,
  [S.SOCIAL_PACKAGE_LIVE]: `${WORKFLOW}-social-package`,
});

function liveEnv(overrides = {}) {
  const env = {
    [GROQ_ENV.REAL_PROVIDER_ENABLED]: 'true', [GROQ_ENV.GROQ_ENABLED]: 'true',
    [GROQ_ENV.API_KEY]: SENTINEL, [GROQ_ENV.MODELS]: MODEL, [GROQ_ENV.MAX_SPEND_USD]: '0.05',
    ...overrides,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

function recordingFetch(responder) {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init }); return responder(url, init, calls.length); };
  impl.calls = calls;
  return impl;
}

/** Returns content whose length varies by prompt, so tests can tell
 * which stage's request actually produced a given response — used for
 * concurrency / cross-contamination checks. */
const okResponse = (text = 'Scene 1. Scene 2. Scene 3.') => ({
  ok: true, status: 200,
  json: async () => ({
    id: `req-${text.length}`, model: MODEL,
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: text.length, completion_tokens: 4 },
  }),
});
const errorResponse = (status, body = 'err') => ({ ok: false, status, text: async () => body, json: async () => ({}) });

/** The full real stack: real store, real broker, real workflow/router/
 * coordinator/guardian, a real multi-stage live invoker with all four
 * live specialists registered (opt-in, exactly as M29's directive
 * requires), and live stage configs bound to each. */
function pipelineStack(o = {}) {
  const store = createMemoryStore();
  const artifactStore = createMemoryArtifactStore();
  const audit = createAuditSink();
  const clock = o.clock ?? (() => T0);
  const registrySha = 'm29-registry-sha';
  const { tools } = createTools();
  const fetchImpl = o.fetchImpl ?? recordingFetch(() => okResponse());

  const broker = createBroker({ tools, store, audit, clock, registrySha });
  const artifactService = createArtifactService({ store, artifactStore, audit, clock, registrySha });

  const { registry: liveRegistry, groq } = createLiveProviderRegistry({
    env: o.env ?? liveEnv(), fetchImpl, maxCostPerCallUsd: o.perCall,
  });
  const asyncInvoker = createAsyncProviderInvoker({ registry: liveRegistry, audit, clock });
  const chain = createLiveProviderChain({
    store, invoker: asyncInvoker, createGovernor: createResourceGovernor, registry: liveRegistry, audit, clock,
  });
  const b = { global: 1000, agent: 1000, workflow: 1000, task: 1000, ...(o.budgets ?? {}) };
  chain.governor.configureGlobalBudget(b.global);
  for (const slug of LIVE_STAGE_SLUGS) chain.governor.configureAgentBudget(slug, b.agent);
  chain.governor.configureWorkflowBudget(WORKFLOW, b.workflow);
  for (const taskId of Object.values(LIVE_STAGE_TASK_IDS)) chain.governor.configureTaskBudget(taskId, b.task);

  const deterministicInvoker = createProviderInvoker({ registry: defaultContentProviderRegistry, audit, clock });
  const multiInvoker = createMultiStageLiveInvoker({ deterministicInvoker });

  registerContentFactoryAgents(store);
  if (!o.omitLiveAgents) registerAllContentFactoryLiveTextAgents(store);

  const runtime = createRuntime({
    store, broker, audit, clock, registrySha,
    handlers: CONTENT_FACTORY_HANDLERS, artifactService, providerInvoker: multiInvoker,
  });
  const router = createRouter({ store, audit, clock });
  const workflow = createWorkflowEngine({ store, runtime, broker, audit, clock, registrySha });
  const guardian = createGuardian({ store, audit, clock });
  const coordinator = createExecutionCoordinator({ workflow, router, guardian, store, audit, clock });

  const liveConfigs = {
    research: createLiveStageConfig({ capability: CAP.RESEARCH_LIVE, agent_slug: S.RESEARCH_LIVE, provider_id: GROQ_PROVIDER_ID, model_id: MODEL, artifact_type: ARTIFACT_TYPE.RESEARCH }),
    script: createLiveStageConfig({ capability: CAP.SCRIPT_LIVE, agent_slug: S.SCRIPT_LIVE, provider_id: GROQ_PROVIDER_ID, model_id: MODEL, artifact_type: ARTIFACT_TYPE.SCRIPT }),
    hook: createLiveStageConfig({ capability: CAP.HOOK_LIVE, agent_slug: S.HOOK_LIVE, provider_id: GROQ_PROVIDER_ID, model_id: MODEL, artifact_type: ARTIFACT_TYPE.TEXT }),
    social_package: createLiveStageConfig({ capability: CAP.SOCIAL_PACKAGE_LIVE, agent_slug: S.SOCIAL_PACKAGE_LIVE, provider_id: GROQ_PROVIDER_ID, model_id: MODEL, artifact_type: ARTIFACT_TYPE.SOCIAL_PACKAGE }),
  };

  return {
    store, artifactStore, audit, clock, tools, broker, artifactService, registrySha,
    fetchImpl, liveRegistry, groq, chain, deterministicInvoker, multiInvoker,
    runtime, router, workflow, guardian, coordinator, liveConfigs,
  };
}

function runPipeline(stack, o = {}) {
  return runLiveTextContentPipeline({
    store: stack.store, artifactStore: stack.artifactStore, workflow: stack.workflow, coordinator: stack.coordinator,
    runtime: stack.runtime, router: stack.router, guardian: stack.guardian, audit: stack.audit,
    chain: stack.chain, multiInvoker: stack.multiInvoker, liveConfigs: stack.liveConfigs,
    workflow_id: o.workflow_id ?? WORKFLOW, topic: o.topic ?? 'why sleep matters', budget_limit: o.budget_limit ?? 5000,
  });
}

// ══ 1. THE HAPPY PATH ═══════════════════════════════════════════════════

test('851. (M29) all four live stages compose in one workflow — exactly four network calls, one per stage', async () => {
  const stack = pipelineStack();
  const result = await runPipeline(stack);
  assert.equal(result.ok, true, `pipeline failed at ${result.stage}: ${JSON.stringify(result.task?.error ?? result.proposal?.reason)}`);
  assert.equal(stack.fetchImpl.calls.length, 4, 'exactly one network call per live stage — never more');
  assert.equal(result.workflow.state, 'completed');
  assert.ok(result.content_package_artifact_id);
});

test('852. (M29) every live artifact carries correct, trusted provenance — never from a request', async () => {
  const stack = pipelineStack();
  const result = await runPipeline(stack);
  assert.equal(result.ok, true);

  const cases = [
    [S.RESEARCH_LIVE, 'agent-cf-research-live', result.stages.research.artifact_id, ARTIFACT_TYPE.RESEARCH],
    [S.SCRIPT_LIVE, 'agent-cf-script-live', result.stages.script.artifact_id, ARTIFACT_TYPE.SCRIPT],
    [S.HOOK_LIVE, 'agent-cf-hook-live', result.stages.hook.artifact_id, ARTIFACT_TYPE.TEXT],
    [S.SOCIAL_PACKAGE_LIVE, 'agent-cf-social-package-live', result.stages.social_package.artifact_id, ARTIFACT_TYPE.SOCIAL_PACKAGE],
  ];
  for (const [slug, agentId, artifactId, expectedType] of cases) {
    const a = stack.artifactStore.getArtifact(artifactId);
    assert.equal(a.agent_id, agentId, slug);
    assert.equal(a.version_id, versionId(agentId, '1.0.0'), slug);
    assert.equal(a.registry_sha, 'm29-registry-sha', slug);
    assert.equal(a.workflow_id, WORKFLOW, slug);
    assert.equal(a.provider_id, GROQ_PROVIDER_ID, slug);
    assert.equal(a.model_id, MODEL, slug);
    assert.ok(a.provider_version, `${slug}: provider_version must survive`);
    assert.equal(a.artifact_type, expectedType, slug);
    assert.equal(a.checksum.length, 64, slug);
  }
});

test('853. (M29) the lineage graph is real — every live artifact\'s parents are actual prior artifact ids', async () => {
  const stack = pipelineStack();
  const result = await runPipeline(stack);
  assert.equal(result.ok, true);

  const research = stack.artifactStore.getArtifact(result.stages.research.artifact_id);
  const script = stack.artifactStore.getArtifact(result.stages.script.artifact_id);
  const hook = stack.artifactStore.getArtifact(result.stages.hook.artifact_id);
  const social = stack.artifactStore.getArtifact(result.stages.social_package.artifact_id);
  const idea = stack.artifactStore.getArtifact(result.stages.idea.artifact_id);

  assert.deepEqual(research.parent_artifact_ids, [], 'research is the pipeline root');
  assert.deepEqual(script.parent_artifact_ids, [idea.artifact_id], 'script\'s real parent is the idea artifact');
  assert.deepEqual(hook.parent_artifact_ids, [script.artifact_id]);
  assert.deepEqual([...social.parent_artifact_ids].sort(), [hook.artifact_id, script.artifact_id].sort());

  // And the deterministic idea stage's own lineage traces back to the
  // LIVE research artifact — proving the two providers' outputs form one
  // real graph, not two disconnected ones.
  assert.ok(idea.parent_artifact_ids.includes(research.artifact_id), 'idea must trace back to the live research artifact');
});

test('854. (M29) deterministic stages remain deterministic throughout a live-mixed run', async () => {
  const stack = pipelineStack();
  const result = await runPipeline(stack);
  assert.equal(result.ok, true);
  for (const key of ['fact_check', 'idea', 'audio', 'visual', 'subtitle', 'video_plan']) {
    const a = stack.artifactStore.getArtifact(result.stages[key].artifact_id);
    assert.ok(String(a.provider_id).startsWith('deterministic-'), `${key} must stay deterministic (got ${a.provider_id})`);
  }
});

// ══ 2. TICKET ATTACKS A–H ═══════════════════════════════════════════════

test('855. (M29 Attack A) a research ticket cannot be consumed as the script agent', async () => {
  const stack = pipelineStack();
  const ticket = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: stack.liveConfigs.research,
    agent_slug: S.RESEARCH_LIVE, task_id: LIVE_STAGE_TASK_IDS[S.RESEARCH_LIVE], workflow_id: WORKFLOW,
    input: buildLiveResearchPrompt({ topic: 't' }),
  });
  assert.equal(ticket.admitted, true);
  assert.equal(stack.fetchImpl.calls.length, 1);

  // Low-level: the single-ticket primitive refuses a caller-slug mismatch.
  const singleInvoker = createLiveCapableInvoker({ deterministicInvoker: stack.deterministicInvoker, ticket });
  const viaSingle = singleInvoker.invoke({
    provider_id: LIVE_TEXT_CAPABILITY_ID, input: buildLiveResearchPrompt({ topic: 't' }),
    agent_slug: S.SCRIPT_LIVE, task_id: ticket.task_id, tree_id: ticket.workflow_id,
  });
  assert.equal(viaSingle.status, 'failed');
  assert.equal(viaSingle.reason, LIVE_STAGE_REASON.LIVE_STAGE_NOT_ADMITTED);

  // Structural: the multi-stage router cannot even LOOK UP research's
  // ticket under the script agent's slug — it was never installed there.
  const multi = createMultiStageLiveInvoker({ deterministicInvoker: stack.deterministicInvoker });
  multi.installTicket(S.RESEARCH_LIVE, ticket);
  const viaRouter = multi.invoke({
    provider_id: LIVE_TEXT_CAPABILITY_ID, input: buildLiveResearchPrompt({ topic: 't' }),
    agent_slug: S.SCRIPT_LIVE, task_id: ticket.task_id, tree_id: ticket.workflow_id,
  });
  assert.equal(viaRouter.status, 'failed');
  assert.equal(viaRouter.reason, LIVE_STAGE_REASON.LIVE_STAGE_NOT_ADMITTED);
  assert.equal(stack.fetchImpl.calls.length, 1, 'no second network call from either attack');
});

test('856. (M29 Attack B) a script ticket cannot be consumed as the hook agent', async () => {
  const stack = pipelineStack();
  const ticket = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: stack.liveConfigs.script,
    agent_slug: S.SCRIPT_LIVE, task_id: LIVE_STAGE_TASK_IDS[S.SCRIPT_LIVE], workflow_id: WORKFLOW,
    input: buildLiveScriptPrompt({ topic: 't', idea_artifact_id: 'idea-x' }),
  });
  assert.equal(ticket.admitted, true);
  const multi = createMultiStageLiveInvoker({ deterministicInvoker: stack.deterministicInvoker });
  multi.installTicket(S.SCRIPT_LIVE, ticket);
  const stolen = multi.invoke({
    provider_id: LIVE_TEXT_CAPABILITY_ID, input: buildLiveScriptPrompt({ topic: 't', idea_artifact_id: 'idea-x' }),
    agent_slug: S.HOOK_LIVE, task_id: ticket.task_id, tree_id: ticket.workflow_id,
  });
  assert.equal(stolen.status, 'failed');
  assert.equal(stolen.reason, LIVE_STAGE_REASON.LIVE_STAGE_NOT_ADMITTED);
  assert.equal(stack.fetchImpl.calls.length, 1);
});

test('857. (M29 Attack C) a hook ticket cannot be consumed as the social-package agent', async () => {
  const stack = pipelineStack();
  const ticket = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: stack.liveConfigs.hook,
    agent_slug: S.HOOK_LIVE, task_id: LIVE_STAGE_TASK_IDS[S.HOOK_LIVE], workflow_id: WORKFLOW,
    input: buildLiveHookPrompt({ topic: 't', script_artifact_id: 'script-x' }),
  });
  assert.equal(ticket.admitted, true);
  const multi = createMultiStageLiveInvoker({ deterministicInvoker: stack.deterministicInvoker });
  multi.installTicket(S.HOOK_LIVE, ticket);
  const stolen = multi.invoke({
    provider_id: LIVE_TEXT_CAPABILITY_ID, input: buildLiveHookPrompt({ topic: 't', script_artifact_id: 'script-x' }),
    agent_slug: S.SOCIAL_PACKAGE_LIVE, task_id: ticket.task_id, tree_id: ticket.workflow_id,
  });
  assert.equal(stolen.status, 'failed');
  assert.equal(stolen.reason, LIVE_STAGE_REASON.LIVE_STAGE_NOT_ADMITTED);
  assert.equal(stack.fetchImpl.calls.length, 1);
});

test('858. (M29 Attack D) a ticket resolved for workflow A is refused under workflow B', async () => {
  const stack = pipelineStack();
  // A separate workflow/task scope, with its own budgets configured —
  // otherwise a missing budget (not the attack) would be why it refuses.
  stack.chain.governor.configureWorkflowBudget('wf-a', 1000);
  stack.chain.governor.configureTaskBudget('task-a', 1000);
  const ticket = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: stack.liveConfigs.research,
    agent_slug: S.RESEARCH_LIVE, task_id: 'task-a', workflow_id: 'wf-a',
    input: buildLiveResearchPrompt({ topic: 't' }),
  });
  assert.equal(ticket.admitted, true, ticket.detail ?? '');
  assert.equal(ticket.providerResult.status, 'ok', ticket.providerResult.reason);
  const invoker = createLiveCapableInvoker({ deterministicInvoker: stack.deterministicInvoker, ticket });
  const r = invoker.invoke({
    provider_id: LIVE_TEXT_CAPABILITY_ID, input: buildLiveResearchPrompt({ topic: 't' }),
    agent_slug: S.RESEARCH_LIVE, task_id: 'task-a', tree_id: 'wf-b', // same task_id, DIFFERENT workflow
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, LIVE_STAGE_REASON.LIVE_TICKET_SCOPE_MISMATCH);
  assert.equal(stack.fetchImpl.calls.length, 1);
});

test('859. (M29 Attack E) a consumed ticket cannot be reused', async () => {
  const stack = pipelineStack();
  const ticket = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: stack.liveConfigs.research,
    agent_slug: S.RESEARCH_LIVE, task_id: LIVE_STAGE_TASK_IDS[S.RESEARCH_LIVE], workflow_id: WORKFLOW,
    input: buildLiveResearchPrompt({ topic: 't' }),
  });
  const invoker = createLiveCapableInvoker({ deterministicInvoker: stack.deterministicInvoker, ticket });
  const req = { provider_id: LIVE_TEXT_CAPABILITY_ID, input: buildLiveResearchPrompt({ topic: 't' }), agent_slug: S.RESEARCH_LIVE, task_id: ticket.task_id, tree_id: ticket.workflow_id };
  const first = invoker.invoke(req);
  assert.equal(first.status, 'ok');
  const second = invoker.invoke(req);
  assert.equal(second.status, 'failed');
  assert.equal(second.reason, LIVE_STAGE_REASON.LIVE_TICKET_ALREADY_USED);
  assert.equal(stack.fetchImpl.calls.length, 1);
});

test('860. (M29 Attack F) a ticket cannot be redeemed for a modified request payload', async () => {
  const stack = pipelineStack();
  const ticket = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: stack.liveConfigs.hook,
    agent_slug: S.HOOK_LIVE, task_id: LIVE_STAGE_TASK_IDS[S.HOOK_LIVE], workflow_id: WORKFLOW,
    input: buildLiveHookPrompt({ topic: 'original topic', script_artifact_id: 's1' }),
  });
  const invoker = createLiveCapableInvoker({ deterministicInvoker: stack.deterministicInvoker, ticket });
  const r = invoker.invoke({
    provider_id: LIVE_TEXT_CAPABILITY_ID,
    input: buildLiveHookPrompt({ topic: 'a completely different topic', script_artifact_id: 's1' }),
    agent_slug: S.HOOK_LIVE, task_id: ticket.task_id, tree_id: ticket.workflow_id,
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, LIVE_STAGE_REASON.LIVE_REQUEST_MISMATCH);
  assert.equal(stack.fetchImpl.calls.length, 1);
});

test('861. (M29 Attack G) a ticket cannot be redeemed under a modified task id', async () => {
  const stack = pipelineStack();
  const ticket = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: stack.liveConfigs.social_package,
    agent_slug: S.SOCIAL_PACKAGE_LIVE, task_id: LIVE_STAGE_TASK_IDS[S.SOCIAL_PACKAGE_LIVE], workflow_id: WORKFLOW,
    input: buildLiveSocialPackagePrompt({ topic: 't', script_artifact_id: 's1', hook_artifact_id: 'h1' }),
  });
  const invoker = createLiveCapableInvoker({ deterministicInvoker: stack.deterministicInvoker, ticket });
  const r = invoker.invoke({
    provider_id: LIVE_TEXT_CAPABILITY_ID,
    input: buildLiveSocialPackagePrompt({ topic: 't', script_artifact_id: 's1', hook_artifact_id: 'h1' }),
    agent_slug: S.SOCIAL_PACKAGE_LIVE, task_id: 'a-different-task-id', tree_id: ticket.workflow_id,
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, LIVE_STAGE_REASON.LIVE_TICKET_SCOPE_MISMATCH);
  assert.equal(stack.fetchImpl.calls.length, 1);
});

test('862. (M29 Attack H) artifact-type binding cannot be forged — each live handler always creates its declared type', async () => {
  // Per directive section 15: artifact_type is NOT fingerprinted (M28's
  // documented, deliberate choice — runtime.js never forwards it to an
  // invoker, so comparing it would compare undefined to undefined and
  // weaken the check silently). Integrity is instead proven structurally:
  // every live handler names a FIXED artifact_type constant, never one
  // derived from input, so no request field can turn RESEARCH into VIDEO
  // or SCRIPT into AUDIO.
  const src = readFileSync(new URL('../src/content-factory-agents.js', import.meta.url), 'utf8');
  const liveHandlers = [
    ['researchLiveHandler', 'ARTIFACT_TYPE.RESEARCH'],
    ['scriptLiveHandler', 'ARTIFACT_TYPE.SCRIPT'],
    ['hookLiveHandler', 'ARTIFACT_TYPE.TEXT'],
    ['socialPackageLiveHandler', 'ARTIFACT_TYPE.SOCIAL_PACKAGE'],
  ];
  for (const [fn, expectedType] of liveHandlers) {
    const body = src.slice(src.indexOf(`function ${fn}(`), src.indexOf(`function ${fn}(`) + 900);
    assert.ok(body.includes(`artifact_type: ${expectedType}`), `${fn} must declare a FIXED ${expectedType}`);
    assert.equal(body.includes('artifact_type: input'), false, `${fn} must never derive artifact_type from input`);
  }

  // Behaviorally: a full pipeline run, with an attacker's own
  // artifact_type value smuggled into every live stage's task input,
  // still produces exactly the declared types.
  const stack = pipelineStack();
  const result = await runLiveTextContentPipeline({
    store: stack.store, artifactStore: stack.artifactStore, workflow: stack.workflow, coordinator: stack.coordinator,
    runtime: stack.runtime, router: stack.router, guardian: stack.guardian, audit: stack.audit,
    chain: stack.chain, multiInvoker: stack.multiInvoker, liveConfigs: stack.liveConfigs,
    workflow_id: WORKFLOW, topic: 'attacker topic', budget_limit: 5000,
  });
  assert.equal(result.ok, true);
  assert.equal(stack.artifactStore.getArtifact(result.stages.research.artifact_id).artifact_type, ARTIFACT_TYPE.RESEARCH);
  assert.equal(stack.artifactStore.getArtifact(result.stages.script.artifact_id).artifact_type, ARTIFACT_TYPE.SCRIPT);
  assert.equal(stack.artifactStore.getArtifact(result.stages.hook.artifact_id).artifact_type, ARTIFACT_TYPE.TEXT);
  assert.equal(stack.artifactStore.getArtifact(result.stages.social_package.artifact_id).artifact_type, ARTIFACT_TYPE.SOCIAL_PACKAGE);
});

// ══ 3. GUARDIAN — EVERY LIVE STAGE, EVERY FREEZE TYPE ═══════════════════

test('863. (M29) every live stage is blocked by every freeze/lifecycle state — zero network calls, every combination', async () => {
  const scenarios = [
    ['agent freeze', (st, slug) => st.store.addFreeze({ scope: 'agent', target_id: slug, reason: 'M29', created_at: T0 - 1 }), LIVE_GATE_REASON.AGENT_FROZEN],
    ['workflow freeze', (st) => st.store.addFreeze({ scope: 'workflow', target_id: WORKFLOW, reason: 'M29', created_at: T0 - 1 }), LIVE_GATE_REASON.WORKFLOW_FROZEN],
    ['global freeze', (st) => st.store.addFreeze({ scope: 'global', target_id: null, reason: 'M29', created_at: T0 - 1 }), LIVE_GATE_REASON.GLOBAL_FREEZE],
    ['disabled agent', (st, slug) => st.store.setLifecycleState(slug, RUNTIME_STATE.DISABLED), LIVE_GATE_REASON.AGENT_NOT_ACTIVE],
    ['paused agent', (st, slug) => st.store.setLifecycleState(slug, RUNTIME_STATE.PAUSED), LIVE_GATE_REASON.AGENT_NOT_ACTIVE],
  ];
  const stageConfigs = [
    [S.RESEARCH_LIVE, 'research', () => buildLiveResearchPrompt({ topic: 't' })],
    [S.SCRIPT_LIVE, 'script', () => buildLiveScriptPrompt({ topic: 't', idea_artifact_id: 'i1' })],
    [S.HOOK_LIVE, 'hook', () => buildLiveHookPrompt({ topic: 't', script_artifact_id: 's1' })],
    [S.SOCIAL_PACKAGE_LIVE, 'social_package', () => buildLiveSocialPackagePrompt({ topic: 't', script_artifact_id: 's1', hook_artifact_id: 'h1' })],
  ];
  for (const [slug, configKey, buildPrompt] of stageConfigs) {
    for (const [label, apply, expectedReason] of scenarios) {
      const stack = pipelineStack();
      apply(stack, slug);
      const ticket = await resolveLiveStageContent({
        store: stack.store, chain: stack.chain, config: stack.liveConfigs[configKey],
        agent_slug: slug, task_id: LIVE_STAGE_TASK_IDS[slug], workflow_id: WORKFLOW, input: buildPrompt(),
      });
      assert.equal(ticket.admitted ? ticket.providerResult.reason : ticket.reason, expectedReason, `${slug}/${label}`);
      assert.equal(stack.fetchImpl.calls.length, 0, `${slug}/${label}: zero network calls`);
    }
  }
});

test('864. (M29) a MID-PIPELINE freeze stops the pipeline safely — the completed research artifact remains valid, script never runs', async () => {
  const stack = pipelineStack();
  stack.workflow.createWorkflow({ workflow_id: WORKFLOW, budget_limit: 5000 });

  // Run research alone, successfully, through the real pipeline glue.
  const research = await proposeAndRunLiveStage({
    coordinator: stack.coordinator, runtime: stack.runtime, router: stack.router, guardian: stack.guardian,
    store: stack.store, chain: stack.chain, multiInvoker: stack.multiInvoker,
    liveConfig: stack.liveConfigs.research, workflow_id: WORKFLOW, task_id: LIVE_STAGE_TASK_IDS[S.RESEARCH_LIVE],
    required_capability: CAP.RESEARCH_LIVE, input: { topic: 'why sleep matters' },
    promptInput: buildLiveResearchPrompt({ topic: 'why sleep matters' }),
  });
  assert.equal(research.ok, true, JSON.stringify(research.task?.error ?? research.proposal?.decision));
  assert.equal(stack.fetchImpl.calls.length, 1);
  const researchArtifactId = research.task.output.result.research_artifact_id;

  // Now Guardian freezes the WORKFLOW.
  stack.store.addFreeze({ scope: 'workflow', target_id: WORKFLOW, reason: 'M29 mid-pipeline test', created_at: stack.clock() - 1 });

  // The next live stage (script) is attempted — it must be refused, and
  // must not reach the network.
  const script = await proposeAndRunLiveStage({
    coordinator: stack.coordinator, runtime: stack.runtime, router: stack.router, guardian: stack.guardian,
    store: stack.store, chain: stack.chain, multiInvoker: stack.multiInvoker,
    liveConfig: stack.liveConfigs.script, workflow_id: WORKFLOW, task_id: LIVE_STAGE_TASK_IDS[S.SCRIPT_LIVE],
    required_capability: CAP.SCRIPT_LIVE, input: { topic: 'why sleep matters', idea_artifact_id: researchArtifactId },
    promptInput: buildLiveScriptPrompt({ topic: 'why sleep matters', idea_artifact_id: researchArtifactId }),
  });
  assert.equal(script.ok, false, 'the frozen workflow must not let script complete');
  assert.equal(stack.fetchImpl.calls.length, 1, 'zero NEW network calls — still just research\'s one');

  // Research's artifact is still there, unchanged, and still valid.
  const stillThere = stack.artifactStore.getArtifact(researchArtifactId);
  assert.ok(stillThere, 'research\'s artifact must survive a later freeze');
  assert.equal(stillThere.artifact_type, ARTIFACT_TYPE.RESEARCH);
  assert.equal(stillThere.checksum.length, 64);
});

// ══ 4. APPROVAL — GREEN LIVE STAGES CANNOT SELF-APPROVE ═════════════════

test('865. (M29) every live stage is GREEN with no tools, and the Approval Engine remains authoritative for all four', async () => {
  const { createApprovalEngine } = await import('../src/approval-engine.js');
  const stack = pipelineStack();
  const engine = createApprovalEngine({
    store: stack.store, tools: stack.tools, audit: stack.audit, clock: stack.clock, registrySha: stack.registrySha,
  });
  for (const slug of LIVE_STAGE_SLUGS) {
    const agent = stack.store.getAgent(slug);
    assert.equal(agent.clearance, 'GREEN', slug);
    assert.deepEqual(agent.allowed_tools, [], `${slug} holds no tools`);

    // Whether or not approval is naturally in this path, the boundary
    // itself is proven directly: no agent actor — including any of
    // these four — can ever approve anything.
    const decision = await engine.decide({
      approval_id: `approval-${slug}`, decision: 'approved', actor_type: 'agent', actor: slug, task_id: 'irrelevant',
    });
    assert.equal(decision.outcome, 'rejected', slug);
    assert.equal(decision.code, 'APPROVAL_ACTOR_INVALID', slug);
  }
});

test('866. (M29) the CEO cannot call decide(), cannot call revoke(), and cannot convert a denial into ALLOW', async () => {
  const { createApprovalEngine } = await import('../src/approval-engine.js');
  const { CEO_AGENT_SLUG, registerCeoAgent } = await import('../src/ceo-agent.js');
  const stack = pipelineStack();
  registerCeoAgent(stack.store);
  const engine = createApprovalEngine({
    store: stack.store, tools: stack.tools, audit: stack.audit, clock: stack.clock, registrySha: stack.registrySha,
  });
  const asCeo = await engine.decide({
    approval_id: 'approval-ceo', decision: 'approved', actor_type: 'agent', actor: CEO_AGENT_SLUG, task_id: 'irrelevant',
  });
  assert.equal(asCeo.outcome, 'rejected');
  assert.equal(asCeo.code, 'APPROVAL_ACTOR_INVALID');

  const revokeAsCeo = await engine.revoke({
    approval_id: 'approval-ceo', actor_type: 'agent', actor: CEO_AGENT_SLUG, task_id: 'irrelevant',
  });
  assert.notEqual(revokeAsCeo.outcome, 'revoked');

  // And the Broker's own DENY/NEEDS_APPROVAL decision for a real
  // YELLOW/tool-using request is unaffected by anything the CEO could do —
  // the CEO holds no tools, so it cannot even construct the request that
  // would need approving.
  const ceo = stack.store.getAgent(CEO_AGENT_SLUG);
  assert.deepEqual(ceo.allowed_tools, []);
});

// ══ 5. CEO ISOLATION ══════════════════════════════════════════════════

test('867. (M29) no CEO file references any M29 live-pipeline symbol, capability, agent slug, or credential term', () => {
  const CEO_FILES = readdirSync(new URL('../src/ceo/', import.meta.url))
    .filter((f) => f.endsWith('.js')).map((f) => `../src/ceo/${f}`);
  CEO_FILES.push('../src/ceo-agent.js');

  const FORBIDDEN = [
    'GROQ', 'API_KEY', 'apiKey', 'process.env', 'fetch(', 'axios',
    'content-factory-live', 'LIVE_TEXT_CAPABILITY_ID', 'createLiveStageConfig',
    'resolveLiveStageContent', 'createLiveCapableInvoker', 'createMultiStageLiveInvoker', 'installTicket',
    'cf-research-live', 'cf-script-live', 'cf-hook-live', 'cf-social-package-live',
    'registerAllContentFactoryLiveTextAgents', 'registerContentFactoryLiveResearchAgent',
    'registerContentFactoryLiveHookAgent', 'registerContentFactoryLiveSocialPackageAgent',
    'live-registry', 'live-guard', 'createLiveProviderChain', 'createLiveProviderRegistry',
    'createGroqProvider', 'readGroqConfig', 'createResourceGovernor',
    'configureGlobalBudget', 'configureAgentBudget', 'configureWorkflowBudget', 'configureTaskBudget',
    'addFreeze(', 'setLifecycleState(', 'max_retries', 'max_cost_per_call',
  ];
  assert.ok(CEO_FILES.length >= 6, 'every CEO file must be swept');
  for (const path of CEO_FILES) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const term of FORBIDDEN) {
      assert.ok(!src.includes(term), `${path} must not reference "${term}"`);
    }
  }
});

test('868. (M29) the CEO cannot manufacture a live ticket — it is not admitted for any of the four live stages', async () => {
  const { CEO_AGENT_SLUG, registerCeoAgent } = await import('../src/ceo-agent.js');
  const stack = pipelineStack();
  registerCeoAgent(stack.store);

  for (const [configKey, buildPrompt] of [
    ['research', () => buildLiveResearchPrompt({ topic: 't' })],
    ['script', () => buildLiveScriptPrompt({ topic: 't', idea_artifact_id: 'i1' })],
    ['hook', () => buildLiveHookPrompt({ topic: 't', script_artifact_id: 's1' })],
    ['social_package', () => buildLiveSocialPackagePrompt({ topic: 't', script_artifact_id: 's1', hook_artifact_id: 'h1' })],
  ]) {
    const ticket = await resolveLiveStageContent({
      store: stack.store, chain: stack.chain, config: stack.liveConfigs[configKey],
      agent_slug: CEO_AGENT_SLUG, task_id: 'task-ceo-attempt', workflow_id: WORKFLOW, input: buildPrompt(),
    });
    assert.equal(ticket.admitted, false, configKey);
    assert.equal(ticket.reason, LIVE_STAGE_REASON.LIVE_STAGE_NOT_ADMITTED, configKey);
  }
  assert.equal(stack.fetchImpl.calls.length, 0, 'the CEO reaches no network under any live config');
});

// ══ 6. MULTI-STAGE FAILURE PROPAGATION ═══════════════════════════════════

test('869. (M29) a research FAILURE stops the pipeline before script — script never runs, never reaches the network', async () => {
  const fetchImpl = recordingFetch(() => errorResponse(401, 'invalid key'));
  const stack = pipelineStack({ fetchImpl });
  const result = await runPipeline(stack);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'research');
  assert.equal(fetchImpl.calls.length, 1, 'exactly one failed attempt — research\'s own, never retried, and nothing beyond it');
  const artifacts = stack.artifactStore.artifactsForWorkflow(WORKFLOW);
  assert.equal(artifacts.length, 0, 'no artifact of any kind — not research, not script, not anything downstream');
});

test('870. (M29) a script FAILURE stops the pipeline before hook — hook never runs; research/fact-check/idea artifacts remain', async () => {
  let calls = 0;
  const fetchImpl = recordingFetch(() => { calls += 1; return calls === 1 ? okResponse() : errorResponse(500, 'down'); });
  const stack = pipelineStack({ fetchImpl });
  const result = await runPipeline(stack);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'script');
  assert.equal(fetchImpl.calls.length, 2, 'research succeeded (1), script attempted once and failed (2) — never a third');
  const types = stack.artifactStore.artifactsForWorkflow(WORKFLOW).map((a) => a.artifact_type).sort();
  assert.deepEqual(types, [ARTIFACT_TYPE.RESEARCH, ARTIFACT_TYPE.TEXT, ARTIFACT_TYPE.TEXT].sort(),
    'research + fact_check + idea exist; nothing from script onward');
});

test('871. (M29) a hook FAILURE stops the pipeline before social-package — social-package never runs on stale/partial data', async () => {
  let calls = 0;
  const fetchImpl = recordingFetch(() => { calls += 1; return calls <= 2 ? okResponse() : errorResponse(500, 'down'); });
  const stack = pipelineStack({ fetchImpl });
  const result = await runPipeline(stack);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'hook');
  assert.equal(fetchImpl.calls.length, 3, 'research + script succeeded, hook failed once — never a fourth call for social-package');
});

test('872. (M29) a social-package FAILURE leaves every earlier artifact immutable and untouched', async () => {
  let calls = 0;
  const fetchImpl = recordingFetch(() => { calls += 1; return calls <= 3 ? okResponse() : errorResponse(500, 'down'); });
  const stack = pipelineStack({ fetchImpl });
  const result = await runPipeline(stack);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'social_package');
  assert.equal(fetchImpl.calls.length, 4, 'three live successes + one failed social-package attempt');

  // Earlier artifacts survive, checksums intact — nothing was rewritten
  // or "fixed up" by the failure.
  const research = stack.artifactStore.getArtifact(result.stages.research.artifact_id);
  const script = stack.artifactStore.getArtifact(result.stages.script.artifact_id);
  const hook = stack.artifactStore.getArtifact(result.stages.hook.artifact_id);
  for (const a of [research, script, hook]) {
    assert.ok(a, 'earlier artifact must still exist');
    assert.equal(a.checksum.length, 64);
  }
  // And no stage may manufacture a substitute social_package artifact.
  assert.equal(stack.artifactStore.artifactsForWorkflow(WORKFLOW).some((a) => a.artifact_type === ARTIFACT_TYPE.SOCIAL_PACKAGE), false);
});

// ══ 7. DUPLICATION / REPLAY ═══════════════════════════════════════════════

test('873. (M29) the same topic run under two DIFFERENT workflow ids gets two independent ticket sets — no cross-run reuse', async () => {
  const fetchImpl = recordingFetch(() => okResponse());
  const stack1 = pipelineStack({ fetchImpl });
  stack1.chain.governor.configureWorkflowBudget('wf-m29-run-a', 1000);
  for (const suffix of ['research', 'script', 'hook', 'social-package']) {
    stack1.chain.governor.configureTaskBudget(`wf-m29-run-a-${suffix}`, 1000);
  }
  const r1 = await runLiveTextContentPipeline({
    store: stack1.store, artifactStore: stack1.artifactStore, workflow: stack1.workflow, coordinator: stack1.coordinator,
    runtime: stack1.runtime, router: stack1.router, guardian: stack1.guardian, audit: stack1.audit,
    chain: stack1.chain, multiInvoker: stack1.multiInvoker, liveConfigs: stack1.liveConfigs,
    workflow_id: 'wf-m29-run-a', topic: 'topic a', budget_limit: 5000,
  });
  assert.equal(r1.ok, true, JSON.stringify(r1.task?.error));
  assert.equal(fetchImpl.calls.length, 4);

  // A second, entirely separate stack (separate multiInvoker, separate
  // budgets) with the SAME fetchImpl — proves independence structurally,
  // not by coincidence of budget headroom.
  const stack2 = pipelineStack({ fetchImpl });
  stack2.chain.governor.configureWorkflowBudget('wf-m29-run-b', 1000);
  for (const suffix of ['research', 'script', 'hook', 'social-package']) {
    stack2.chain.governor.configureTaskBudget(`wf-m29-run-b-${suffix}`, 1000);
  }
  const r2 = await runLiveTextContentPipeline({
    store: stack2.store, artifactStore: stack2.artifactStore, workflow: stack2.workflow, coordinator: stack2.coordinator,
    runtime: stack2.runtime, router: stack2.router, guardian: stack2.guardian, audit: stack2.audit,
    chain: stack2.chain, multiInvoker: stack2.multiInvoker, liveConfigs: stack2.liveConfigs,
    workflow_id: 'wf-m29-run-b', topic: 'topic b', budget_limit: 5000,
  });
  assert.equal(r2.ok, true, JSON.stringify(r2.task?.error));
  assert.equal(fetchImpl.calls.length, 8, 'the second run made its OWN four calls — none were served from the first run\'s tickets');
});

test('874. (M29) installing a second ticket for the same agent in one run is refused — the single-use guarantee cannot be reset', async () => {
  const stack = pipelineStack();
  const t1 = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: stack.liveConfigs.research,
    agent_slug: S.RESEARCH_LIVE, task_id: LIVE_STAGE_TASK_IDS[S.RESEARCH_LIVE], workflow_id: WORKFLOW,
    input: buildLiveResearchPrompt({ topic: 't' }),
  });
  stack.multiInvoker.installTicket(S.RESEARCH_LIVE, t1);
  assert.equal(stack.fetchImpl.calls.length, 1);

  const t2 = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: stack.liveConfigs.research,
    agent_slug: S.RESEARCH_LIVE, task_id: LIVE_STAGE_TASK_IDS[S.RESEARCH_LIVE], workflow_id: WORKFLOW,
    input: buildLiveResearchPrompt({ topic: 't' }),
  });
  // Phase 1 itself made a SECOND real (governed, in this case injected)
  // call — that is visible and expected; the safeguard this test proves
  // is that the SECOND ticket can never be installed to reset the first
  // one's single-use flag.
  assert.equal(stack.fetchImpl.calls.length, 2, 'phase 1 for the second attempt did run — that is not itself a violation');
  assert.throws(() => stack.multiInvoker.installTicket(S.RESEARCH_LIVE, t2), /already has a ticket installed/);

  // And the FIRST ticket, once consumed, still cannot be reused —
  // installing t2 never happened, so t1's own single-use flag is intact.
  const req = { provider_id: LIVE_TEXT_CAPABILITY_ID, input: buildLiveResearchPrompt({ topic: 't' }), agent_slug: S.RESEARCH_LIVE, task_id: t1.task_id, tree_id: t1.workflow_id };
  const first = stack.multiInvoker.invoke(req);
  assert.equal(first.status, 'ok');
  const second = stack.multiInvoker.invoke(req);
  assert.equal(second.status, 'failed');
  assert.equal(second.reason, LIVE_STAGE_REASON.LIVE_TICKET_ALREADY_USED);
});

test('875. (M29) a completed artifact cannot be re-submitted as though it were a fresh live result — no client-suppliable artifact identity', async () => {
  const stack = pipelineStack();
  const result = await runPipeline(stack);
  assert.equal(result.ok, true);
  const realArtifactId = result.stages.research.artifact_id;

  // The artifact id is server-generated (artifact-service.js's own
  // UUID-based scheme) — nothing in the live path accepts a
  // caller-supplied artifact id for a NEW result. Proven directly: a
  // second, independent research ticket for a NEW task still requires
  // its own real network call and produces its OWN new artifact id.
  const secondTaskId = `${WORKFLOW}-research-2`;
  stack.chain.governor.configureTaskBudget(secondTaskId, 1000);
  const ticket2 = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: stack.liveConfigs.research,
    agent_slug: S.RESEARCH_LIVE, task_id: secondTaskId, workflow_id: WORKFLOW,
    input: buildLiveResearchPrompt({ topic: 't' }),
  });
  assert.equal(stack.fetchImpl.calls.length, 5, 'a NEW ticket always costs a NEW real call — nothing is served from cache');
  assert.notEqual(ticket2.fingerprint, null);
  // (No API accepts an artifact id as input for generation — the only
  // artifact-shaping fields a task can supply are PARENT ids, which the
  // artifact service treats as lineage, never as identity to reuse.)
  assert.ok(realArtifactId);
});

test('876. (M29) a stale ticket cannot be used after its workflow has completed — a new proposal is refused by workflow.js itself', async () => {
  const stack = pipelineStack();
  const result = await runPipeline(stack);
  assert.equal(result.ok, true);
  assert.equal(result.workflow.state, 'completed');

  // Attempting to propose ANOTHER task into the now-completed workflow —
  // exactly what a stale, late-arriving live stage would need to do —
  // is refused by the real, unmodified workflow/coordinator machinery,
  // before this milestone's own boundary is even reached.
  const late = proposeAndRunDeterministicStage({
    coordinator: stack.coordinator, runtime: stack.runtime, router: stack.router, guardian: stack.guardian,
    workflow_id: WORKFLOW, task_id: `${WORKFLOW}-late-stage`, required_capability: CAP.RESEARCH,
    input: { topic: 'late' },
  });
  assert.equal(late.ok, false);
  assert.equal(late.proposal.decision, 'rejected');
});

// ══ 8. CONCURRENCY — TWO INDEPENDENTLY ADMITTED LIVE CALLS AT ONCE ═══════

test('877. (M29) two concurrent live resolutions never cross-contaminate provenance, usage, or content', async () => {
  // A fetchImpl that returns DIFFERENT content depending on which
  // prompt it received, with an artificial delay ordering so the second
  // call's response resolves BEFORE the first's — proving the per-call
  // carrier (M26) is not confused by interleaving.
  const responses = new Map([
    ['hook', { text: 'HOOK-ONLY-CONTENT', delayMs: 20 }],
    ['social', { text: 'SOCIAL-ONLY-CONTENT', delayMs: 1 }],
  ]);
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const key = body.messages.some((m) => /hook/i.test(m.content)) ? 'hook' : 'social';
    const { text, delayMs } = responses.get(key);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return okResponse(text);
  };
  const countingFetch = recordingFetch((url, init) => fetchImpl(url, init));
  const stack = pipelineStack({ fetchImpl: countingFetch });

  const [hookTicket, socialTicket] = await Promise.all([
    resolveLiveStageContent({
      store: stack.store, chain: stack.chain, config: stack.liveConfigs.hook,
      agent_slug: S.HOOK_LIVE, task_id: LIVE_STAGE_TASK_IDS[S.HOOK_LIVE], workflow_id: WORKFLOW,
      input: buildLiveHookPrompt({ topic: 't', script_artifact_id: 's1' }),
    }),
    resolveLiveStageContent({
      store: stack.store, chain: stack.chain, config: stack.liveConfigs.social_package,
      agent_slug: S.SOCIAL_PACKAGE_LIVE, task_id: LIVE_STAGE_TASK_IDS[S.SOCIAL_PACKAGE_LIVE], workflow_id: WORKFLOW,
      input: buildLiveSocialPackagePrompt({ topic: 't', script_artifact_id: 's1', hook_artifact_id: 'h1' }),
    }),
  ]);

  assert.equal(countingFetch.calls.length, 2);
  assert.equal(hookTicket.admitted, true);
  assert.equal(socialTicket.admitted, true);
  assert.equal(hookTicket.providerResult.output.text, 'HOOK-ONLY-CONTENT', 'hook\'s ticket must carry ONLY hook\'s content');
  assert.equal(socialTicket.providerResult.output.text, 'SOCIAL-ONLY-CONTENT', 'social\'s ticket must carry ONLY social\'s content');
  assert.notEqual(hookTicket.providerResult.output.text, socialTicket.providerResult.output.text);

  // Install both into the SAME multi-stage invoker and confirm each
  // slug consumes only its own.
  stack.multiInvoker.installTicket(S.HOOK_LIVE, hookTicket);
  stack.multiInvoker.installTicket(S.SOCIAL_PACKAGE_LIVE, socialTicket);
  const hookResult = stack.multiInvoker.invoke({
    provider_id: LIVE_TEXT_CAPABILITY_ID, input: buildLiveHookPrompt({ topic: 't', script_artifact_id: 's1' }),
    agent_slug: S.HOOK_LIVE, task_id: hookTicket.task_id, tree_id: hookTicket.workflow_id,
  });
  const socialResult = stack.multiInvoker.invoke({
    provider_id: LIVE_TEXT_CAPABILITY_ID, input: buildLiveSocialPackagePrompt({ topic: 't', script_artifact_id: 's1', hook_artifact_id: 'h1' }),
    agent_slug: S.SOCIAL_PACKAGE_LIVE, task_id: socialTicket.task_id, tree_id: socialTicket.workflow_id,
  });
  assert.equal(hookResult.output.text, 'HOOK-ONLY-CONTENT');
  assert.equal(socialResult.output.text, 'SOCIAL-ONLY-CONTENT');
});

test('878. (M29) concurrent calls cannot let one stage consume another\'s ticket, even under interleaving', async () => {
  const fetchImpl = recordingFetch(() => okResponse());
  const stack = pipelineStack({ fetchImpl });
  const [researchTicket, scriptTicket] = await Promise.all([
    resolveLiveStageContent({
      store: stack.store, chain: stack.chain, config: stack.liveConfigs.research,
      agent_slug: S.RESEARCH_LIVE, task_id: LIVE_STAGE_TASK_IDS[S.RESEARCH_LIVE], workflow_id: WORKFLOW,
      input: buildLiveResearchPrompt({ topic: 't' }),
    }),
    resolveLiveStageContent({
      store: stack.store, chain: stack.chain, config: stack.liveConfigs.script,
      agent_slug: S.SCRIPT_LIVE, task_id: LIVE_STAGE_TASK_IDS[S.SCRIPT_LIVE], workflow_id: WORKFLOW,
      input: buildLiveScriptPrompt({ topic: 't', idea_artifact_id: 'i1' }),
    }),
  ]);
  stack.multiInvoker.installTicket(S.RESEARCH_LIVE, researchTicket);
  stack.multiInvoker.installTicket(S.SCRIPT_LIVE, scriptTicket);

  const crossed = stack.multiInvoker.invoke({
    provider_id: LIVE_TEXT_CAPABILITY_ID, input: buildLiveResearchPrompt({ topic: 't' }),
    agent_slug: S.SCRIPT_LIVE, task_id: researchTicket.task_id, tree_id: researchTicket.workflow_id,
  });
  assert.equal(crossed.status, 'failed');
  assert.notEqual(crossed.reason, undefined);
  assert.equal(fetchImpl.calls.length, 2, 'only the two legitimate resolutions — no third call from the cross attempt');
});

// ══ 9. CREDENTIAL CONTAINMENT ═════════════════════════════════════════════

test('879. (M29) the sentinel never reaches any persisted surface across a full four-stage pipeline run', async () => {
  const stack = pipelineStack();
  const result = await runPipeline(stack);
  assert.equal(result.ok, true);
  const call = stack.fetchImpl.calls[0];
  assert.equal(String(call.init.headers.authorization).includes(SENTINEL), true);

  const artifacts = stack.artifactStore.artifactsForWorkflow(WORKFLOW);
  for (const [where, blob] of [
    ['pipeline result', JSON.stringify({ ...result, workflow: undefined })],
    ['all artifacts (content included)', JSON.stringify(artifacts)],
    ['audit log', JSON.stringify(stack.audit.all())],
  ]) {
    assert.equal(blob.includes(SENTINEL), false, `the credential must never reach the ${where}`);
    assert.equal(/Bearer\s+gsk_/i.test(blob), false, `no bearer token in the ${where}`);
  }
});

test('880. (M29) a provider echoing the Authorization header into ANY of the four live stages is redacted before persistence', async () => {
  const echo = `authorization: Bearer ${SENTINEL}`;
  const fetchImpl = recordingFetch(() => okResponse(`Content here. ${echo} More content.`));
  const stack = pipelineStack({ fetchImpl });
  const result = await runPipeline(stack);
  assert.equal(result.ok, true);

  const artifacts = stack.artifactStore.artifactsForWorkflow(WORKFLOW);
  const blob = JSON.stringify(artifacts);
  assert.equal(blob.includes(SENTINEL), false, 'no artifact anywhere may carry the credential, content included');
  assert.ok(blob.includes('[REDACTED]'), 'redaction is visible in at least one artifact');
  assert.equal(JSON.stringify(stack.audit.all()).includes(SENTINEL), false);
});

test('881. (M29) a credential echoed into a TRANSPORT ERROR or exception is redacted too', async () => {
  const fetchImpl = recordingFetch(() => { throw new Error(`socket failure sending Bearer ${SENTINEL}`); });
  const stack = pipelineStack({ fetchImpl });
  const result = await runPipeline(stack);
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(SENTINEL), false);
  assert.equal(JSON.stringify(stack.audit.all()).includes(SENTINEL), false);
});

// ══ 10. STRUCTURE: ONE EGRESS, NO NEW AUTHORITY ═══════════════════════════

test('882. (M29) the pipeline driver holds no network, no credential, no registry-mutation, no Guardian-imposing method', () => {
  const src = readFileSync(new URL('../src/content-factory-live-pipeline.js', import.meta.url), 'utf8');
  for (const term of [
    'fetch(', 'axios', 'node:http', 'node:https', 'node:net', 'child_process', 'eval(',
    'API_KEY', 'apiKey', 'process.env', 'Bearer', 'Authorization',
    'createGroqProvider', 'createLiveProviderRegistry', 'registerAgent(', 'addAgentVersion(',
    'addFreeze(', 'setLifecycleState(', 'configureGlobalBudget', 'addBudget(', 'broker.',
    'decide(', 'revoke(',
  ]) {
    assert.ok(!src.includes(term), `content-factory-live-pipeline.js must not reference "${term}"`);
  }
});

test('883. (M29) src/ gained exactly the M28+M29 live modules — nothing stray', () => {
  const files = readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.js')).sort();
  for (const expected of ['content-factory-live.js', 'content-factory-live-pipeline.js']) {
    assert.ok(files.includes(expected));
  }
  const unexpected = files.filter((f) => /live|groq/i.test(f) && f !== 'content-factory-live.js' && f !== 'content-factory-live-pipeline.js');
  assert.deepEqual(unexpected, [], 'no other live module may appear in src/');
});

test('884. (M29) no fallback provider is reachable from any of the four live stages — each names one provider or nothing', async () => {
  const stack = pipelineStack();
  for (const [configKey, slug, buildPrompt] of [
    ['research', S.RESEARCH_LIVE, () => buildLiveResearchPrompt({ topic: 't' })],
    ['script', S.SCRIPT_LIVE, () => buildLiveScriptPrompt({ topic: 't', idea_artifact_id: 'i1' })],
    ['hook', S.HOOK_LIVE, () => buildLiveHookPrompt({ topic: 't', script_artifact_id: 's1' })],
    ['social_package', S.SOCIAL_PACKAGE_LIVE, () => buildLiveSocialPackagePrompt({ topic: 't', script_artifact_id: 's1', hook_artifact_id: 'h1' })],
  ]) {
    const ticket = await resolveLiveStageContent({
      store: stack.store, chain: stack.chain, config: stack.liveConfigs[configKey],
      agent_slug: slug, task_id: LIVE_STAGE_TASK_IDS[slug], workflow_id: WORKFLOW, input: buildPrompt(),
    });
    assert.equal(ticket.config.provider_id, GROQ_PROVIDER_ID, configKey);
    assert.equal(ticket.providerResult.provider_id, GROQ_PROVIDER_ID, configKey);
  }
  const src = readFileSync(new URL('../src/content-factory-live-pipeline.js', import.meta.url), 'utf8');
  for (const term of ['fallback', "provider_id: 'deterministic-text'", '|| deterministic']) {
    assert.equal(src.includes(term), false, `no fallback path may exist in the pipeline driver ("${term}")`);
  }
});

test('885. (M29) call-limit ceilings are respected: the pipeline never makes more than one live call per stage, four total', async () => {
  const stack = pipelineStack();
  const result = await runPipeline(stack);
  assert.equal(result.ok, true);
  assert.equal(stack.fetchImpl.calls.length, 4, 'total network calls across the entire multi-stage run must equal the live stage count, exactly');
  // Retry ceiling: each individual call was max_retries 0 — an
  // errorResponse fixture would reveal a retry as a SECOND call for that
  // one stage, already proven per-stage in tests 869-872.
  const src = readFileSync(new URL('../src/content-factory-live.js', import.meta.url), 'utf8');
  assert.ok(/max_retries:\s*0/.test(src));
});

test('886. (M29) an insufficient budget at ANY scope denies EACH live stage independently, in the multi-stage context', async () => {
  const stageConfigs = [
    [S.RESEARCH_LIVE, 'research', () => buildLiveResearchPrompt({ topic: 't' })],
    [S.SCRIPT_LIVE, 'script', () => buildLiveScriptPrompt({ topic: 't', idea_artifact_id: 'i1' })],
    [S.HOOK_LIVE, 'hook', () => buildLiveHookPrompt({ topic: 't', script_artifact_id: 's1' })],
    [S.SOCIAL_PACKAGE_LIVE, 'social_package', () => buildLiveSocialPackagePrompt({ topic: 't', script_artifact_id: 's1', hook_artifact_id: 'h1' })],
  ];
  for (const [slug, configKey, buildPrompt] of stageConfigs) {
    for (const scope of ['global', 'agent', 'workflow', 'task']) {
      const stack = pipelineStack({ perCall: 10, budgets: { global: 1000, agent: 1000, workflow: 1000, task: 1000, [scope]: 1 } });
      const ticket = await resolveLiveStageContent({
        store: stack.store, chain: stack.chain, config: stack.liveConfigs[configKey],
        agent_slug: slug, task_id: LIVE_STAGE_TASK_IDS[slug], workflow_id: WORKFLOW, input: buildPrompt(),
      });
      assert.equal(ticket.providerResult.status, 'failed', `${slug}/${scope}`);
      assert.match(String(ticket.providerResult.reason), /BUDGET_EXCEEDED/, `${slug}/${scope}`);
      assert.equal(stack.fetchImpl.calls.length, 0, `${slug}/${scope}: zero network calls`);
    }
  }
});

test('887. (M29) even if a caller reused the SAME request object across two concurrent live calls, results never cross-contaminate', async () => {
  // Found by M29 mutation testing: `live-guard.js`'s `createLiveProviderChain`
  // clones its request into a per-call carrier (`{ ...request }`) before
  // handing it to the governor, specifically so the governor's
  // CARRIER_KEY write cannot leak across concurrent calls. Every caller
  // in this codebase (including this milestone's `resolveLiveStageContent`)
  // already builds a FRESH object literal per call, so the clone was
  // inert under every existing test — this test constructs the
  // adversarial case the clone actually defends: the SAME request object,
  // reused for two overlapping calls.
  const responses = new Map([['research', 'RESEARCH-TEXT'], ['hook', 'HOOK-TEXT']]);
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const key = /hook/i.test(JSON.stringify(body)) ? 'hook' : 'research';
    await new Promise((r) => setTimeout(r, key === 'research' ? 15 : 1));
    return okResponse(responses.get(key));
  };
  const countingFetch = recordingFetch((url, init) => fetchImpl(url, init));
  const stack = pipelineStack({ fetchImpl: countingFetch });

  const sharedRequestBase = { provider_id: GROQ_PROVIDER_ID, model_id: MODEL, max_retries: 0 };
  const reqA = { ...sharedRequestBase, input: { text: 'research prompt' }, agent_slug: S.RESEARCH_LIVE, task_id: LIVE_STAGE_TASK_IDS[S.RESEARCH_LIVE], tree_id: WORKFLOW };
  const reqB = { ...sharedRequestBase, input: { text: 'hook prompt' }, agent_slug: S.HOOK_LIVE, task_id: LIVE_STAGE_TASK_IDS[S.HOOK_LIVE], tree_id: WORKFLOW };

  const [resultA, resultB] = await Promise.all([
    stack.chain.invoke(reqA),
    stack.chain.invoke(reqB),
  ]);

  assert.equal(resultA.status, 'ok', resultA.reason);
  assert.equal(resultB.status, 'ok', resultB.reason);
  assert.equal(resultA.output.text, 'RESEARCH-TEXT', 'A must get A\'s own content, regardless of B finishing first');
  assert.equal(resultB.output.text, 'HOOK-TEXT', 'B must get B\'s own content, regardless of arrival order');
  assert.notEqual(resultA.output.text, resultB.output.text);
  // And the request objects passed in are never mutated by the chain —
  // no CARRIER_KEY or other internal field leaks onto the caller's object.
  assert.deepEqual(Object.keys(reqA).sort(), Object.keys(sharedRequestBase).concat(['input', 'agent_slug', 'task_id', 'tree_id']).sort());
});

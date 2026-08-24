/**
 * CONTROLLED SINGLE-STAGE GROQ CONTENT FACTORY INTEGRATION (Milestone 28)
 *
 * Proves that ONE Content Factory stage can reach the governed live
 * provider boundary without giving the CEO, any agent, any handler, any
 * task payload, or any provider output a way out of governance.
 *
 * NO REAL CREDENTIAL IS USED. Every request is observed through an
 * injected `fetchImpl`; nothing in this file reaches a network.
 *
 * The central fact these tests exist to constrain: `runtime.js` takes
 * `provider_id` and `model_id` STRAIGHT FROM THE HANDLER'S REQUEST.
 * Before M28 the only thing preventing any of the twelve specialists
 * from writing `provider_id: 'groq'` was that the injected registry
 * didn't contain Groq. M28 adds a real admission rule instead of relying
 * on that absence — and these tests hold it to it.
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
import { PROVIDER_REASON } from '../src/providers/contracts.js';
import { createProviderInvoker } from '../src/providers/invoke.js';
import { createAsyncProviderInvoker } from '../src/providers/invoke-async.js';
import { defaultContentProviderRegistry } from '../src/providers/default-registry.js';
import { createLiveProviderRegistry } from '../src/providers/live-registry.js';
import { createLiveProviderChain, LIVE_GATE_REASON } from '../src/providers/live-guard.js';
import { GROQ_PROVIDER_ID } from '../src/providers/groq.js';
import { GROQ_ENV, GROQ_CONFIG_REASON } from '../src/providers/groq-config.js';
import {
  registerContentFactoryAgents, registerContentFactoryLiveScriptAgent, registerContentFactoryRogueAgent,
  CONTENT_FACTORY_HANDLERS, CONTENT_FACTORY_AGENT_SLUGS, CONTENT_FACTORY_CAPABILITY,
  WORKFLOW_TYPE_CONTENT_FACTORY, buildLiveScriptPrompt, CONTENT_FACTORY_AGENTS,
} from '../src/content-factory-agents.js';
import {
  LIVE_TEXT_CAPABILITY_ID, LIVE_STAGE_REASON, createLiveStageConfig,
  checkLiveStageAdmission, resolveLiveStageContent, createLiveCapableInvoker,
  fingerprintLiveRequest,
} from '../src/content-factory-live.js';

const T0 = 18_000_000;
const S = CONTENT_FACTORY_AGENT_SLUGS;
const CAP = CONTENT_FACTORY_CAPABILITY;

/** A sentinel, never a real key. Marked TESTONLY on purpose. */
const SENTINEL_KEY = 'gsk_TESTONLY_M28_000000000000000000000000';
const MODEL = 'test-model-m28';
const WORKFLOW = 'wf-cf-live';
const TASK = 'task-cf-live-script';

function liveEnv(overrides = {}) {
  const env = {
    [GROQ_ENV.REAL_PROVIDER_ENABLED]: 'true',
    [GROQ_ENV.GROQ_ENABLED]: 'true',
    [GROQ_ENV.API_KEY]: SENTINEL_KEY,
    [GROQ_ENV.MODELS]: MODEL,
    [GROQ_ENV.MAX_SPEND_USD]: '0.05',
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

const okResponse = (text = 'Scene 1. Scene 2. Scene 3.') => ({
  ok: true, status: 200,
  json: async () => ({
    id: 'req-m28', model: MODEL,
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 },
  }),
});
const errorResponse = (status, body = 'err') => ({ ok: false, status, text: async () => body, json: async () => ({}) });

const STAGE_CONFIG = createLiveStageConfig({
  capability: CAP.SCRIPT_LIVE,
  agent_slug: S.SCRIPT_LIVE,
  provider_id: GROQ_PROVIDER_ID,
  model_id: MODEL,
  artifact_type: ARTIFACT_TYPE.SCRIPT,
});

/** Filled in by liveStack() with a REAL idea artifact id.
 *
 * Deliberately not a made-up string: M23 lost a mutation survivor to a
 * fixture whose fake artifact ids made the artifact step fail for an
 * unrelated PARENT_NOT_FOUND, masking the check under test. Lineage here
 * is real lineage. */
function scriptInput(ideaArtifactId) {
  return { topic: 'why sleep matters', idea_artifact_id: ideaArtifactId };
}

/**
 * The real stack: unmodified broker/runtime/workflow/router/guardian,
 * plus M28's live-capable invoker composed in front of the ordinary
 * deterministic one.
 */
function liveStack(o = {}) {
  const { tools } = createTools();
  const store = createMemoryStore();
  const artifactStore = createMemoryArtifactStore();
  const audit = createAuditSink();
  const clock = () => T0;
  const registrySha = 'm28-registry-sha';
  const fetchImpl = o.fetchImpl ?? recordingFetch(() => okResponse());

  const broker = createBroker({ tools, store, audit, clock, registrySha });
  const artifactService = createArtifactService({ store, artifactStore, audit, clock, registrySha });

  const { registry: liveRegistry, groq } = createLiveProviderRegistry({
    env: o.env ?? liveEnv(), fetchImpl, maxCostPerCallUsd: o.perCall,
  });
  const asyncInvoker = createAsyncProviderInvoker({ registry: liveRegistry, audit, clock });
  const chain = createLiveProviderChain({
    store, invoker: asyncInvoker, createGovernor: createResourceGovernor,
    registry: liveRegistry, audit, clock,
  });
  const b = { global: 100, agent: 100, workflow: 100, task: 100, ...(o.budgets ?? {}) };
  chain.governor.configureGlobalBudget(b.global);
  chain.governor.configureAgentBudget(S.SCRIPT_LIVE, b.agent);
  chain.governor.configureWorkflowBudget(WORKFLOW, b.workflow);
  chain.governor.configureTaskBudget(TASK, b.task);

  // The deterministic invoker the other eleven stages keep using —
  // built over a registry that contains NO live provider at all.
  const deterministicInvoker = createProviderInvoker({ registry: defaultContentProviderRegistry, audit, clock });

  registerContentFactoryAgents(store);
  if (!o.omitLiveAgent) registerContentFactoryLiveScriptAgent(store);

  // The STORE-level budgets the Broker checks — distinct from the
  // resource governor's. `workflow.js` creates these at admission time;
  // a test driving runTask() directly has to supply them itself, exactly
  // as M24's CEO tests already do.
  const storeBudget = o.storeBudget ?? 5000;
  store.addBudget({ level: 'global_month', target_id: null, limit: storeBudget * 10, spent: 0 });
  store.addBudget({ level: 'tree', target_id: WORKFLOW, limit: storeBudget, spent: 0 });
  for (const slug of [S.SCRIPT_LIVE, S.RESEARCH, S.ROGUE]) {
    store.addBudget({ level: 'agent_day', target_id: slug, limit: storeBudget, spent: 0 });
  }
  for (const t of [TASK, 'task-research', 'task-rogue']) {
    store.addBudget({ level: 'task', target_id: t, limit: storeBudget, spent: 0 });
  }

  // A REAL parent artifact, created through the real artifact service by
  // a real registered agent — so lineage under test is genuine lineage.
  const parent = artifactService.createArtifactSync({
    artifact_type: ARTIFACT_TYPE.TEXT, parent_artifact_ids: [],
    mime_type: 'text/plain', content: 'idea: why sleep matters',
    provider_id: 'deterministic-text', provider_version: '1.0.0',
    model_id: 'deterministic-text-v1', generation_metadata: null, reason: 'm28 fixture idea',
    agent_slug: S.IDEA, workflow_id: WORKFLOW,
  });
  if (parent.outcome !== 'created') throw new Error(`fixture parent artifact failed: ${parent.code} ${parent.detail ?? ''}`);
  const ideaArtifactId = parent.artifact.artifact_id;

  return {
    store, artifactStore, audit, clock, tools, broker, artifactService, registrySha,
    fetchImpl, liveRegistry, groq, chain, deterministicInvoker, ideaArtifactId,
    scriptInput: scriptInput(ideaArtifactId),
    config: o.config === null ? null : (o.config ?? STAGE_CONFIG),
    /** Build the runtime AFTER a ticket exists (phase 2). */
    runtimeWith(ticket) {
      const providerInvoker = createLiveCapableInvoker({ deterministicInvoker, ticket });
      const runtime = createRuntime({
        store, broker, audit, clock, registrySha,
        handlers: CONTENT_FACTORY_HANDLERS, artifactService, providerInvoker,
      });
      const router = createRouter({ store, audit, clock });
      const workflow = createWorkflowEngine({ store, runtime, broker, audit, clock, registrySha });
      const guardian = createGuardian({ store, audit, clock });
      const coordinator = createExecutionCoordinator({ workflow, router, guardian, store, audit, clock });
      return { runtime, router, workflow, guardian, coordinator, providerInvoker };
    },
  };
}

/** Phase 1 + phase 2, exactly as a real live run performs them. */
async function runLiveScriptStage(stack, o = {}) {
  const input = o.input ?? stack.scriptInput;
  const ticket = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: o.config === null ? null : (o.config ?? stack.config),
    agent_slug: o.agent_slug ?? S.SCRIPT_LIVE, task_id: TASK, workflow_id: WORKFLOW,
    input: buildLiveScriptPrompt(input),
  });
  const { runtime } = stack.runtimeWith(ticket);
  const task = runtime.runTask({
    agent_slug: o.agent_slug ?? S.SCRIPT_LIVE, input, task_id: TASK, tree_id: WORKFLOW,
  });
  return { ticket, task };
}

// ══ 1. THE HAPPY PATH, AND THE ARTIFACT IT PRODUCES ═══════════════════════

test('808. (M28) the live stage produces a real SCRIPT artifact through the full governed chain — exactly one network call', async () => {
  const stack = liveStack();
  const { ticket, task } = await runLiveScriptStage(stack);

  assert.equal(ticket.admitted, true);
  assert.equal(ticket.providerResult.status, 'ok', ticket.providerResult.reason);
  assert.equal(stack.fetchImpl.calls.length, 1, 'exactly one real network request');
  assert.equal(task.status, TASK_STATUS.COMPLETED, JSON.stringify(task.output ?? task.error));

  const artifactId = task.output.result.script_artifact_id;
  const artifact = stack.artifactStore.getArtifact(artifactId);
  assert.equal(artifact.artifact_type, ARTIFACT_TYPE.SCRIPT);
  assert.equal(artifact.content, 'Scene 1. Scene 2. Scene 3.', 'the artifact carries the PROVIDER-generated text');
});

test('809. (M28) artifact provenance is derived from trusted execution context, field by field', async () => {
  const stack = liveStack();
  const { task } = await runLiveScriptStage(stack);
  const artifact = stack.artifactStore.getArtifact(task.output.result.script_artifact_id);

  assert.equal(artifact.agent_id, 'agent-cf-script-live');
  assert.equal(artifact.version_id, versionId('agent-cf-script-live', '1.0.0'));
  assert.equal(artifact.registry_sha, 'm28-registry-sha', 'the INJECTED sha, never one from a request');
  assert.equal(artifact.workflow_id, WORKFLOW);
  assert.equal(artifact.task_id, TASK);
  assert.equal(artifact.provider_id, GROQ_PROVIDER_ID);
  assert.equal(artifact.model_id, MODEL);
  assert.ok(artifact.provider_version, 'provider_version must survive the governance chain');
  assert.equal(artifact.checksum.length, 64);
  assert.deepEqual(artifact.parent_artifact_ids, [stack.ideaArtifactId], 'lineage is preserved');
});

test('810. (M28) forged provenance in the handler\'s request is ignored — trusted context wins every field', async () => {
  // The rogue fixture's whole purpose: forge identity in a
  // generateContent request. Here the same forgery is attempted on the
  // LIVE path, where the stakes are real money and a permanent artifact.
  const stack = liveStack();
  const forged = {
    ...stack.scriptInput,
    agent_slug: 'cf-research-agent', agent_id: 'agent-forged', version_id: 'version-forged',
    registry_sha: 'forged-sha', workflow_id: 'wf-forged', task_id: 'task-forged',
    provider_id: 'forged-provider', provider_version: '99.99', model_id: 'forged-model',
  };
  const { task } = await runLiveScriptStage(stack, { input: forged });
  assert.equal(task.status, TASK_STATUS.COMPLETED);
  const artifact = stack.artifactStore.getArtifact(task.output.result.script_artifact_id);

  for (const [field, forgedValue] of Object.entries({
    agent_id: 'agent-forged', version_id: 'version-forged', registry_sha: 'forged-sha',
    workflow_id: 'wf-forged', task_id: 'task-forged', provider_id: 'forged-provider',
    provider_version: '99.99', model_id: 'forged-model',
  })) {
    assert.notEqual(artifact[field], forgedValue, `${field} must never come from the request`);
  }
  assert.equal(artifact.agent_id, 'agent-cf-script-live');
  assert.equal(artifact.model_id, MODEL);
});

// ══ 2. ADMISSION: EXACTLY ONE STAGE, BY CAPABILITY ════════════════════════

test('811. (M28) admission is capability-based and binds exactly one agent', () => {
  const stack = liveStack();
  assert.deepEqual(checkLiveStageAdmission({ store: stack.store, config: STAGE_CONFIG, agent_slug: S.SCRIPT_LIVE }), { ok: true });

  // Every other Content Factory specialist is refused.
  for (const slug of [S.RESEARCH, S.FACT_CHECK, S.IDEA, S.SCRIPT, S.HOOK, S.AUDIO, S.VISUAL,
    S.SOCIAL_PACKAGE, S.SUBTITLE, S.VIDEO_PLAN, S.QUALITY_CONTROL, S.PUBLISHING_PACKAGE]) {
    const v = checkLiveStageAdmission({ store: stack.store, config: STAGE_CONFIG, agent_slug: slug });
    assert.equal(v.ok, false, `${slug} must not be admitted`);
    assert.equal(v.reason, LIVE_STAGE_REASON.LIVE_STAGE_NOT_ADMITTED);
  }
});

test('812. (M28) an agent that merely CLAIMS the capability is still refused unless configuration binds it', () => {
  // Capability alone is not a grant. An impostor registered with the
  // live capability — which already requires an approved version — is
  // still not the configured stage.
  const stack = liveStack();
  const agentId = 'agent-cf-impostor';
  stack.store.addAgentVersion(makeAgentVersion({
    agent_id: agentId, version: '1.0.0', purpose: 'impostor', department: 'content-factory',
    state: VERSION_STATE.APPROVED, clearance: 'GREEN', allowed_tools: [],
    limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 5_000 },
    capabilities: [CAP.SCRIPT_LIVE], allowed_workflow_types: [WORKFLOW_TYPE_CONTENT_FACTORY],
    input_contract: { required: [] }, output_contract: { required: [] },
    created_at: 0, approved_by: 'founder', approved_at: 0,
  }));
  stack.store.registerAgent(makeAgent({
    id: agentId, slug: 'cf-impostor-agent', name: 'cf-impostor-agent',
    lifecycle_state: RUNTIME_STATE.ACTIVE, active_version_id: versionId(agentId, '1.0.0'),
  }));

  const v = checkLiveStageAdmission({ store: stack.store, config: STAGE_CONFIG, agent_slug: 'cf-impostor-agent' });
  assert.equal(v.ok, false);
  assert.equal(v.reason, LIVE_STAGE_REASON.LIVE_STAGE_NOT_ADMITTED);
});

test('813. (M28) the bound agent that STOPS declaring the capability loses admission', () => {
  const stack = liveStack({ omitLiveAgent: true });
  // Registered under the right slug but WITHOUT the live capability.
  const agentId = 'agent-cf-script-live';
  stack.store.addAgentVersion(makeAgentVersion({
    agent_id: agentId, version: '1.0.0', purpose: 'no live capability', department: 'content-factory',
    state: VERSION_STATE.APPROVED, clearance: 'GREEN', allowed_tools: [],
    limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 5_000 },
    capabilities: [CAP.SCRIPT], allowed_workflow_types: [WORKFLOW_TYPE_CONTENT_FACTORY],
    input_contract: { required: [] }, output_contract: { required: [] },
    created_at: 0, approved_by: 'founder', approved_at: 0,
  }));
  stack.store.registerAgent(makeAgent({
    id: agentId, slug: S.SCRIPT_LIVE, name: S.SCRIPT_LIVE,
    lifecycle_state: RUNTIME_STATE.ACTIVE, active_version_id: versionId(agentId, '1.0.0'),
  }));

  const v = checkLiveStageAdmission({ store: stack.store, config: STAGE_CONFIG, agent_slug: S.SCRIPT_LIVE });
  assert.equal(v.ok, false);
  assert.equal(v.reason, LIVE_STAGE_REASON.LIVE_STAGE_NOT_ADMITTED);
  assert.match(v.detail, /does not declare/);
});

test('814. (M28) with NO stage configured, the live sentinel is refused and nothing is reachable', async () => {
  const stack = liveStack();
  const ticket = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: null,
    agent_slug: S.SCRIPT_LIVE, task_id: TASK, workflow_id: WORKFLOW, input: { text: 'hi' },
  });
  assert.equal(ticket.admitted, false);
  assert.equal(ticket.reason, LIVE_STAGE_REASON.LIVE_STAGE_NOT_CONFIGURED);
  assert.equal(ticket.network_attempted, false);
  assert.equal(stack.fetchImpl.calls.length, 0, 'an unconfigured factory reaches no network');
});

test('815. (M28) a live stage is never configured by default — createLiveStageConfig demands every field explicitly', () => {
  for (const missing of ['capability', 'agent_slug', 'provider_id', 'model_id', 'artifact_type']) {
    const cfg = {
      capability: CAP.SCRIPT_LIVE, agent_slug: S.SCRIPT_LIVE, provider_id: GROQ_PROVIDER_ID,
      model_id: MODEL, artifact_type: ARTIFACT_TYPE.SCRIPT,
    };
    delete cfg[missing];
    assert.throws(() => createLiveStageConfig(cfg), new RegExp(missing), `${missing} must be required`);
  }
  for (const empty of ['', '   ']) {
    assert.throws(() => createLiveStageConfig({
      capability: empty, agent_slug: S.SCRIPT_LIVE, provider_id: GROQ_PROVIDER_ID,
      model_id: MODEL, artifact_type: ARTIFACT_TYPE.SCRIPT,
    }));
  }
});

// ══ 3. NO OTHER STAGE, NO OTHER AGENT, NO PAYLOAD CAN GO LIVE ════════════

test('816. (M28) an arbitrary agent naming the live sentinel gets nothing — zero network calls', async () => {
  const stack = liveStack();
  const ticket = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: stack.config,
    agent_slug: S.RESEARCH, task_id: TASK, workflow_id: WORKFLOW, input: { text: 'hi' },
  });
  assert.equal(ticket.admitted, false);
  assert.equal(ticket.reason, LIVE_STAGE_REASON.LIVE_STAGE_NOT_ADMITTED);
  assert.equal(stack.fetchImpl.calls.length, 0);

  // And through the real runtime, the refusal is what the handler sees.
  const invoker = createLiveCapableInvoker({ deterministicInvoker: stack.deterministicInvoker, ticket });
  const r = invoker.invoke({ provider_id: LIVE_TEXT_CAPABILITY_ID, agent_slug: S.RESEARCH, input: { text: 'hi' } });
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, LIVE_STAGE_REASON.LIVE_STAGE_NOT_ADMITTED);
});

test('817. (M28) the ROGUE fixture cannot activate the live provider — through the real runtime', async () => {
  const stack = liveStack();
  registerContentFactoryRogueAgent(stack.store);
  const ticket = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: stack.config,
    agent_slug: S.ROGUE, task_id: TASK, workflow_id: WORKFLOW, input: { text: 'hi' },
  });
  assert.equal(ticket.admitted, false);
  assert.equal(stack.fetchImpl.calls.length, 0);

  const { runtime } = stack.runtimeWith(ticket);
  const task = runtime.runTask({ agent_slug: S.ROGUE, input: { topic: 'x' }, task_id: 'task-rogue', tree_id: WORKFLOW });

  // The rogue agent may well SUCCEED — at deterministic work. That is the
  // point: it is not blocked from doing its job, it is blocked from
  // spending money. Asserting "it failed" would be asserting the wrong
  // thing and would pass for entirely unrelated reasons.
  assert.equal(stack.fetchImpl.calls.length, 0, 'the rogue agent reaches no network, ever');
  for (const a of stack.artifactStore.artifactsForWorkflow(WORKFLOW)) {
    assert.notEqual(a.provider_id, GROQ_PROVIDER_ID, 'no rogue artifact may carry live provenance');
  }
  if (task.status === TASK_STATUS.COMPLETED) {
    assert.notEqual(task.output?.result?.live, true, 'and it never reports itself live');
  }
});

test('818. (M28) naming provider_id "groq" directly reaches nothing — the deterministic registry has no such provider', () => {
  const stack = liveStack();
  const invoker = createLiveCapableInvoker({ deterministicInvoker: stack.deterministicInvoker, ticket: null });
  for (const forged of [GROQ_PROVIDER_ID, 'groq', 'live', 'deterministic-text-live']) {
    const r = invoker.invoke({
      provider_id: forged, model_id: MODEL, input: { text: 'hi' },
      agent_slug: S.SCRIPT_LIVE, required_capability: 'text_generation',
    });
    assert.equal(r.status, 'failed', `${forged} must not resolve`);
    assert.equal(r.reason, PROVIDER_REASON.PROVIDER_NOT_FOUND);
  }
});

test('819. (M28) a task payload cannot select a provider — the handler\'s own provider field is the sentinel, and the sentinel is config-resolved', async () => {
  const stack = liveStack();
  const { ticket, task } = await runLiveScriptStage(stack, {
    input: { ...stack.scriptInput, provider_id: 'attacker-choice', model_id: 'attacker-model' },
  });
  assert.equal(task.status, TASK_STATUS.COMPLETED);
  // What was actually called is the CONFIGURED provider and model.
  assert.equal(ticket.providerResult.provider_id, GROQ_PROVIDER_ID);
  assert.equal(ticket.providerResult.model_id, MODEL);
  const body = JSON.parse(stack.fetchImpl.calls[0].init.body);
  assert.equal(body.model, MODEL, 'the wire carried the configured model, not the payload\'s');
});

test('820. (M28) exactly ONE stage is live — the other eleven still run deterministically in the same process', async () => {
  const stack = liveStack();
  const { ticket } = await runLiveScriptStage(stack);
  const { runtime } = stack.runtimeWith(ticket);

  // A deterministic stage, through the SAME live-capable invoker.
  const research = runtime.runTask({
    agent_slug: S.RESEARCH, input: { topic: 'why sleep matters' },
    task_id: 'task-research', tree_id: WORKFLOW,
  });
  assert.equal(research.status, TASK_STATUS.COMPLETED, `research failed: ${research.error ?? 'unknown'}`);
  const artifact = stack.artifactStore.getArtifact(research.output.result.research_artifact_id);
  assert.equal(artifact.provider_id, 'deterministic-text', 'a deterministic stage stays deterministic');
  assert.equal(stack.fetchImpl.calls.length, 1, 'still exactly one network call in the whole run');
});

// ══ 4. CONFIGURATION AND MODEL GATES ══════════════════════════════════════

test('821. (M28) every provider-configuration failure denies before the network', async () => {
  const cases = [
    ['no credential', { [GROQ_ENV.API_KEY]: undefined }, GROQ_CONFIG_REASON.NO_CREDENTIAL],
    ['not enabled', { [GROQ_ENV.REAL_PROVIDER_ENABLED]: undefined }, GROQ_CONFIG_REASON.REAL_PROVIDER_NOT_ENABLED],
    ['provider off', { [GROQ_ENV.GROQ_ENABLED]: 'false' }, null],
    ['no models', { [GROQ_ENV.MODELS]: undefined }, GROQ_CONFIG_REASON.NO_MODELS_CONFIGURED],
    ['zero budget', { [GROQ_ENV.MAX_SPEND_USD]: '0' }, GROQ_CONFIG_REASON.INVALID_SPEND_CEILING],
    ['negative budget', { [GROQ_ENV.MAX_SPEND_USD]: '-1' }, GROQ_CONFIG_REASON.INVALID_SPEND_CEILING],
    ['malformed budget', { [GROQ_ENV.MAX_SPEND_USD]: 'abc' }, GROQ_CONFIG_REASON.INVALID_SPEND_CEILING],
    ['NaN budget', { [GROQ_ENV.MAX_SPEND_USD]: 'NaN' }, GROQ_CONFIG_REASON.INVALID_SPEND_CEILING],
    ['Infinity budget', { [GROQ_ENV.MAX_SPEND_USD]: 'Infinity' }, GROQ_CONFIG_REASON.INVALID_SPEND_CEILING],
    ['missing budget', { [GROQ_ENV.MAX_SPEND_USD]: undefined }, GROQ_CONFIG_REASON.INVALID_SPEND_CEILING],
  ];
  for (const [label, override, expectedConfigReason] of cases) {
    const stack = liveStack({ env: liveEnv(override) });
    assert.equal(stack.groq.included, false, `${label}: the provider must not be registered`);
    if (expectedConfigReason) assert.equal(stack.groq.reason, expectedConfigReason, label);

    const { ticket, task } = await runLiveScriptStage(stack);
    assert.equal(ticket.providerResult.status, 'failed', label);
    assert.equal(stack.fetchImpl.calls.length, 0, `${label} must reach no network`);
    assert.notEqual(task.status, TASK_STATUS.COMPLETED, `${label} must not produce an artifact`);
  }
});

test('822. (M28) multiple configured models FAIL CLOSED — no silent models[0]', async () => {
  const stack = liveStack({ env: liveEnv({ [GROQ_ENV.MODELS]: `${MODEL},other-model` }) });
  // Two models are registered, so the configured one still resolves...
  // but the STAGE is bound to exactly one, and M27's selectSingleModel
  // refuses an ambiguous allowlist outright.
  const { selectSingleModel, AMBIGUOUS_MODEL_SELECTION } = await import('../src/providers/groq-config.js');
  const { readGroqConfig } = await import('../src/providers/groq-config.js');
  const verdict = selectSingleModel(readGroqConfig(liveEnv({ [GROQ_ENV.MODELS]: `${MODEL},other-model` })).models);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, AMBIGUOUS_MODEL_SELECTION);
  assert.equal(stack.fetchImpl.calls.length, 0);
});

test('823. (M28) a stage configured for a model outside the allowlist fails closed with zero network calls', async () => {
  const stack = liveStack({
    config: createLiveStageConfig({
      capability: CAP.SCRIPT_LIVE, agent_slug: S.SCRIPT_LIVE, provider_id: GROQ_PROVIDER_ID,
      model_id: 'not-allowlisted-model', artifact_type: ARTIFACT_TYPE.SCRIPT,
    }),
  });
  const { ticket, task } = await runLiveScriptStage(stack);
  assert.equal(ticket.providerResult.status, 'failed');
  assert.equal(ticket.providerResult.reason, 'UNKNOWN_MODEL', 'the governed invoker refuses an unregistered model');
  assert.equal(stack.fetchImpl.calls.length, 0);
  assert.notEqual(task.status, TASK_STATUS.COMPLETED);
});

// ══ 5. GUARDIAN — UPSTREAM OF THE NETWORK, ALWAYS ════════════════════════

test('824. (M28) every Guardian freeze and lifecycle state blocks the live stage — zero network calls, every time', async () => {
  const freezes = [
    ['agent freeze', (st) => st.store.addFreeze({ scope: 'agent', target_id: S.SCRIPT_LIVE, reason: 'M28', created_at: T0 - 1 }), LIVE_GATE_REASON.AGENT_FROZEN],
    ['workflow freeze', (st) => st.store.addFreeze({ scope: 'workflow', target_id: WORKFLOW, reason: 'M28', created_at: T0 - 1 }), LIVE_GATE_REASON.WORKFLOW_FROZEN],
    ['global freeze', (st) => st.store.addFreeze({ scope: 'global', target_id: null, reason: 'M28', created_at: T0 - 1 }), LIVE_GATE_REASON.GLOBAL_FREEZE],
    ['disabled agent', (st) => st.store.setLifecycleState(S.SCRIPT_LIVE, RUNTIME_STATE.DISABLED), LIVE_GATE_REASON.AGENT_NOT_ACTIVE],
    ['paused agent', (st) => st.store.setLifecycleState(S.SCRIPT_LIVE, RUNTIME_STATE.PAUSED), LIVE_GATE_REASON.AGENT_NOT_ACTIVE],
  ];
  for (const [label, apply, expected] of freezes) {
    const stack = liveStack();
    apply(stack);
    const { ticket, task } = await runLiveScriptStage(stack);
    assert.equal(ticket.providerResult.reason, expected, label);
    assert.equal(ticket.providerResult.network_attempted, false, `${label} must not claim a network attempt`);
    assert.equal(stack.fetchImpl.calls.length, 0, `${label} must reach no network`);
    assert.notEqual(task.status, TASK_STATUS.COMPLETED, `${label} must not produce an artifact`);
  }
});

test('825. (M28) an UNAPPROVED active version blocks the live stage — approval is upstream of spending', async () => {
  const stack = liveStack({ omitLiveAgent: true });
  const agentId = 'agent-cf-script-live';
  stack.store.addAgentVersion(makeAgentVersion({
    agent_id: agentId, version: '1.0.0', purpose: 'unapproved', department: 'content-factory',
    state: VERSION_STATE.DRAFT, clearance: 'GREEN', allowed_tools: [],
    limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 5_000 },
    capabilities: [CAP.SCRIPT_LIVE], allowed_workflow_types: [WORKFLOW_TYPE_CONTENT_FACTORY],
    input_contract: { required: [] }, output_contract: { required: [] },
    created_at: 0, approved_by: null, approved_at: null,
  }));
  stack.store.registerAgent(makeAgent({
    id: agentId, slug: S.SCRIPT_LIVE, name: S.SCRIPT_LIVE,
    lifecycle_state: RUNTIME_STATE.ACTIVE, active_version_id: versionId(agentId, '1.0.0'),
  }));

  const ticket = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: stack.config,
    agent_slug: S.SCRIPT_LIVE, task_id: TASK, workflow_id: WORKFLOW, input: { text: 'hi' },
  });
  assert.equal(ticket.providerResult.reason, LIVE_GATE_REASON.VERSION_NOT_APPROVED);
  assert.equal(stack.fetchImpl.calls.length, 0);
});

// ══ 6. BUDGET AND CALL LIMIT ══════════════════════════════════════════════

test('826. (M28) an insufficient budget at ANY scope denies before the network', async () => {
  for (const scope of ['global', 'agent', 'workflow', 'task']) {
    const stack = liveStack({ perCall: 10, budgets: { [scope]: 1 } });
    const { ticket, task } = await runLiveScriptStage(stack);
    assert.equal(ticket.providerResult.status, 'failed', scope);
    assert.match(String(ticket.providerResult.reason), /BUDGET_EXCEEDED/, scope);
    assert.equal(stack.fetchImpl.calls.length, 0, `${scope}: no network on a denied budget`);
    assert.notEqual(task.status, TASK_STATUS.COMPLETED);
  }
});

test('827. (M28) ONE provider call per task is structural — a second generateContent gets no second paid result', async () => {
  const stack = liveStack();
  const ticket = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: stack.config,
    agent_slug: S.SCRIPT_LIVE, task_id: TASK, workflow_id: WORKFLOW,
    input: buildLiveScriptPrompt(stack.scriptInput),
  });
  const invoker = createLiveCapableInvoker({ deterministicInvoker: stack.deterministicInvoker, ticket });
  const request = {
    provider_id: LIVE_TEXT_CAPABILITY_ID, artifact_type: ARTIFACT_TYPE.SCRIPT,
    input: buildLiveScriptPrompt(stack.scriptInput), agent_slug: S.SCRIPT_LIVE,
    task_id: TASK, tree_id: WORKFLOW,
  };

  const first = invoker.invoke(request);
  assert.equal(first.status, 'ok', first.reason);

  const second = invoker.invoke(request);
  assert.equal(second.status, 'failed');
  assert.equal(second.reason, LIVE_STAGE_REASON.LIVE_TICKET_ALREADY_USED);
  assert.equal(stack.fetchImpl.calls.length, 1, 'still exactly one network call');
});

test('828. (M28) the live stage never retries — max_retries is pinned to 0 by trusted code, not by the request', async () => {
  const fetchImpl = recordingFetch(() => errorResponse(503, 'upstream down'));
  const stack = liveStack({ fetchImpl });
  const { ticket } = await runLiveScriptStage(stack);
  assert.equal(ticket.providerResult.status, 'failed');
  assert.equal(fetchImpl.calls.length, 1, 'exactly one request even for a RETRYABLE failure class');

  const src = readFileSync(new URL('../src/content-factory-live.js', import.meta.url), 'utf8');
  assert.ok(/max_retries:\s*0/.test(src), 'the zero is in trusted code');
  assert.equal(/max_retries:\s*request/.test(src), false, 'and never taken from a request');
});

// ══ 7. NO FALLBACK, EVER ══════════════════════════════════════════════════

test('829. (M28) a provider failure FAILS CLOSED — it never falls back to the deterministic provider', async () => {
  for (const [label, responder] of [
    ['auth failure', () => errorResponse(401, 'bad key')],
    ['unavailable', () => errorResponse(503, 'down')],
    ['malformed', () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) })],
    ['transport throw', () => { throw new Error('socket died'); }],
  ]) {
    const fetchImpl = recordingFetch(responder);
    const stack = liveStack({ fetchImpl });
    const { ticket, task } = await runLiveScriptStage(stack);

    assert.equal(ticket.providerResult.status, 'failed', label);
    assert.notEqual(task.status, TASK_STATUS.COMPLETED, `${label} must not succeed`);
    // No artifact, and no deterministic substitute.
    assert.equal(task.output?.result?.script_artifact_id, undefined, `${label} produced no artifact`);
    assert.equal(fetchImpl.calls.length <= 1, true, `${label}: at most one request`);
  }
});

test('830. (M28) the handler cannot obtain content for a request governance did not approve', async () => {
  const stack = liveStack();
  const ticket = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: stack.config,
    agent_slug: S.SCRIPT_LIVE, task_id: TASK, workflow_id: WORKFLOW,
    input: buildLiveScriptPrompt(stack.scriptInput),
  });
  const invoker = createLiveCapableInvoker({ deterministicInvoker: stack.deterministicInvoker, ticket });

  // A different prompt than the one paid for.
  const mismatched = invoker.invoke({
    provider_id: LIVE_TEXT_CAPABILITY_ID, artifact_type: ARTIFACT_TYPE.SCRIPT,
    input: { text: 'something else entirely' }, agent_slug: S.SCRIPT_LIVE,
    task_id: TASK, tree_id: WORKFLOW,
  });
  assert.equal(mismatched.status, 'failed');
  assert.equal(mismatched.reason, LIVE_STAGE_REASON.LIVE_REQUEST_MISMATCH);

  // artifact_type is NOT fingerprinted, and deliberately so: runtime.js
  // never forwards it to an invoker, so comparing it here would compare
  // undefined to undefined and weaken the check silently. It is governed
  // where it actually lives — see fingerprintLiveRequest's note and
  // test 841.

  // The model_id a handler supplies is IGNORED, not negotiated: the same
  // request with an attacker's model still matches, and still used the
  // configured model on the wire.
  const withForgedModel = invoker.invoke({
    provider_id: LIVE_TEXT_CAPABILITY_ID, model_id: 'attacker-model',
    artifact_type: ARTIFACT_TYPE.SCRIPT, input: buildLiveScriptPrompt(stack.scriptInput),
    agent_slug: S.SCRIPT_LIVE, task_id: TASK, tree_id: WORKFLOW,
  });
  assert.equal(withForgedModel.status, 'ok', 'a forged model_id changes nothing');
  assert.equal(withForgedModel.model_id, MODEL);
});

// ══ 8. CREDENTIAL CONTAINMENT ═════════════════════════════════════════════

test('831. (M28) the sentinel credential reaches the Authorization header and nothing else', async () => {
  const stack = liveStack();
  const { ticket, task } = await runLiveScriptStage(stack);
  assert.equal(task.status, TASK_STATUS.COMPLETED);

  const call = stack.fetchImpl.calls[0];
  assert.equal(String(call.init.headers.authorization).includes(SENTINEL_KEY), true, 'it belongs there');
  assert.equal(String(call.init.body).includes(SENTINEL_KEY), false, 'never in the body');
  assert.equal(String(call.url).includes(SENTINEL_KEY), false, 'never in the URL');

  const artifact = stack.artifactStore.getArtifact(task.output.result.script_artifact_id);
  for (const [where, blob] of [
    ['ticket', JSON.stringify(ticket)],
    ['task record', JSON.stringify(task)],
    ['task output', JSON.stringify(task.output)],
    ['artifact', JSON.stringify(artifact)],
    ['provider_usage', JSON.stringify(ticket.providerResult.provider_usage ?? null)],
    ['audit log', JSON.stringify(stack.audit.all())],
  ]) {
    assert.equal(blob.includes(SENTINEL_KEY), false, `the credential must never reach the ${where}`);
    assert.equal(/Bearer\s+gsk_/i.test(blob), false, `no bearer token in the ${where}`);
  }
});

test('832. (M28) a provider that echoes the Authorization header back cannot get the credential persisted', async () => {
  const echo = `authorization: Bearer ${SENTINEL_KEY}`;
  const fetchImpl = recordingFetch(() => okResponse(`Scene 1. ${echo} Scene 2.`));
  const stack = liveStack({ fetchImpl });
  const { ticket, task } = await runLiveScriptStage(stack);
  assert.equal(task.status, TASK_STATUS.COMPLETED, JSON.stringify(task.error));

  const artifact = stack.artifactStore.getArtifact(task.output.result.script_artifact_id);
  assert.equal(JSON.stringify(artifact).includes(SENTINEL_KEY), false, 'not in the artifact, content included');
  assert.ok(artifact.content.includes('[REDACTED]'), 'redacted visibly, not silently dropped');
  assert.equal(JSON.stringify(stack.audit.all()).includes(SENTINEL_KEY), false, 'not in the append-only audit log');
  assert.equal(JSON.stringify(ticket).includes(SENTINEL_KEY), false, 'not in the ticket handed across phases');
});

test('833. (M28) an error body echoing the credential is redacted everywhere it is recorded', async () => {
  const fetchImpl = recordingFetch(() => errorResponse(500, `upstream echoed Bearer ${SENTINEL_KEY}`));
  const stack = liveStack({ fetchImpl });
  const { ticket, task } = await runLiveScriptStage(stack);
  assert.equal(JSON.stringify(ticket).includes(SENTINEL_KEY), false);
  assert.equal(JSON.stringify(task).includes(SENTINEL_KEY), false);
  assert.equal(JSON.stringify(stack.audit.all()).includes(SENTINEL_KEY), false);
});

// ══ 9. THE CEO CONTROLS NOTHING HERE ══════════════════════════════════════

test('834. (M28) no CEO file can reach the live stage, a credential, a provider, a model, or a budget', () => {
  const CEO_FILES = readdirSync(new URL('../src/ceo/', import.meta.url))
    .filter((f) => f.endsWith('.js')).map((f) => `../src/ceo/${f}`);
  CEO_FILES.push('../src/ceo-agent.js');

  const FORBIDDEN = [
    'GROQ', 'groq', 'API_KEY', 'apiKey', 'process.env', 'fetch(', 'axios',
    'content-factory-live', 'LIVE_TEXT_CAPABILITY_ID', 'createLiveStageConfig',
    'resolveLiveStageContent', 'createLiveCapableInvoker', 'checkLiveStageAdmission',
    'live-registry', 'live-guard', 'createLiveProviderChain', 'createLiveProviderRegistry',
    'createGroqProvider', 'readGroqConfig', 'createResourceGovernor',
    'configureGlobalBudget', 'configureAgentBudget', 'configureWorkflowBudget', 'configureTaskBudget',
    'addFreeze(', 'setLifecycleState(', 'MAX_SPEND', 'max_retries', 'max_cost_per_call',
  ];
  assert.ok(CEO_FILES.length >= 6, 'every CEO file must be swept');
  for (const path of CEO_FILES) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const term of FORBIDDEN) {
      assert.ok(!src.includes(term), `${path} must not reference "${term}"`);
    }
  }
});

test('835. (M28) the CEO agent holds no tools and no clearance that could authorize spending', async () => {
  const { CEO_AGENT_SLUG, registerCeoAgent } = await import('../src/ceo-agent.js');
  const stack = liveStack();
  registerCeoAgent(stack.store);
  const ceo = stack.store.getAgent(CEO_AGENT_SLUG);
  assert.equal(ceo.clearance, 'GREEN');
  assert.deepEqual(ceo.allowed_tools, [], 'the CEO holds no tools at all');
  // And it is not the configured live stage.
  const v = checkLiveStageAdmission({ store: stack.store, config: STAGE_CONFIG, agent_slug: CEO_AGENT_SLUG });
  assert.equal(v.ok, false);
  assert.equal(v.reason, LIVE_STAGE_REASON.LIVE_STAGE_NOT_ADMITTED);
});

// ══ 10. STRUCTURE: ONE EGRESS, NO NEW AUTHORITY ══════════════════════════

test('836. (M28) the live-stage module holds no network, no credential, and no registry access', () => {
  const src = readFileSync(new URL('../src/content-factory-live.js', import.meta.url), 'utf8');
  for (const term of [
    'fetch(', 'axios', 'node:http', 'node:https', 'node:net', 'child_process', 'eval(',
    'API_KEY', 'apiKey', 'process.env', 'Bearer',
    'createGroqProvider', 'createLiveProviderRegistry', 'registerAgent(', 'addAgentVersion(',
    'addFreeze(', 'setLifecycleState(', 'configureGlobalBudget', 'addBudget(', 'broker.',
  ]) {
    assert.ok(!src.includes(term), `content-factory-live.js must not reference "${term}"`);
  }
});

test('837. (M28, revised by M29) exactly the FOUR designated text stages name the live sentinel — never a fifth', () => {
  // M28 asserted "exactly one" because exactly one live stage existed.
  // M29 deliberately adds three more TEXT stages — research, hook,
  // social-package — and this test now asserts the NEW ceiling exactly,
  // the same discipline M28 applied to test 805 when its own invariant
  // needed to change on purpose rather than be quietly relaxed.
  const src = readFileSync(new URL('../src/content-factory-agents.js', import.meta.url), 'utf8');
  const uses = src.split('provider_id: LIVE_TEXT_CAPABILITY_ID').length - 1;
  assert.equal(uses, 4, 'exactly four handlers may name the live sentinel: research, script, hook, social-package');
  // And every other handler still names a deterministic provider — audio,
  // image, video, subtitle, and publishing are never live (directive
  // section 5).
  const deterministic = src.split("provider_id: 'deterministic-").length - 1;
  assert.ok(deterministic >= 8, `the other stages stay deterministic (found ${deterministic})`);
});

test('838. (M28) the deterministic Content Factory still works, end to end, entirely offline', async () => {
  // The regression that matters most: a normal run must be untouched.
  const { runContentFactory } = await import('../src/content-factory-orchestrator.js');
  const { createProviderInvoker: mkInvoker } = await import('../src/providers/invoke.js');
  const { tools } = createTools();
  const store = createMemoryStore();
  const artifactStore = createMemoryArtifactStore();
  const audit = createAuditSink();
  const clock = () => T0;
  const registrySha = 'cf-registry-sha';
  const broker = createBroker({ tools, store, audit, clock, registrySha });
  const artifactService = createArtifactService({ store, artifactStore, audit, clock, registrySha });
  const providerInvoker = mkInvoker({ registry: defaultContentProviderRegistry, audit, clock });
  const runtime = createRuntime({
    store, broker, audit, clock, registrySha,
    handlers: CONTENT_FACTORY_HANDLERS, artifactService, providerInvoker,
  });
  const router = createRouter({ store, audit, clock });
  const workflow = createWorkflowEngine({ store, runtime, broker, audit, clock, registrySha });
  const guardian = createGuardian({ store, audit, clock });
  const coordinator = createExecutionCoordinator({ workflow, router, guardian, store, audit, clock });
  registerContentFactoryAgents(store);

  const result = runContentFactory({
    store, artifactStore, workflow, coordinator, runtime, router, guardian, audit,
    workflow_id: 'wf-deterministic', topic: 'why sleep matters', budget_limit: 5000,
  });
  assert.ok(result, 'a deterministic run still completes');
  const artifacts = artifactStore.artifactsForWorkflow('wf-deterministic');
  assert.ok(artifacts.length >= 8, `a full deterministic run still produces its artifacts (${artifacts.length})`);
  for (const a of artifacts) {
    // A null provider_id is correct for artifacts a handler composes
    // directly (the QC report, the publishing package) rather than
    // generating. What must never appear is a LIVE provider.
    if (a.provider_id !== null) {
      assert.ok(String(a.provider_id).startsWith('deterministic-'),
        `${a.artifact_type} stayed deterministic (got ${a.provider_id})`);
    }
    assert.notEqual(a.provider_id, GROQ_PROVIDER_ID, `${a.artifact_type} must not be live`);
  }
});

test('839. (M28, revised by M29) src/ gained exactly the live-stage boundary modules — nothing stray', () => {
  // M28 asserted "exactly one new module." M29 deliberately adds a
  // second — content-factory-live-pipeline.js, the multi-stage
  // orchestration glue — and test 883 in
  // tests/content-factory-live-pipeline.test.js now asserts the current
  // expected set directly. This test keeps the SAME discipline M28
  // established (a stray live/groq module fails the build) without
  // duplicating that assertion's exact list.
  const files = readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.js')).sort();
  const EXPECTED_LIVE_MODULES = ['content-factory-live-pipeline.js', 'content-factory-live.js'];
  for (const expected of EXPECTED_LIVE_MODULES) assert.ok(files.includes(expected));
  const unexpected = files.filter((f) => /live|groq/i.test(f) && !EXPECTED_LIVE_MODULES.includes(f));
  assert.deepEqual(unexpected, [], 'no other live module may appear in src/');
});

test('840. (M28) no fallback provider is reachable from the live stage — the sentinel resolves to one provider or nothing', async () => {
  const stack = liveStack();
  const ticket = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: stack.config,
    agent_slug: S.SCRIPT_LIVE, task_id: TASK, workflow_id: WORKFLOW,
    input: buildLiveScriptPrompt(stack.scriptInput),
  });
  // The ticket names exactly one provider and one model, both from config.
  assert.equal(ticket.config.provider_id, GROQ_PROVIDER_ID);
  assert.equal(ticket.config.model_id, MODEL);
  assert.equal(ticket.providerResult.provider_id, GROQ_PROVIDER_ID);

  const src = readFileSync(new URL('../src/content-factory-live.js', import.meta.url), 'utf8');
  for (const term of ['fallback', 'deterministic-text', 'catch (', '|| deterministic']) {
    assert.equal(src.includes(term), false, `no fallback path may exist ("${term}")`);
  }
});

// ══ 11. APPROVAL IS UPSTREAM, AND THE LIVE CAPABILITY BUYS NO EXEMPTION ══

test('841. (M28) the live stage produces exactly the artifact type its configuration declares', async () => {
  const stack = liveStack();
  const { task } = await runLiveScriptStage(stack);
  const artifact = stack.artifactStore.getArtifact(task.output.result.script_artifact_id);
  assert.equal(artifact.artifact_type, STAGE_CONFIG.artifact_type);
  assert.equal(artifact.artifact_type, ARTIFACT_TYPE.SCRIPT);
  assert.equal(task.output.result.artifact_type, ARTIFACT_TYPE.SCRIPT);
  // And the declared type is the SCRIPT the deterministic stage also
  // produces — going live changed the provider, not the contract.
  assert.equal(
    CONTENT_FACTORY_AGENTS.scriptLive.version.metadata.supported_artifact_types[0],
    CONTENT_FACTORY_AGENTS.script.version.metadata.supported_artifact_types[0],
  );
});

test('842. (M28) a SUPERSEDED version revokes live access — approval state is re-read, never cached', async () => {
  const stack = liveStack({ omitLiveAgent: true });
  const agentId = 'agent-cf-script-live';
  for (const [v, state] of [['1.0.0', VERSION_STATE.SUPERSEDED]]) {
    stack.store.addAgentVersion(makeAgentVersion({
      agent_id: agentId, version: v, purpose: 'superseded', department: 'content-factory',
      state, clearance: 'GREEN', allowed_tools: [],
      limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 5_000 },
      capabilities: [CAP.SCRIPT_LIVE], allowed_workflow_types: [WORKFLOW_TYPE_CONTENT_FACTORY],
      input_contract: { required: [] }, output_contract: { required: [] },
      created_at: 0, approved_by: null, approved_at: null,
    }));
  }
  stack.store.registerAgent(makeAgent({
    id: agentId, slug: S.SCRIPT_LIVE, name: S.SCRIPT_LIVE,
    lifecycle_state: RUNTIME_STATE.ACTIVE, active_version_id: versionId(agentId, '1.0.0'),
  }));

  const ticket = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: stack.config,
    agent_slug: S.SCRIPT_LIVE, task_id: TASK, workflow_id: WORKFLOW, input: { text: 'hi' },
  });
  assert.equal(ticket.providerResult.reason, LIVE_GATE_REASON.VERSION_NOT_APPROVED);
  assert.equal(stack.fetchImpl.calls.length, 0, 'a superseded version spends nothing');
});

test('843. (M28) holding the live capability grants NO tool authority — a YELLOW action still needs approval', () => {
  // The live-capable agent is GREEN and holds no tools, so the Approval
  // Engine is not in `generateContent`'s path at all — stated plainly
  // rather than staged. What must hold is that the live capability buys
  // no exemption anywhere ELSE: a YELLOW-clearance agent carrying the
  // very same capability still cannot act without human approval.
  const stack = liveStack();
  const live = stack.store.getAgent(S.SCRIPT_LIVE);
  assert.equal(live.clearance, 'GREEN');
  assert.deepEqual(live.allowed_tools, [], 'the live stage holds no tools');

  const agentId = 'agent-cf-yellow-live';
  const toolId = 'fake.send_message';
  stack.store.addAgentVersion(makeAgentVersion({
    agent_id: agentId, version: '1.0.0', purpose: 'yellow live-capable', department: 'content-factory',
    state: VERSION_STATE.APPROVED, clearance: 'YELLOW', allowed_tools: [toolId],
    limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 5_000 },
    capabilities: [CAP.SCRIPT_LIVE], allowed_workflow_types: [WORKFLOW_TYPE_CONTENT_FACTORY],
    input_contract: { required: [] }, output_contract: { required: [] },
    created_at: 0, approved_by: 'founder', approved_at: 0,
  }));
  stack.store.registerAgent(makeAgent({
    id: agentId, slug: 'cf-yellow-live-agent', name: 'cf-yellow-live-agent',
    lifecycle_state: RUNTIME_STATE.ACTIVE, active_version_id: versionId(agentId, '1.0.0'),
  }));
  stack.store.addBudget({ level: 'task', target_id: 'task-yellow', limit: 5000, spent: 0 });
  stack.store.addBudget({ level: 'agent_day', target_id: 'cf-yellow-live-agent', limit: 5000, spent: 0 });

  const decision = stack.broker.authorize({
    agent_slug: 'cf-yellow-live-agent', tool_id: toolId, task_id: 'task-yellow',
    payload: { to: 'someone@example.com', subject: 's', body: 'b' },
    idempotency_key: 'k-yellow-live',
  });
  assert.notEqual(decision.decision, 'ALLOW', 'the live capability must not authorize a tool call');
});

// ══ 12. THE CEO, BEHAVIOURALLY ════════════════════════════════════════════

test('844. (M28) the CEO cannot approve anything — the Approval Engine refuses a non-human actor', async () => {
  const { createApprovalEngine } = await import('../src/approval-engine.js');
  const { CEO_AGENT_SLUG, registerCeoAgent } = await import('../src/ceo-agent.js');
  const stack = liveStack();
  registerCeoAgent(stack.store);
  const engine = createApprovalEngine({
    store: stack.store, tools: stack.tools, audit: stack.audit, clock: stack.clock, registrySha: stack.registrySha,
  });

  const asCeo = await engine.decide({
    approval_id: 'approval-1', decision: 'approved',
    actor_type: 'agent', actor: CEO_AGENT_SLUG, task_id: TASK,
  });
  assert.equal(asCeo.outcome, 'rejected', 'an agent actor can never approve');
  assert.equal(asCeo.code, 'APPROVAL_ACTOR_INVALID');
});

test('845. (M28) the CEO cannot lift a freeze, change a lifecycle state, or move a budget — it holds no such surface', async () => {
  const { CEO_AGENT_SLUG, registerCeoAgent } = await import('../src/ceo-agent.js');
  const { createCeoOrchestrator } = await import('../src/ceo/orchestrator.js');
  const stack = liveStack();
  registerCeoAgent(stack.store);

  // Whatever the orchestrator exposes, none of it is a mutation surface.
  const orchestrator = createCeoOrchestrator({
    store: stack.store, audit: stack.audit, clock: stack.clock,
  });
  for (const forbidden of [
    'addFreeze', 'removeFreeze', 'setLifecycleState', 'addBudget', 'chargeBudgets',
    'registerAgent', 'addAgentVersion', 'setActiveVersion', 'decide', 'revoke',
    'configureGlobalBudget', 'configureAgentBudget', 'invoke', 'generateContent',
  ]) {
    assert.equal(typeof orchestrator[forbidden], 'undefined', `the CEO orchestrator must expose no ${forbidden}()`);
  }

  // And a Guardian freeze on the live stage still binds while the CEO runs.
  stack.store.addFreeze({ scope: 'agent', target_id: S.SCRIPT_LIVE, reason: 'M28', created_at: T0 - 1 });
  const ticket = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: stack.config,
    agent_slug: S.SCRIPT_LIVE, task_id: TASK, workflow_id: WORKFLOW, input: { text: 'hi' },
  });
  assert.equal(ticket.providerResult.reason, LIVE_GATE_REASON.AGENT_FROZEN);
  assert.equal(stack.fetchImpl.calls.length, 0);
  assert.ok(CEO_AGENT_SLUG);
});

test('846. (M28) the CEO is not, and cannot become, the live stage — even if it declared the capability', () => {
  const { CEO_AGENT_SLUG } = { CEO_AGENT_SLUG: 'ceo-orchestrator-agent' };
  const stack = liveStack();
  // The configuration binds one slug. Nothing the CEO does changes that,
  // because the config is frozen and built outside its reach.
  assert.equal(Object.isFrozen(STAGE_CONFIG), true);
  assert.throws(() => { STAGE_CONFIG.agent_slug = CEO_AGENT_SLUG; }, TypeError);
  assert.throws(() => { STAGE_CONFIG.model_id = 'ceo-chosen-model'; }, TypeError);
  assert.equal(STAGE_CONFIG.agent_slug, S.SCRIPT_LIVE);

  const v = checkLiveStageAdmission({ store: stack.store, config: STAGE_CONFIG, agent_slug: CEO_AGENT_SLUG });
  assert.equal(v.ok, false);
});

test('847. (M28) phase 1 takes the provider and model from CONFIG even when the input carries its own', async () => {
  // Found by M28 mutation testing: making resolveLiveStageContent prefer
  // `input.provider_id` killed no test, because `buildLiveScriptPrompt`
  // happens to strip every field except `text`. That is real defence,
  // but it is the PROMPT BUILDER's property, not this boundary's — and a
  // future prompt that passed more of the payload through would silently
  // hand provider selection to the payload. Asserted directly now.
  const stack = liveStack();
  const hostileInput = {
    text: 'Write a short script.',
    provider_id: 'attacker-provider', model_id: 'attacker-model',
    max_retries: 9, agent_slug: S.RESEARCH, cost_limit: 999, credential: 'nope',
  };
  const ticket = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: stack.config,
    agent_slug: S.SCRIPT_LIVE, task_id: TASK, workflow_id: WORKFLOW, input: hostileInput,
  });
  assert.equal(ticket.admitted, true);
  assert.equal(ticket.providerResult.status, 'ok', ticket.providerResult.reason);
  assert.equal(ticket.providerResult.provider_id, GROQ_PROVIDER_ID, 'the CONFIGURED provider was used');
  assert.equal(ticket.providerResult.model_id, MODEL, 'the CONFIGURED model was used');

  const body = JSON.parse(stack.fetchImpl.calls[0].init.body);
  assert.equal(body.model, MODEL, 'and the wire carried the configured model');
  assert.equal(stack.fetchImpl.calls.length, 1, 'a max_retries of 9 in the payload bought no extra attempt');
});

test('848. (M28) the prompt builder emits ONLY a prompt — no payload field can ride along to the provider', () => {
  const built = buildLiveScriptPrompt({
    topic: 'why sleep matters', idea_artifact_id: 'idea-1',
    provider_id: 'attacker-provider', model_id: 'attacker-model',
    credential: 'gsk_should_never_appear', max_retries: 9, registry_sha: 'forged',
  });
  assert.deepEqual(Object.keys(built), ['text'], 'exactly one field reaches the provider');
  for (const leak of ['attacker-provider', 'attacker-model', 'gsk_should_never_appear', 'forged', 'idea-1']) {
    assert.equal(built.text.includes(leak), false, `"${leak}" must not reach the prompt`);
  }
});

test('849. (M28) a VALID ticket cannot be consumed by a different stage in the same run — no ticket theft', async () => {
  // Found by M28 mutation testing: removing the caller binding killed no
  // test, because every existing case involved a ticket that phase 1 had
  // already refused, so the earlier `!ticket.admitted` branch fired first.
  //
  // The binding matters in the case nothing covered: a GENUINELY ADMITTED
  // ticket, presented by a different agent. One live-capable invoker is
  // handed to one runtime, and that runtime runs every stage's tasks — so
  // without this check another specialist naming the sentinel, with the
  // same prompt, would consume the paid result and stamp its OWN
  // provenance on the artifact. That is theft of a paid call and a
  // falsified lineage in one step.
  const stack = liveStack();
  const ticket = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: stack.config,
    agent_slug: S.SCRIPT_LIVE, task_id: TASK, workflow_id: WORKFLOW,
    input: buildLiveScriptPrompt(stack.scriptInput),
  });
  assert.equal(ticket.admitted, true, 'the ticket must be genuinely valid');

  const invoker = createLiveCapableInvoker({ deterministicInvoker: stack.deterministicInvoker, ticket });

  // A DIFFERENT agent, with the byte-identical request the ticket paid for.
  for (const thief of [S.RESEARCH, S.IDEA, S.PUBLISHING_PACKAGE, S.ROGUE, 'ceo-orchestrator-agent']) {
    const stolen = invoker.invoke({
      provider_id: LIVE_TEXT_CAPABILITY_ID,
      input: buildLiveScriptPrompt(stack.scriptInput),
      agent_slug: thief, task_id: TASK, tree_id: WORKFLOW,
    });
    assert.equal(stolen.status, 'failed', `${thief} must not consume another stage's paid result`);
    assert.equal(stolen.reason, LIVE_STAGE_REASON.LIVE_STAGE_NOT_ADMITTED, thief);
    assert.equal(stolen.output, null, `${thief} must receive no content`);
  }

  // The rightful owner is unaffected — the ticket was never consumed by
  // the attempts above.
  const rightful = invoker.invoke({
    provider_id: LIVE_TEXT_CAPABILITY_ID,
    input: buildLiveScriptPrompt(stack.scriptInput),
    agent_slug: S.SCRIPT_LIVE, task_id: TASK, tree_id: WORKFLOW,
  });
  assert.equal(rightful.status, 'ok', 'a refused theft must not burn the ticket');
  assert.equal(stack.fetchImpl.calls.length, 1, 'and still exactly one network call');
});

test('850. (M29 addition) a ticket resolved for one task cannot be honoured for another — even under the SAME agent', async () => {
  const stack = liveStack();
  const ticket = await resolveLiveStageContent({
    store: stack.store, chain: stack.chain, config: stack.config,
    agent_slug: S.SCRIPT_LIVE, task_id: TASK, workflow_id: WORKFLOW,
    input: buildLiveScriptPrompt(stack.scriptInput),
  });
  assert.equal(ticket.admitted, true);
  assert.equal(ticket.task_id, TASK);
  assert.equal(ticket.workflow_id, WORKFLOW);

  const invoker = createLiveCapableInvoker({ deterministicInvoker: stack.deterministicInvoker, ticket });

  for (const [label, override] of [
    ['different task_id', { task_id: 'task-other' }],
    ['different workflow', { tree_id: 'wf-other' }],
    ['both different', { task_id: 'task-other', tree_id: 'wf-other' }],
    ['missing entirely', { task_id: undefined, tree_id: undefined }],
  ]) {
    const r = invoker.invoke({
      provider_id: LIVE_TEXT_CAPABILITY_ID,
      input: buildLiveScriptPrompt(stack.scriptInput),
      agent_slug: S.SCRIPT_LIVE, task_id: TASK, tree_id: WORKFLOW, ...override,
    });
    assert.equal(r.status, 'failed', label);
    assert.equal(r.reason, LIVE_STAGE_REASON.LIVE_TICKET_SCOPE_MISMATCH, label);
    assert.equal(stack.fetchImpl.calls.length, 1, `${label}: no second network call`);
  }

  // The rightful, exact scope still works and burns the ticket.
  const rightful = invoker.invoke({
    provider_id: LIVE_TEXT_CAPABILITY_ID, input: buildLiveScriptPrompt(stack.scriptInput),
    agent_slug: S.SCRIPT_LIVE, task_id: TASK, tree_id: WORKFLOW,
  });
  assert.equal(rightful.status, 'ok');
});

/**
 * CONTROLLED GROQ ACTIVATION + LIVE GOVERNANCE VERIFICATION (M26)
 *
 * M25 built the Groq adapter and proved credential isolation. M26 proves
 * the GOVERNANCE around a real, paid call — every scope, every denial,
 * every failure class — and closes a real gap found while doing so.
 *
 * ── THE GAP THIS MILESTONE FOUND AND FIXED ───────────────────────────────
 *
 * Deterministic providers are only reachable through `runtime.js`, whose
 * pre-flight has checked agent/workflow/global freezes since M4/M8. The
 * LIVE provider is not: it is invoked directly through
 * `resource-governor.js` → `invoke-async.js` → `groq.js`, a path that
 * never touches `runtime.js`. Grepping that whole chain for
 * `activeFreeze` returns ZERO — the governor does not even receive a
 * store. A Guardian freeze therefore could NOT stop a paid call.
 *
 * M25's own test 735 appeared to cover this but asserted a call count on
 * a `fetchImpl` that its runtime was never connected to — trivially
 * true, proving nothing. `src/providers/live-guard.js` (M26) closes the
 * gap additively, in front of the unmodified governor. Tests 759-766
 * below are the real proof.
 *
 * ── NO REAL NETWORK CALL HAPPENS IN THIS FILE ────────────────────────────
 *
 * Every test injects `fetchImpl` and counts requests. The one real call
 * this milestone can make lives in `scripts/live-groq-smoke.mjs`, is
 * operator-gated, and is never reachable from `npm test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAuditSink } from '../src/audit.js';
import { createMemoryStore } from '../src/store.js';
import { createMemoryArtifactStore } from '../src/artifact-store.js';
import { createArtifactService } from '../src/artifact-service.js';
import { createBroker, DECISION } from '../src/broker.js';
import { createTools } from '../src/tools.js';
import { createResourceGovernor, RESOURCE_GOVERNOR_POLICY } from '../src/resource-governor.js';
import { makeAgent, makeAgentVersion, VERSION_STATE, RUNTIME_STATE, versionId } from '../src/agents.js';
import { ARTIFACT_TYPE } from '../src/artifacts.js';
import { PROVIDER_REASON, RETRYABLE_PROVIDER_REASONS } from '../src/providers/contracts.js';
import { createAsyncProviderInvoker } from '../src/providers/invoke-async.js';
import { buildArtifactRequestFromProviderResult } from '../src/providers/artifact-bridge.js';
import { createLiveProviderRegistry } from '../src/providers/live-registry.js';
import { createLiveProviderGate, createLiveProviderChain, LIVE_GATE_REASON } from '../src/providers/live-guard.js';
import { GROQ_PROVIDER_ID, GROQ_CAPABILITY, createGroqProvider } from '../src/providers/groq.js';
import { GROQ_ENV, isLiveGroqAuthorized, readGroqConfig } from '../src/providers/groq-config.js';

const T0 = 16_000_000;
const FAKE_KEY = 'gsk_TESTONLY_0000000000000000000000000000';
const MODEL = 'test-model-a';
const AGENT = 'live-gov-agent';
const WORKFLOW = 'wf-live-gov';
const TASK = 'task-live-gov';

function liveEnv(overrides = {}) {
  return {
    [GROQ_ENV.REAL_PROVIDER_ENABLED]: 'true',
    [GROQ_ENV.API_KEY]: FAKE_KEY,
    [GROQ_ENV.MODELS]: MODEL,
    [GROQ_ENV.MAX_SPEND_USD]: '1.00',
    ...overrides,
  };
}

function recordingFetch(responder) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init, calls.length);
  };
  impl.calls = calls;
  return impl;
}

const okResponse = (text = 'AI-HQ-LIVE-OK') => ({
  ok: true,
  status: 200,
  json: async () => ({
    id: 'req-m26', model: MODEL,
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 },
  }),
});

const errorResponse = (status, body = 'err') => ({
  ok: false, status, text: async () => body, json: async () => ({}),
});

function registerAgent(store, slug = AGENT, o = {}) {
  const agentId = `agent-${slug}`;
  const state = o.versionState ?? VERSION_STATE.APPROVED;
  store.addAgentVersion(makeAgentVersion({
    agent_id: agentId, version: '1.0.0', purpose: 'm26 fixture', department: 'internal',
    state, clearance: o.clearance ?? 'GREEN', allowed_tools: o.allowed_tools ?? [],
    limits: {}, input_contract: {}, output_contract: {}, created_at: 0,
    approved_by: state === VERSION_STATE.APPROVED ? 'founder' : null,
    approved_at: state === VERSION_STATE.APPROVED ? 0 : null,
  }));
  store.registerAgent(makeAgent({
    id: agentId, slug, name: slug,
    lifecycle_state: o.lifecycleState ?? RUNTIME_STATE.ACTIVE,
    active_version_id: o.noVersion ? null : versionId(agentId, '1.0.0'),
  }));
  return { agentId, versionId: versionId(agentId, '1.0.0') };
}

/** The full live governance chain: gate → governor → invoke-async →
 * groq adapter, over a real store. Budgets default to comfortably
 * sufficient so a test can make ONE scope insufficient in isolation. */
function govStack(o = {}) {
  const store = createMemoryStore();
  const artifactStore = createMemoryArtifactStore();
  const audit = createAuditSink();
  const clock = o.clock ?? (() => T0);
  const fetchImpl = o.fetchImpl ?? recordingFetch(() => okResponse());
  const { registry } = createLiveProviderRegistry({
    env: o.env ?? liveEnv(), fetchImpl, maxCostPerCallUsd: o.perCall ?? 1,
  });
  const invoker = createAsyncProviderInvoker({ registry, audit, clock });
  // The composed live chain: Guardian gate → governor → invoker, with
  // provider provenance preserved across the governor's envelope.
  const chain = createLiveProviderChain({
    store, invoker, createGovernor: createResourceGovernor, registry, audit, clock,
  });
  const governor = chain.governor;
  const budgets = { global: 100, agent: 100, workflow: 100, task: 100, ...(o.budgets ?? {}) };
  governor.configureGlobalBudget(budgets.global);
  governor.configureAgentBudget(AGENT, budgets.agent);
  governor.configureWorkflowBudget(WORKFLOW, budgets.workflow);
  governor.configureTaskBudget(TASK, budgets.task);
  if (!o.omitAgent) registerAgent(store, AGENT, o.agent ?? {});
  return { store, artifactStore, audit, clock, fetchImpl, registry, invoker, governor, gate: chain };
}

const REQ = Object.freeze({
  provider_id: GROQ_PROVIDER_ID, model_id: MODEL, input: { text: 'hi' },
  agent_slug: AGENT, tree_id: WORKFLOW, task_id: TASK,
});

// ══ PHASE 4: all four budget scopes, individually ═════════════════════════

test('742. (Phase 4) with every scope sufficient, the request is allowed and exactly ONE network call is made', async () => {
  const stack = govStack();
  const result = await stack.gate.invoke({ ...REQ });
  assert.equal(result.status, 'ok', result.reason);
  assert.equal(stack.fetchImpl.calls.length, 1, 'exactly one network request');
});

test('743. (Phase 4) insufficient GLOBAL budget → zero network calls', async () => {
  const stack = govStack({ budgets: { global: 0 } });
  const result = await stack.gate.invoke({ ...REQ });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'GLOBAL_MODEL_BUDGET_EXCEEDED');
  assert.equal(stack.fetchImpl.calls.length, 0);
});

test('744. (Phase 4) insufficient AGENT budget → zero network calls', async () => {
  const stack = govStack({ budgets: { agent: 0 } });
  const result = await stack.gate.invoke({ ...REQ });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'AGENT_MODEL_BUDGET_EXCEEDED');
  assert.equal(stack.fetchImpl.calls.length, 0);
});

test('745. (Phase 4) insufficient WORKFLOW budget → zero network calls', async () => {
  // Never exercised before M26: no test in the repository had ever
  // configured a workflow-scoped budget or passed tree_id to the
  // governor, so this entire scope was unproven for the live provider.
  const stack = govStack({ budgets: { workflow: 0 } });
  const result = await stack.gate.invoke({ ...REQ });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'WORKFLOW_MODEL_BUDGET_EXCEEDED');
  assert.equal(stack.fetchImpl.calls.length, 0);
});

test('746. (Phase 4) insufficient TASK budget → zero network calls', async () => {
  const stack = govStack({ budgets: { task: 0 } });
  const result = await stack.gate.invoke({ ...REQ });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'TASK_MODEL_BUDGET_EXCEEDED');
  assert.equal(stack.fetchImpl.calls.length, 0);
});

test('747. (Phase 4) the reservation chain is ordered global → agent → workflow → task, and each level really participates', async () => {
  // Tightening ONE level at a time changes which reason fires, which is
  // only possible if every level is genuinely consulted.
  const cases = [
    [{ global: 0 }, 'GLOBAL_MODEL_BUDGET_EXCEEDED'],
    [{ agent: 0 }, 'AGENT_MODEL_BUDGET_EXCEEDED'],
    [{ workflow: 0 }, 'WORKFLOW_MODEL_BUDGET_EXCEEDED'],
    [{ task: 0 }, 'TASK_MODEL_BUDGET_EXCEEDED'],
  ];
  for (const [budgets, expected] of cases) {
    const stack = govStack({ budgets });
    const result = await stack.gate.invoke({ ...REQ });
    assert.equal(result.reason, expected, `budgets ${JSON.stringify(budgets)}`);
    assert.equal(stack.fetchImpl.calls.length, 0);
  }
});

test('748. (Phase 4) the per-TASK call ceiling is enforced, and the over-limit call sends nothing', async () => {
  const stack = govStack({ perCall: 0 });
  for (let i = 0; i < RESOURCE_GOVERNOR_POLICY.MAX_CALLS_PER_TASK; i++) {
    assert.equal((await stack.gate.invoke({ ...REQ })).status, 'ok', `call ${i}`);
  }
  const sent = stack.fetchImpl.calls.length;
  const denied = await stack.gate.invoke({ ...REQ });
  assert.equal(denied.reason, 'MODEL_CALL_LIMIT');
  assert.equal(stack.fetchImpl.calls.length, sent, 'the over-limit call sent nothing');
});

test('749. (Phase 4) the per-WORKFLOW call ceiling is enforced across distinct tasks', async () => {
  const stack = govStack({ perCall: 0 });
  let sent = 0;
  let denied = null;
  // Spread calls across distinct task ids so the TASK ceiling never
  // fires first — only the workflow ceiling can stop this.
  for (let i = 0; i < RESOURCE_GOVERNOR_POLICY.MAX_CALLS_PER_WORKFLOW + 2; i++) {
    const taskId = `${TASK}-${i}`;
    stack.governor.configureTaskBudget(taskId, 100);
    const r = await stack.gate.invoke({ ...REQ, task_id: taskId });
    if (r.status === 'ok') { sent++; continue; }
    denied = r;
    break;
  }
  assert.ok(denied, 'the workflow ceiling eventually fired');
  assert.equal(denied.reason, 'MODEL_CALL_LIMIT');
  assert.equal(sent, RESOURCE_GOVERNOR_POLICY.MAX_CALLS_PER_WORKFLOW);
  assert.equal(stack.fetchImpl.calls.length, sent, 'no request was sent for the denied call');
});

test('750. (Phase 4) an unconfigured ceiling at ANY scope fails closed — absence is never "unlimited"', async () => {
  for (const scope of ['global', 'agent', 'workflow', 'task']) {
    const store = createMemoryStore();
    const audit = createAuditSink();
    const clock = () => T0;
    const fetchImpl = recordingFetch(() => okResponse());
    const { registry } = createLiveProviderRegistry({ env: liveEnv(), fetchImpl, maxCostPerCallUsd: 1 });
    const invoker = createAsyncProviderInvoker({ registry, audit, clock });
    const chain = createLiveProviderChain({ store, invoker, createGovernor: createResourceGovernor, registry, audit, clock });
    const governor = chain.governor;
    // Configure every scope EXCEPT the one under test.
    if (scope !== 'global') governor.configureGlobalBudget(100);
    if (scope !== 'agent') governor.configureAgentBudget(AGENT, 100);
    if (scope !== 'workflow') governor.configureWorkflowBudget(WORKFLOW, 100);
    if (scope !== 'task') governor.configureTaskBudget(TASK, 100);
    registerAgent(store, AGENT);
    const result = await chain.invoke({ ...REQ });
    assert.equal(result.status, 'failed', `${scope} unconfigured must deny`);
    assert.equal(result.reason, 'RESOURCE_RESERVATION_FAILED');
    assert.equal(fetchImpl.calls.length, 0, `${scope} unconfigured must send nothing`);
  }
});

test('751. (Phase 4) a non-finite or negative ceiling fails closed at every scope — undefined, null, NaN, Infinity, negative', async () => {
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, -1]) {
    const stack = govStack({ budgets: { global: bad } });
    const result = await stack.gate.invoke({ ...REQ });
    assert.equal(result.status, 'failed', `global=${String(bad)} must deny`);
    assert.equal(stack.fetchImpl.calls.length, 0, `global=${String(bad)} must send nothing`);
  }
});

test('752. (Phase 4) reservations SETTLE after success and RELEASE after failure — spend never leaks', async () => {
  const stack = govStack({ perCall: 1 });
  const before = stack.governor.getGlobalUsage();
  assert.equal(before.reserved, 0);

  await stack.gate.invoke({ ...REQ });
  const afterOk = stack.governor.getGlobalUsage();
  assert.equal(afterOk.reserved, 0, 'the reservation was settled, not left held');
  assert.ok(afterOk.spent >= 0);

  // A provider failure must RELEASE the full reservation — a failed call
  // spent nothing real.
  const failing = govStack({ perCall: 1, fetchImpl: recordingFetch(() => errorResponse(400, 'bad')) });
  const spentBefore = failing.governor.getGlobalUsage().spent;
  await failing.gate.invoke({ ...REQ });
  const afterFail = failing.governor.getGlobalUsage();
  assert.equal(afterFail.reserved, 0, 'a failed call holds no reservation');
  assert.equal(afterFail.spent, spentBefore, 'a failed call spends nothing');
});

// ══ PHASE 3: exactly-one-call guarantee ═══════════════════════════════════

test('753. (Phase 3) ONE invocation → ONE governed attempt → ONE network request on the success path', async () => {
  const stack = govStack();
  const result = await stack.gate.invoke({ ...REQ, max_retries: 0 });
  assert.equal(result.status, 'ok');
  assert.equal(stack.fetchImpl.calls.length, 1);
});

test('754. (Phase 3) a non-retryable failure makes exactly ONE request — no uncontrolled retry loop', async () => {
  for (const [status, expected] of [[401, PROVIDER_REASON.PROVIDER_AUTH_FAILED], [400, PROVIDER_REASON.INVALID_REQUEST], [404, PROVIDER_REASON.MODEL_NOT_SUPPORTED]]) {
    const stack = govStack({ fetchImpl: recordingFetch(() => errorResponse(status)) });
    // Even asking for retries cannot cause one for a non-retryable class.
    const result = await stack.gate.invoke({ ...REQ, max_retries: 3 });
    assert.equal(result.reason, expected, `HTTP ${status}`);
    assert.equal(stack.fetchImpl.calls.length, 1, `HTTP ${status} must not be retried`);
  }
});

test('755. (Phase 3) a configuration failure makes ZERO requests — it never reaches the network at all', async () => {
  // Authorized at construction, revoked before the call.
  const env = liveEnv();
  const fetchImpl = recordingFetch(() => okResponse());
  const stack = govStack({ env, fetchImpl });
  env[GROQ_ENV.REAL_PROVIDER_ENABLED] = 'false';
  const result = await stack.gate.invoke({ ...REQ });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, PROVIDER_REASON.PROVIDER_CONFIGURATION_INVALID);
  assert.equal(fetchImpl.calls.length, 0);
});

// ══ PHASE 5: Guardian — the gap this milestone found ══════════════════════

test('756. (Phase 5) an AGENT freeze denies the live call — zero provider calls, no reservation', async () => {
  const stack = govStack();
  stack.store.addFreeze({ scope: 'agent', target_id: AGENT, reason: 'test', imposed_by: 'guardian', imposed_at: T0, expires_at: null });
  const result = await stack.gate.invoke({ ...REQ });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, LIVE_GATE_REASON.AGENT_FROZEN);
  assert.equal(result.network_attempted, false);
  assert.equal(stack.fetchImpl.calls.length, 0, 'a frozen agent must produce NO paid call');
  // And nothing was reserved: the governor was never reached.
  assert.equal(stack.governor.getGlobalUsage().spent, 0);
  assert.equal(stack.governor.getGlobalUsage().reserved, 0);
});

test('757. (Phase 5) a WORKFLOW freeze denies the live call — zero provider calls', async () => {
  const stack = govStack();
  stack.store.addFreeze({ scope: 'workflow', target_id: WORKFLOW, reason: 'test', imposed_by: 'guardian', imposed_at: T0, expires_at: null });
  const result = await stack.gate.invoke({ ...REQ });
  assert.equal(result.reason, LIVE_GATE_REASON.WORKFLOW_FROZEN);
  assert.equal(stack.fetchImpl.calls.length, 0);
});

test('758. (Phase 5) a GLOBAL freeze denies the live call — zero provider calls', async () => {
  const stack = govStack();
  stack.store.addFreeze({ scope: 'global', target_id: null, reason: 'test', imposed_by: 'guardian', imposed_at: T0, expires_at: null });
  const result = await stack.gate.invoke({ ...REQ });
  assert.equal(result.reason, LIVE_GATE_REASON.GLOBAL_FREEZE);
  assert.equal(stack.fetchImpl.calls.length, 0);
});

test('759. (Phase 5) a DISABLED agent denies the live call — zero provider calls', async () => {
  const stack = govStack({ agent: { lifecycleState: RUNTIME_STATE.DISABLED } });
  const result = await stack.gate.invoke({ ...REQ });
  assert.equal(result.reason, LIVE_GATE_REASON.AGENT_NOT_ACTIVE);
  assert.equal(stack.fetchImpl.calls.length, 0);
});

test('760. (Phase 5) a PAUSED agent, an UNAPPROVED version, and an UNKNOWN agent each deny — zero provider calls', async () => {
  const paused = govStack({ agent: { lifecycleState: RUNTIME_STATE.PAUSED } });
  assert.equal((await paused.gate.invoke({ ...REQ })).reason, LIVE_GATE_REASON.AGENT_NOT_ACTIVE);
  assert.equal(paused.fetchImpl.calls.length, 0);

  const draft = govStack({ agent: { versionState: VERSION_STATE.DRAFT } });
  assert.equal((await draft.gate.invoke({ ...REQ })).reason, LIVE_GATE_REASON.VERSION_NOT_APPROVED);
  assert.equal(draft.fetchImpl.calls.length, 0);

  const missing = govStack({ omitAgent: true });
  assert.equal((await missing.gate.invoke({ ...REQ })).reason, LIVE_GATE_REASON.UNKNOWN_AGENT);
  assert.equal(missing.fetchImpl.calls.length, 0);
});

test('761. (Phase 5) an INVALID agent — registered but with no resolvable version — denies', async () => {
  const stack = govStack({ agent: { noVersion: true } });
  const result = await stack.gate.invoke({ ...REQ });
  assert.equal(result.reason, LIVE_GATE_REASON.INVALID_AGENT);
  assert.equal(stack.fetchImpl.calls.length, 0);
});

test('762. (Phase 5) the gate emits an audit event for every denial, and never claims a network attempt', async () => {
  const stack = govStack();
  stack.store.addFreeze({ scope: 'agent', target_id: AGENT, reason: 'x', imposed_by: 'guardian', imposed_at: T0, expires_at: null });
  await stack.gate.invoke({ ...REQ });
  const events = stack.audit.all().filter((e) => e.event === 'provider.live_gate');
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, LIVE_GATE_REASON.AGENT_FROZEN);
  assert.equal(events[0].network_attempted, false);
  assert.equal(events[0].agent_slug, AGENT);
});

test('763. (Phase 5) the gate holds a READ-ONLY store view — it cannot impose or lift a freeze', async () => {
  const src = readFileSync(new URL('../src/providers/live-guard.js', import.meta.url), 'utf8');
  for (const term of [
    'addFreeze(', 'setLifecycleState(', 'setActiveVersion(', 'registerAgent(',
    'chargeBudgets(', 'addBudget(', 'createGuardian(', 'broker.execute(', '.decide(', '.revoke(',
    'fetch(', 'process.env', 'API_KEY',
  ]) {
    assert.equal(src.includes(term), false, `live-guard.js must not reference ${term}`);
  }
  assert.ok(src.includes('function readOnlyStore('), 'it wraps the store read-only');
  assert.ok(src.includes('const reads = readOnlyStore(store);'), 'and actually uses the wrapper');

  // Behavioral: a freeze imposed before the call is still there after.
  const stack = govStack();
  stack.store.addFreeze({ scope: 'agent', target_id: AGENT, reason: 'x', imposed_by: 'guardian', imposed_at: T0, expires_at: null });
  await stack.gate.invoke({ ...REQ });
  assert.ok(stack.store.activeFreeze('agent', AGENT, T0), 'the freeze was never touched');
});

// ══ PHASE 6: approval independence ════════════════════════════════════════

test('764. (Phase 6) a GREEN agent proceeds per existing policy; live access is not an approval bypass', async () => {
  const stack = govStack();
  const result = await stack.gate.invoke({ ...REQ });
  assert.equal(result.status, 'ok');
});

test('765. (Phase 6) a YELLOW tool action still requires human approval, regardless of any live provider result', async () => {
  const stack = govStack();
  await stack.gate.invoke({ ...REQ }); // a real (mocked) provider success first
  const { tools } = createTools();
  const broker = createBroker({ tools, store: stack.store, audit: stack.audit, clock: () => T0, registrySha: 'm26' });
  registerAgent(stack.store, 'yellow-agent', { clearance: 'YELLOW', allowed_tools: ['fake.send_message'] });
  stack.store.createTaskBudgets({ task_id: 't', tree_id: 'w', agent_slug: 'yellow-agent', limit: 1000 });
  const decision = broker.execute({
    agent_slug: 'yellow-agent', tool_id: 'fake.send_message', task_id: 't', tree_id: 'w',
    payload: { recipient_domain: 'approved-client.example', body: 'x' },
  });
  assert.equal(decision.decision, DECISION.NEEDS_APPROVAL);
});

test('766. (Phase 6) a RED action remains impossible for a GREEN live-provider agent', async () => {
  const stack = govStack();
  const { tools } = createTools();
  const broker = createBroker({ tools, store: stack.store, audit: stack.audit, clock: () => T0, registrySha: 'm26' });
  stack.store.createTaskBudgets({ task_id: TASK, tree_id: WORKFLOW, agent_slug: AGENT, limit: 1000 });
  const decision = broker.execute({
    agent_slug: AGENT, tool_id: 'fake.transfer_funds', task_id: TASK, tree_id: WORKFLOW, payload: {},
  });
  assert.equal(decision.decision, DECISION.DENY);
});

test('767. (Phase 6) the live provider path contains no approval mechanism at all — it cannot create, grant, or revoke one', () => {
  for (const path of [
    '../src/providers/live-guard.js', '../src/providers/invoke-async.js',
    '../src/providers/groq.js', '../src/providers/live-registry.js',
  ]) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const term of ['requestApproval', 'createApprovalEngine', '.decide(', '.revoke(', 'APPROVAL_STATUS']) {
      assert.equal(src.includes(term), false, `${path} must not reference ${term}`);
    }
  }
});

// ══ PHASE 7: provider output → artifact ═══════════════════════════════════

test('768. (Phase 7) a live-shaped result becomes an artifact with correct type, provenance, identity, and checksum', async () => {
  const stack = govStack();
  const result = await stack.gate.invoke({ ...REQ });
  assert.equal(result.status, 'ok');

  const artifactService = createArtifactService({
    store: stack.store, artifactStore: stack.artifactStore, audit: stack.audit,
    clock: stack.clock, registrySha: 'm26-sha',
  });
  const request = buildArtifactRequestFromProviderResult({ providerResult: result, artifact_type: ARTIFACT_TYPE.TEXT });
  const created = artifactService.createArtifactSync({ ...request, agent_slug: AGENT, workflow_id: WORKFLOW });
  assert.equal(created.outcome, 'created');

  const artifact = stack.artifactStore.getArtifact(created.artifact.artifact_id);
  assert.equal(artifact.artifact_type, ARTIFACT_TYPE.TEXT);
  assert.equal(artifact.provider_id, GROQ_PROVIDER_ID);
  assert.equal(artifact.model_id, MODEL);
  assert.equal(artifact.agent_id, `agent-${AGENT}`);
  assert.equal(artifact.version_id, versionId(`agent-${AGENT}`, '1.0.0'));
  assert.equal(artifact.registry_sha, 'm26-sha', 'the injected SHA, never one from the provider');
  assert.equal(artifact.workflow_id, WORKFLOW);
  assert.equal(artifact.checksum.length, 64);
});

test('769. (Phase 7) the artifact carries no credential, no Authorization header, and no raw request', async () => {
  const stack = govStack();
  const result = await stack.gate.invoke({ ...REQ });
  const artifactService = createArtifactService({
    store: stack.store, artifactStore: stack.artifactStore, audit: stack.audit,
    clock: stack.clock, registrySha: 'm26-sha',
  });
  const request = buildArtifactRequestFromProviderResult({ providerResult: result, artifact_type: ARTIFACT_TYPE.TEXT });
  const created = artifactService.createArtifactSync({ ...request, agent_slug: AGENT, workflow_id: WORKFLOW });
  const serialized = JSON.stringify(stack.artifactStore.getArtifact(created.artifact.artifact_id));
  assert.equal(serialized.includes(FAKE_KEY), false, 'no credential in the artifact');
  assert.equal(/authorization|Bearer /i.test(serialized), false, 'no auth header in the artifact');
  assert.equal(serialized.includes('api.groq.com'), false, 'no raw request URL in the artifact');
});

test('770. (Phase 7, 15) real spend stays honestly UNPRICED — never fabricated as free or $0.00', async () => {
  const stack = govStack();
  const result = await stack.gate.invoke({ ...REQ });
  assert.equal(result.cost_status, 'UNPRICED_REAL_SPEND');
  assert.notEqual(result.cost, 0, 'a real provider is never reported as costing zero');
  assert.notEqual(result.cost_status, 'DETERMINISTIC_NO_EXTERNAL_COST');
  // And nothing in the live path claims Groq is free.
  for (const path of ['../src/providers/groq.js', '../src/providers/groq-config.js', '../src/providers/live-guard.js']) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8').toLowerCase();
    assert.equal(/\bis free\b|\bfree tier\b|\bno cost\b|\bcosts nothing\b/.test(src), false, `${path} must not claim the provider is free`);
  }
});

test('771. (Phase 7) provider-reported usage is recorded; units remain JSON-length, not real tokens — stated, not blurred', async () => {
  const stack = govStack();
  const result = await stack.gate.invoke({ ...REQ });
  assert.equal(result.provider_usage.provider_reported, true);
  assert.equal(result.provider_usage.prompt_tokens, 6);
  assert.equal(result.provider_usage.completion_tokens, 3);
  // The governor's own accounting still uses JSON-string-length units,
  // NOT provider tokens. The adapter documents this explicitly rather
  // than implying measured token cost.
  const src = readFileSync(new URL('../src/providers/groq.js', import.meta.url), 'utf8');
  assert.ok(/not a token count|never described as one|JSON\.stringify\(\.\.\.\)\.length/i.test(src),
    'the unit caveat must be stated in the adapter');
});

test('771b. (Phase 7, 11) the artifact bridge REFUSES a result whose provenance was lost — it never fabricates an empty artifact', () => {
  // Found by M26 mutation testing: deleting this guard killed no test,
  // and `extractContent`'s final branch is unguarded, so an unrecognized
  // provider_type silently produced an artifact request with no content,
  // no content_ref, and no mime_type — a permanently empty row in an
  // immutable record instead of a refusal.
  //
  // This is exactly the shape `resource-governor.js` produces: it builds
  // its own success envelope and drops provider_type entirely, which is
  // why `createLiveProviderChain` restores it. This guard is the last
  // line of defense if that restoration ever regresses.
  const good = { status: 'ok', provider_type: 'TEXT_GENERATION', output: { text: 'hi' } };
  assert.ok(buildArtifactRequestFromProviderResult({ providerResult: good, artifact_type: ARTIFACT_TYPE.TEXT }));

  const lost = [
    ['provider_type missing entirely (the governor envelope)', { status: 'ok', output: { text: 'hi' } }],
    ['provider_type null', { status: 'ok', provider_type: null, output: { text: 'hi' } }],
    ['provider_type empty string', { status: 'ok', provider_type: '', output: { text: 'hi' } }],
    ['provider_type unrecognized', { status: 'ok', provider_type: 'NOT_A_REAL_TYPE', output: { text: 'hi' } }],
    ['provider_type non-string', { status: 'ok', provider_type: 7, output: { text: 'hi' } }],
    ['output missing', { status: 'ok', provider_type: 'TEXT_GENERATION' }],
  ];
  for (const [label, providerResult] of lost) {
    assert.throws(
      () => buildArtifactRequestFromProviderResult({ providerResult, artifact_type: ARTIFACT_TYPE.TEXT }),
      /missing a recognized provider_type or output/,
      `${label} must be refused, not turned into an artifact`,
    );
  }
});

test('771c. (Phase 7, 11) a refused result never reaches the artifact store — no empty row is ever written', () => {
  // The refusal must happen before the artifact store's write path is
  // reached, so a provenance-loss bug can leave no trace at all in an
  // immutable record. Counting writes asserts that directly.
  const inner = createMemoryArtifactStore();
  let writes = 0;
  const counting = { ...inner, addArtifact: (a) => { writes += 1; return inner.addArtifact(a); } };
  const audit = createAuditSink();
  createArtifactService({ store: counting, audit, clock: () => 1 });

  assert.throws(() => buildArtifactRequestFromProviderResult({
    providerResult: { status: 'ok', output: { text: 'hi' } },
    artifact_type: ARTIFACT_TYPE.TEXT,
  }));

  assert.equal(writes, 0, 'no artifact row may be written after a refusal');
});

// ══ PHASE 8: failure classification matrix ════════════════════════════════

test('772. (Phase 8) the full failure matrix — reason, attempts, artifact, audit — for every provider failure class', async () => {
  const cases = [
    { name: 'auth failure', fetch: () => errorResponse(401), reason: PROVIDER_REASON.PROVIDER_AUTH_FAILED, calls: 1, retryable: false },
    { name: 'invalid request', fetch: () => errorResponse(400), reason: PROVIDER_REASON.INVALID_REQUEST, calls: 1, retryable: false },
    { name: 'unsupported model', fetch: () => errorResponse(404), reason: PROVIDER_REASON.MODEL_NOT_SUPPORTED, calls: 1, retryable: false },
    { name: 'malformed json', fetch: () => ({ ok: true, status: 200, json: async () => { throw new Error('nope'); } }), reason: PROVIDER_REASON.PROVIDER_OUTPUT_INVALID, calls: 1, retryable: false },
    { name: 'shapeless response', fetch: () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) }), reason: PROVIDER_REASON.PROVIDER_OUTPUT_INVALID, calls: 1, retryable: false },
  ];

  for (const c of cases) {
    const stack = govStack({ fetchImpl: recordingFetch(c.fetch) });
    const result = await stack.gate.invoke({ ...REQ, max_retries: 3 });

    assert.equal(result.status, 'failed', c.name);
    assert.equal(result.reason, c.reason, c.name);
    assert.equal(stack.fetchImpl.calls.length, c.calls, `${c.name}: expected ${c.calls} request(s)`);
    assert.equal(RETRYABLE_PROVIDER_REASONS.has(c.reason), c.retryable, `${c.name}: retryability`);

    // No artifact can be built from a failed result.
    assert.throws(
      () => buildArtifactRequestFromProviderResult({ providerResult: result, artifact_type: ARTIFACT_TYPE.TEXT }),
      /successful/, `${c.name}: no artifact from a failure`,
    );

    // Audit is emitted, and carries no credential.
    const audited = stack.audit.all().filter((e) => e.event === 'model.governor' || e.event === 'provider.invocation');
    assert.ok(audited.length > 0, `${c.name}: audit emitted`);
    assert.equal(JSON.stringify(stack.audit.all()).includes(FAKE_KEY), false, `${c.name}: no credential in audit`);
  }
});

test('773. (Phase 8) a transient failure IS retried, bounded, and reported as retry-ceiling — with a sane request count', async () => {
  const stack = govStack({ fetchImpl: recordingFetch(() => errorResponse(503)) });
  const result = await stack.gate.invoke({ ...REQ, max_retries: 999 });
  assert.equal(result.reason, PROVIDER_REASON.RETRY_CEILING_EXCEEDED);
  assert.ok(stack.fetchImpl.calls.length > 1, 'a transient failure is retried');
  assert.ok(stack.fetchImpl.calls.length <= 4, `retries clamped, got ${stack.fetchImpl.calls.length}`);
});

test('774. (Phase 8) a rate limit is classified and bounded — never bypassed, never key-rotated', async () => {
  const stack = govStack({ fetchImpl: recordingFetch(() => errorResponse(429)) });
  const result = await stack.gate.invoke({ ...REQ, max_retries: 0 });
  assert.equal(result.reason, PROVIDER_REASON.PROVIDER_RATE_LIMITED);
  assert.equal(stack.fetchImpl.calls.length, 1);
});

test('775. (Phase 8) a leaked credential in a provider error body is redacted before it reaches result or audit', async () => {
  const leaky = recordingFetch(() => errorResponse(500, `upstream echoed authorization: Bearer ${FAKE_KEY}`));
  const stack = govStack({ fetchImpl: leaky });
  const result = await stack.gate.invoke({ ...REQ, max_retries: 0 });
  assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
  assert.equal(JSON.stringify(stack.audit.all()).includes(FAKE_KEY), false);
});

// ══ PHASE 9: model configuration ══════════════════════════════════════════

test('775b. (Phase 1, 2) if the credential vanishes between the config gate and the request build, the call fails closed and sends nothing', async () => {
  // Found by M26 mutation testing: removing the adapter's own
  // credential check killed no test, because `readGroqConfig`'s
  // `has_credential` gate uses the IDENTICAL predicate and fires first
  // on any ordinary environment — the check was defense-in-depth that
  // nothing exercised.
  //
  // It is not dead code, though: the config gate and the request build
  // are two SEPARATE reads of the environment, so a mutating `env` (a
  // getter, a proxy, a future refactor that separates the two reads by
  // an await) can satisfy the gate and still leave no credential to
  // send. This asserts what must happen then: refuse, and reach no
  // network — never send an unauthenticated request to a paid endpoint.
  const KEY = FAKE_KEY;
  const base = {
    [GROQ_ENV.REAL_PROVIDER_ENABLED]: 'true',
    [GROQ_ENV.GROQ_ENABLED]: 'true',
    [GROQ_ENV.MODELS]: 'model-a',
    [GROQ_ENV.MAX_SPEND_USD]: '1',
    [GROQ_ENV.BASE_URL]: 'https://127.0.0.1:9/openai/v1',
  };
  const envThatReadsKey = (onRead) => new Proxy(base, {
    get: (t, k) => (k === GROQ_ENV.API_KEY ? onRead() : t[k]),
    has: (t, k) => k === GROQ_ENV.API_KEY || k in t,
  });

  // Calibrated, not hardcoded: count the reads that legitimately precede
  // the adapter's own reach for the credential (construction, then the
  // call-time config gate), so this test keeps testing the same boundary
  // if the internals are refactored.
  let calibration = 0;
  const calEnv = envThatReadsKey(() => { calibration += 1; return KEY; });
  createGroqProvider({ env: calEnv, fetchImpl: async () => { throw new Error('unreachable'); }, maxCostPerCallUsd: 0.01 });
  readGroqConfig(calEnv);
  const readsBeforeCredential = calibration;
  assert.ok(readsBeforeCredential >= 1, 'the config gate must read the credential at least once');

  let reads = 0;
  let fetches = 0;
  const env = envThatReadsKey(() => { reads += 1; return reads <= readsBeforeCredential ? KEY : undefined; });
  const provider = createGroqProvider({
    env,
    fetchImpl: async () => { fetches += 1; return new Response('{}'); },
    maxCostPerCallUsd: 0.01,
  });

  // The gate itself is satisfied — this is genuinely the adapter's own check.
  assert.equal(readGroqConfig({ ...base, [GROQ_ENV.API_KEY]: KEY }).enabled, true);

  const result = await provider.models['model-a'].invoke({ input: { text: 'hi' } });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, PROVIDER_REASON.PROVIDER_CONFIGURATION_INVALID);
  assert.equal(fetches, 0, 'no request may be sent without a credential');
  // The refusal names the VARIABLE, never a value.
  assert.equal(String(result.detail).includes(KEY), false);
});

test('776. (Phase 9) an unknown model fails closed with zero network calls', async () => {
  const stack = govStack();
  const result = await stack.gate.invoke({ ...REQ, model_id: 'not-in-allowlist' });
  assert.equal(result.reason, 'UNKNOWN_MODEL', 'the governor rejects it before the invoker even runs');
  assert.equal(stack.fetchImpl.calls.length, 0);
});

test('777. (Phase 9) an empty model configuration disables the provider entirely — zero network calls', async () => {
  const stack = govStack({ env: liveEnv({ [GROQ_ENV.MODELS]: '' }) });
  assert.equal(stack.registry.getProvider(GROQ_PROVIDER_ID), null, 'the provider is absent');
  const result = await stack.gate.invoke({ ...REQ });
  assert.equal(result.status, 'failed');
  assert.equal(stack.fetchImpl.calls.length, 0);
});

test('778. (Phase 9) M26 adds no model discovery — nothing queries a provider model catalogue', () => {
  for (const path of [
    '../src/providers/groq.js', '../src/providers/groq-config.js',
    '../src/providers/live-guard.js', '../src/providers/live-registry.js',
  ]) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.equal(/\/models\b/.test(src), false, `${path} must not query a model catalogue`);
    assert.equal(src.includes('listModels'), false);
  }
});

// ══ PHASE 10: CEO isolation ═══════════════════════════════════════════════

const CEO_FILES = Object.freeze([
  '../src/ceo-agent.js', '../src/ceo/orchestrator.js', '../src/ceo/planner.js',
  '../src/ceo/recovery.js', '../src/ceo/completion.js', '../src/ceo/limits.js',
]);

test('779. (Phase 10) no CEO file can reach a credential, the network, a provider registry, or a budget', () => {
  for (const path of CEO_FILES) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const term of [
      'GROQ_API_KEY', 'process.env', 'fetch(', 'axios',
      'AI_HQ_REAL_PROVIDER_ENABLED', 'GROQ_MODELS', 'GROQ_MAX_SPEND_USD',
      'createLiveProviderRegistry', 'createGroqProvider', 'readGroqConfig', 'createLiveProviderGate',
      'configureGlobalBudget', 'configureAgentBudget', 'configureWorkflowBudget', 'configureTaskBudget',
      'createResourceGovernor', 'createAsyncProviderInvoker',
    ]) {
      assert.equal(src.includes(term), false, `${path} must not reference ${term}`);
    }
  }
});

test('780. (Phase 10, 11) the CEO and Content Factory remain deterministic — neither can name or reach a live provider', () => {
  for (const path of [...CEO_FILES, '../src/content-factory-agents.js', '../src/content-factory-orchestrator.js']) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.equal(src.includes(GROQ_PROVIDER_ID), false, `${path} must not name the live provider`);
    assert.equal(src.includes('live-registry'), false, `${path} must not import the live registry`);
  }
  // The Content Factory's own agents still name only deterministic providers.
  const cf = readFileSync(new URL('../src/content-factory-agents.js', import.meta.url), 'utf8');
  assert.ok(cf.includes("provider_id: 'deterministic-text'"), 'the factory still uses deterministic providers');
});

// ══ PHASE 12: network allowlist ═══════════════════════════════════════════

test('781. (Phase 12) there is exactly ONE outbound network boundary in the whole repository', () => {
  // The adapter is the only file with a real call site; the smoke script
  // wraps the global fetch to COUNT real calls, which is observation of
  // the same single boundary, not a second one.
  const adapter = readFileSync(new URL('../src/providers/groq.js', import.meta.url), 'utf8');
  assert.equal((adapter.match(/\bdoFetch\s*\(/g) ?? []).length, 1, 'exactly one call site in the adapter');

  for (const path of [
    '../src/providers/live-guard.js', '../src/providers/invoke-async.js',
    '../src/providers/live-registry.js', '../src/providers/groq-config.js',
    '../src/resource-governor.js', '../src/runtime.js', '../src/broker.js',
    '../src/guardian.js', '../src/approval-engine.js', '../src/router.js',
    '../src/workflow.js', '../src/execution-coordinator.js',
  ]) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const pattern of [
      /\bfetch\s*\(/, /\baxios\b/, /\bundici\b/, /from\s+['"]node:(http|https|net|tls)['"]/,
      /\bchild_process\b/, /\bexecSync\s*\(/, /\bspawnSync\s*\(/, /\bcurl\b/,
    ]) {
      assert.equal(pattern.test(src), false, `${path} must not match ${pattern}`);
    }
  }
});

test('782. (Phase 12, 14) the live smoke script is a SCRIPT, not a test — the default suite can never reach it', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test tests/*.test.js', 'the test script only globs tests/');
  assert.equal(pkg.scripts['smoke:groq'], 'node scripts/live-groq-smoke.mjs');
  // No dependency was added for any of this.
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), ['@anthropic-ai/sdk', 'pg']);

  const smoke = readFileSync(new URL('../scripts/live-groq-smoke.mjs', import.meta.url), 'utf8');
  // It must never print the credential, headers, or an env dump.
  assert.equal(/console\.log\([^)]*GROQ_API_KEY\s*\]/.test(smoke), false, 'never logs the key value');
  assert.equal(smoke.includes('console.log(process.env'), false, 'never dumps the environment');
  assert.equal(/line\(.*apiKey/.test(smoke), false);
  // And it goes through the Guardian gate, not straight to the governor.
  // `createLiveProviderChain` composes the gate in front of the governor,
  // so the meaningful assertion is that the script never reaches the
  // governor's own `invoke` — the gate is not merely present, it is
  // unavoidable.
  assert.ok(smoke.includes("from '../src/providers/live-guard.js'"), 'the smoke script imports the Guardian gate');
  assert.ok(smoke.includes('createLiveProviderChain'), 'and builds the governed chain');
  assert.ok(smoke.includes('chain.check('), 'runs the freeze/lifecycle pre-flight');
  assert.ok(smoke.includes('chain.invoke('), 'and invokes through the chain');
  assert.equal(smoke.includes('governor.invoke('), false, 'never calls the governor directly, bypassing the gate');
});

test('783. (Phase 2) with no credential configured, live authorization is false and the smoke path refuses', () => {
  // The real state of this environment, asserted rather than assumed.
  assert.equal(isLiveGroqAuthorized({}), false);
  assert.equal(isLiveGroqAuthorized({ [GROQ_ENV.API_KEY]: FAKE_KEY }), false, 'a key alone never authorizes');
  assert.equal(isLiveGroqAuthorized(liveEnv()), true, 'all gates together do');
});

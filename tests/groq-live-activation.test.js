/**
 * MILESTONE 27 — OPERATOR-SUPPLIED LIVE GROQ ACTIVATION
 *
 * M26 proved the governed live path fails closed everywhere it should.
 * M27 asks the last question before real money moves: is the
 * OPERATOR-FACING activation itself safe — the ceiling they configure,
 * the model they name, the call budget they are promised?
 *
 * Asking it found three real defects, all fixed and all covered here:
 *
 *   1. `GROQ_MAX_SPEND_USD=0` OPENED the gate. It reads as "spend
 *      nothing"; it produced a per-call reservation of 0, which makes
 *      the governor's `spent + reserved + 0 > limit` test false forever.
 *      Measured: 25 of 25 real calls went out under a 0.01 USD budget.
 *   2. The smoke script silently took `models[0]` when GROQ_MODELS named
 *      several — a substitution the operator could not see, on the one
 *      variable that decides what their money is spent on.
 *   3. The exactly-one-call check ran only on the SUCCESS path, so a
 *      failed run that retried — the case where money leaves more than
 *      once — reported nothing.
 *
 * NO REAL CREDENTIAL IS USED ANYWHERE IN THIS FILE. Every request is
 * observed through an injected `fetchImpl`; nothing reaches a network.
 *
 * Constitution: sections 13, 18, 20, 22, 23.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAuditSink } from '../src/audit.js';
import { createMemoryStore } from '../src/store.js';
import { createMemoryArtifactStore } from '../src/artifact-store.js';
import { createArtifactService } from '../src/artifact-service.js';
import { createResourceGovernor } from '../src/resource-governor.js';
import { makeAgent, makeAgentVersion, VERSION_STATE, RUNTIME_STATE, versionId } from '../src/agents.js';
import { ARTIFACT_TYPE } from '../src/artifacts.js';
import { PROVIDER_REASON } from '../src/providers/contracts.js';
import { createAsyncProviderInvoker } from '../src/providers/invoke-async.js';
import { buildArtifactRequestFromProviderResult } from '../src/providers/artifact-bridge.js';
import { createLiveProviderRegistry } from '../src/providers/live-registry.js';
import { createLiveProviderChain, LIVE_GATE_REASON } from '../src/providers/live-guard.js';
import { verifyCallBudget, enforceCallBudget, CALL_BUDGET_VIOLATION, MAX_LIVE_REQUESTS } from '../src/providers/live-call-budget.js';
import { GROQ_PROVIDER_ID, createGroqProvider } from '../src/providers/groq.js';
import {
  GROQ_ENV, GROQ_CONFIG_REASON, readGroqConfig, parseSpendCeiling,
  selectSingleModel, AMBIGUOUS_MODEL_SELECTION,
} from '../src/providers/groq-config.js';

const T0 = 17_000_000;

/** A sentinel, never a real key. Long enough to exercise `redact()`'s
 * 8-character minimum, and shaped like a Groq key so a containment
 * check that only matches on shape would still catch it. */
const SENTINEL = 'gsk_TESTONLY_M27_000000000000000000000000';

const MODEL = 'test-model-m27';
const AGENT = 'live-activation-agent';
const WORKFLOW = 'wf-live-activation';
const TASK = 'task-live-activation';

function liveEnv(overrides = {}) {
  return {
    [GROQ_ENV.REAL_PROVIDER_ENABLED]: 'true',
    [GROQ_ENV.API_KEY]: SENTINEL,
    [GROQ_ENV.MODELS]: MODEL,
    [GROQ_ENV.MAX_SPEND_USD]: '0.05',
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

const okResponse = (text = 'AI-HQ LIVE TEST OK', extra = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    id: 'req-m27', model: MODEL,
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 },
    ...extra,
  }),
});

const errorResponse = (status, body = 'err') => ({
  ok: false, status, text: async () => body, json: async () => ({}),
});

function registerAgent(store, slug = AGENT, o = {}) {
  const agentId = `agent-${slug}`;
  const state = o.versionState ?? VERSION_STATE.APPROVED;
  store.addAgentVersion(makeAgentVersion({
    agent_id: agentId, version: '1.0.0', purpose: 'm27 fixture', department: 'internal',
    state, clearance: 'GREEN', allowed_tools: [],
    limits: {}, input_contract: {}, output_contract: {}, created_at: 0,
    approved_by: state === VERSION_STATE.APPROVED ? 'founder' : null,
    approved_at: state === VERSION_STATE.APPROVED ? 0 : null,
  }));
  store.registerAgent(makeAgent({
    id: agentId, slug, name: slug,
    lifecycle_state: o.lifecycleState ?? RUNTIME_STATE.ACTIVE,
    active_version_id: versionId(agentId, '1.0.0'),
  }));
  return agentId;
}

/** The real M27 activation stack — the SAME chain the smoke script
 * uses. No second path is constructed for testing. */
function stack(o = {}) {
  const store = createMemoryStore();
  const artifactStore = createMemoryArtifactStore();
  const audit = createAuditSink();
  const clock = o.clock ?? (() => T0);
  const fetchImpl = o.fetchImpl ?? recordingFetch(() => okResponse());
  const { registry, groq } = createLiveProviderRegistry({
    env: o.env ?? liveEnv(), fetchImpl, maxCostPerCallUsd: o.perCall,
  });
  const invoker = createAsyncProviderInvoker({ registry, audit, clock });
  const chain = createLiveProviderChain({
    store, invoker, createGovernor: createResourceGovernor, registry, audit, clock,
  });
  const b = { global: 100, agent: 100, workflow: 100, task: 100, ...(o.budgets ?? {}) };
  chain.governor.configureGlobalBudget(b.global);
  chain.governor.configureAgentBudget(AGENT, b.agent);
  chain.governor.configureWorkflowBudget(WORKFLOW, b.workflow);
  chain.governor.configureTaskBudget(TASK, b.task);
  if (!o.omitAgent) registerAgent(store, AGENT, o.agent ?? {});
  return { store, artifactStore, audit, clock, fetchImpl, registry, groq, invoker, chain };
}

const REQ = Object.freeze({
  provider_id: GROQ_PROVIDER_ID, model_id: MODEL,
  input: { text: 'Reply with exactly: AI-HQ LIVE TEST OK' },
  max_retries: 0, agent_slug: AGENT, tree_id: WORKFLOW, task_id: TASK,
});

const SMOKE = readFileSync(new URL('../scripts/live-groq-smoke.mjs', import.meta.url), 'utf8');

// ══ THE ZERO-CEILING DEFECT ═══════════════════════════════════════════════

test('784. (M27 defect) a ZERO spend ceiling fails closed — it never means "free", and never registers the provider', () => {
  for (const zero of ['0', '0.0', '0.00', '-0', ' 0 ']) {
    const config = readGroqConfig(liveEnv({ [GROQ_ENV.MAX_SPEND_USD]: zero }));
    assert.equal(config.enabled, false, `ceiling ${JSON.stringify(zero)} must not enable the provider`);
    assert.equal(config.reason, GROQ_CONFIG_REASON.INVALID_SPEND_CEILING);
    assert.equal(config.max_spend_usd, null);
  }
  // And the registry refuses to include it, so there is no adapter to call.
  const { registry, groq } = createLiveProviderRegistry({
    env: liveEnv({ [GROQ_ENV.MAX_SPEND_USD]: '0' }),
    fetchImpl: () => { throw new Error('unreachable'); },
  });
  assert.equal(groq.included, false);
  assert.equal(registry.getProvider(GROQ_PROVIDER_ID), null);
});

test('785. (M27 defect) a zero ceiling produces ZERO network calls — the exact scenario that previously sent 25', async () => {
  // Before the fix this configuration opened the gate, gave every model a
  // per-call reservation of 0, and let an unbounded number of real calls
  // through a 0.01 USD global budget. Now nothing is registered at all.
  const fetchImpl = recordingFetch(() => okResponse());
  const s = stack({ env: liveEnv({ [GROQ_ENV.MAX_SPEND_USD]: '0' }), fetchImpl, budgets: { global: 0.01 } });
  assert.equal(s.groq.included, false);

  for (let i = 0; i < 25; i++) {
    const r = await s.chain.invoke({ ...REQ });
    assert.notEqual(r.status, 'ok', 'no call may succeed under a zero ceiling');
  }
  assert.equal(fetchImpl.calls.length, 0, 'zero real network calls, 25 attempts');
});

test('786. (M27 defect) an ENABLED Groq provider always reserves STRICTLY MORE THAN ZERO per call', () => {
  // The invariant that makes every budget enforceable. A reservation of
  // zero makes `spent + reserved + amount > limit` false forever.
  for (const ceiling of ['0.0001', '0.05', '1', '1000']) {
    const { registry, groq } = createLiveProviderRegistry({
      env: liveEnv({ [GROQ_ENV.MAX_SPEND_USD]: ceiling }),
      fetchImpl: () => { throw new Error('unreachable'); },
    });
    assert.equal(groq.included, true);
    assert.ok(registry.getModel(GROQ_PROVIDER_ID, MODEL).max_cost_per_call > 0,
      `ceiling ${ceiling} must yield a positive per-call reservation`);
  }
  // An explicitly-passed zero is refused too — it falls back to the
  // configured ceiling rather than being accepted as a reservation.
  const provider = createGroqProvider({ env: liveEnv(), fetchImpl: () => {}, maxCostPerCallUsd: 0 });
  assert.ok(provider.models[MODEL].max_cost_per_call > 0);
});

test('787. (M27) a positive ceiling is still consulted BEFORE the network — the budget is real, not decorative', async () => {
  // perCall 10 against a global budget of 1: the reservation cannot fit.
  const fetchImpl = recordingFetch(() => okResponse());
  const s = stack({ fetchImpl, perCall: 10, budgets: { global: 1 } });
  const r = await s.chain.invoke({ ...REQ });
  assert.notEqual(r.status, 'ok');
  assert.match(String(r.reason), /BUDGET_EXCEEDED/);
  assert.equal(fetchImpl.calls.length, 0, 'the ceiling is checked before any egress');
});

// ══ FAIL-CLOSED GATES — every one, zero network calls ═════════════════════

test('788. (M27) every fail-closed condition refuses BEFORE the network — key, model, ceiling, provider config', async () => {
  const cases = [
    ['key missing', { [GROQ_ENV.API_KEY]: undefined }, GROQ_CONFIG_REASON.NO_CREDENTIAL],
    ['key empty', { [GROQ_ENV.API_KEY]: '   ' }, GROQ_CONFIG_REASON.NO_CREDENTIAL],
    ['model missing', { [GROQ_ENV.MODELS]: undefined }, GROQ_CONFIG_REASON.NO_MODELS_CONFIGURED],
    ['model empty', { [GROQ_ENV.MODELS]: '  ,  ' }, GROQ_CONFIG_REASON.NO_MODELS_CONFIGURED],
    ['ceiling missing', { [GROQ_ENV.MAX_SPEND_USD]: undefined }, GROQ_CONFIG_REASON.INVALID_SPEND_CEILING],
    ['ceiling malformed', { [GROQ_ENV.MAX_SPEND_USD]: 'abc' }, GROQ_CONFIG_REASON.INVALID_SPEND_CEILING],
    ['ceiling zero', { [GROQ_ENV.MAX_SPEND_USD]: '0' }, GROQ_CONFIG_REASON.INVALID_SPEND_CEILING],
    ['ceiling negative', { [GROQ_ENV.MAX_SPEND_USD]: '-1' }, GROQ_CONFIG_REASON.INVALID_SPEND_CEILING],
    ['ceiling infinite', { [GROQ_ENV.MAX_SPEND_USD]: 'Infinity' }, GROQ_CONFIG_REASON.INVALID_SPEND_CEILING],
  ];
  for (const [label, override, expected] of cases) {
    const env = liveEnv(override);
    // An `undefined` override means "this variable is ABSENT", which is a
    // different state from "present and empty" — both are tested above.
    for (const k of Object.keys(override)) if (override[k] === undefined) delete env[k];

    const config = readGroqConfig(env);
    assert.equal(config.enabled, false, `${label} must fail closed`);
    assert.equal(config.reason, expected, label);

    const fetchImpl = recordingFetch(() => okResponse());
    const s = stack({ env, fetchImpl });
    const r = await s.chain.invoke({ ...REQ });
    assert.notEqual(r.status, 'ok', label);
    assert.equal(fetchImpl.calls.length, 0, `${label} must reach no network`);
  }
});

test('789. (M27) a model outside GROQ_MODELS is refused with zero network calls — no substitution, ever', async () => {
  const fetchImpl = recordingFetch(() => okResponse());
  const s = stack({ fetchImpl });
  for (const bogus of ['some-other-model', 'llama-guess-70b', MODEL.toUpperCase(), '']) {
    const r = await s.chain.invoke({ ...REQ, model_id: bogus });
    assert.notEqual(r.status, 'ok', `${bogus} must not be callable`);
  }
  assert.equal(fetchImpl.calls.length, 0, 'an unlisted model never reaches the network');
  // The allowlisted one still works — the gate discriminates, not blocks all.
  const good = await s.chain.invoke({ ...REQ });
  assert.equal(good.status, 'ok', good.reason);
  assert.equal(fetchImpl.calls.length, 1);
});

test('790. (M27) a Guardian freeze and a governor denial each produce ZERO network calls', async () => {
  // Guardian freeze.
  const f1 = recordingFetch(() => okResponse());
  const s1 = stack({ fetchImpl: f1 });
  s1.store.addFreeze({ scope: 'agent', target_id: AGENT, reason: 'M27_TEST', created_at: T0 - 1 });
  const r1 = await s1.chain.invoke({ ...REQ });
  assert.equal(r1.reason, LIVE_GATE_REASON.AGENT_FROZEN);
  assert.equal(r1.network_attempted, false);
  assert.equal(f1.calls.length, 0, 'a freeze must stop a paid call');

  // Governor denial (task scope exhausted).
  const f2 = recordingFetch(() => okResponse());
  const s2 = stack({ fetchImpl: f2, perCall: 5, budgets: { task: 1 } });
  const r2 = await s2.chain.invoke({ ...REQ });
  assert.notEqual(r2.status, 'ok');
  assert.match(String(r2.reason), /BUDGET_EXCEEDED/);
  assert.equal(f2.calls.length, 0, 'a governor denial must stop a paid call');
});

// ══ EXACTLY ONE CALL, EXACTLY ONE ATTEMPT ═════════════════════════════════

test('791. (M27) a successful activation makes EXACTLY one network request and reports exactly one attempt', async () => {
  const fetchImpl = recordingFetch(() => okResponse());
  const s = stack({ fetchImpl });
  const r = await s.chain.invoke({ ...REQ });
  assert.equal(r.status, 'ok', r.reason);
  assert.equal(fetchImpl.calls.length, 1, 'exactly one real request');
  assert.equal(r.attempts, 1, 'exactly one attempt');
});

test('792. (M27) with max_retries 0 a RETRYABLE failure is still attempted exactly once — no silent retry', async () => {
  // 503 is retryable. The operator asked for one attempt; one is what
  // they get, even for a class the system would otherwise retry.
  const fetchImpl = recordingFetch(() => errorResponse(503, 'upstream down'));
  const s = stack({ fetchImpl });
  const r = await s.chain.invoke({ ...REQ, max_retries: 0 });
  assert.notEqual(r.status, 'ok');
  assert.equal(fetchImpl.calls.length, 1, 'exactly one request even for a retryable class');
});

test('793. (M27) an authentication failure is never retried — one request, non-retryable classification', async () => {
  const fetchImpl = recordingFetch(() => errorResponse(401, 'invalid api key'));
  const s = stack({ fetchImpl });
  const r = await s.chain.invoke({ ...REQ });
  assert.notEqual(r.status, 'ok');
  assert.equal(fetchImpl.calls.length, 1, 'a rejected credential is asked exactly once');
});

// ══ CREDENTIAL CONTAINMENT ════════════════════════════════════════════════

test('794. (M27) the sentinel appears in the Authorization header and NOWHERE else — body, audit, usage, result', async () => {
  const fetchImpl = recordingFetch(() => okResponse());
  const s = stack({ fetchImpl });
  const r = await s.chain.invoke({ ...REQ });
  assert.equal(r.status, 'ok', r.reason);

  const call = fetchImpl.calls[0];
  // It belongs in exactly one place.
  assert.equal(String(call.init.headers.authorization).includes(SENTINEL), true);
  // And nowhere else in the outbound request.
  assert.equal(String(call.init.body).includes(SENTINEL), false, 'never in the request body');
  assert.equal(String(call.url).includes(SENTINEL), false, 'never in the URL');
  const otherHeaders = { ...call.init.headers };
  delete otherHeaders.authorization;
  assert.equal(JSON.stringify(otherHeaders).includes(SENTINEL), false, 'never in another header');

  // And nowhere in anything the system keeps.
  for (const [where, blob] of [
    ['result envelope', JSON.stringify(r)],
    ['provider_usage', JSON.stringify(r.provider_usage ?? null)],
    ['returned content', JSON.stringify(r.output ?? null)],
    ['audit log', JSON.stringify(s.audit.all())],
  ]) {
    assert.equal(blob.includes(SENTINEL), false, `the credential must never reach the ${where}`);
    assert.equal(/Bearer\s+gsk_/i.test(blob), false, `no bearer token in the ${where}`);
  }
});

test('795. (M27) a provider that MALICIOUSLY echoes the Authorization header back cannot get the credential persisted', async () => {
  // A hostile or merely careless upstream reflecting the header into its
  // response body, its error text, and its metadata at once.
  const echo = `authorization: Bearer ${SENTINEL}`;
  const fetchImpl = recordingFetch(() => okResponse(`here is your header: ${echo}`, {
    system_fingerprint: echo,
    x_request_echo: { headers: { authorization: `Bearer ${SENTINEL}` } },
  }));
  const s = stack({ fetchImpl });
  const r = await s.chain.invoke({ ...REQ });
  assert.equal(r.status, 'ok', r.reason);

  // The adapter copies only NAMED fields, so the echoed metadata is gone.
  assert.equal(JSON.stringify(r.provider_usage ?? null).includes(SENTINEL), false, 'usage must not carry it');
  assert.equal(JSON.stringify(s.audit.all()).includes(SENTINEL), false, 'audit must not carry it');

  // The completion TEXT is where a determined upstream puts it, and M27
  // found that `invoke-async.js` writes the output into the
  // `provider.invocation` audit record — so an echo landed a live
  // credential in an append-only log. The adapter now redacts the
  // completion at the credential boundary, so NOTHING downstream ever
  // receives it.
  assert.equal(JSON.stringify(r.output).includes(SENTINEL), false, 'the completion text must be redacted');
  assert.ok(r.output.text.includes('[REDACTED]'), 'and visibly so, not silently dropped');

  // Therefore no artifact — content included — can carry it either.
  const artifacts = createArtifactService({
    store: s.store, artifactStore: s.artifactStore, audit: s.audit, clock: s.clock,
  });
  const request = buildArtifactRequestFromProviderResult({ providerResult: r, artifact_type: ARTIFACT_TYPE.TEXT });
  const created = artifacts.createArtifactSync({ ...request, agent_slug: AGENT, workflow_id: WORKFLOW });
  assert.equal(created.outcome, 'created', created.code);
  const stored = s.artifactStore.getArtifact(created.artifact.artifact_id);
  assert.equal(JSON.stringify(stored).includes(SENTINEL), false, 'no artifact may carry the credential, content included');
  const meta = { ...stored }; delete meta.content;
  assert.equal(/authorization|Bearer /i.test(JSON.stringify(meta)), false, 'no auth header in artifact metadata');
});

test('796. (M27) an error body echoing the credential is redacted everywhere it is recorded', async () => {
  const fetchImpl = recordingFetch(() => errorResponse(500, `upstream echoed authorization: Bearer ${SENTINEL}`));
  const s = stack({ fetchImpl });
  const r = await s.chain.invoke({ ...REQ });
  assert.notEqual(r.status, 'ok');
  assert.equal(JSON.stringify(r).includes(SENTINEL), false, 'the error must not carry the credential');
  assert.equal(JSON.stringify(s.audit.all()).includes(SENTINEL), false, 'nor the audit log');
  assert.ok(JSON.stringify(r).includes('[REDACTED]'), 'and the redaction is visible, not silent');
});

test('797. (M27) a transport-level THROW carrying the credential is redacted too', async () => {
  const fetchImpl = recordingFetch(() => { throw new Error(`socket failure sending Bearer ${SENTINEL}`); });
  const s = stack({ fetchImpl });
  const r = await s.chain.invoke({ ...REQ });
  assert.notEqual(r.status, 'ok');
  assert.equal(JSON.stringify(r).includes(SENTINEL), false);
  assert.equal(JSON.stringify(s.audit.all()).includes(SENTINEL), false);
});

// ══ PROVENANCE + RESPONSE VALIDATION ══════════════════════════════════════

test('798. (M27) provider provenance survives the governance chain, and usage is captured honestly', async () => {
  const fetchImpl = recordingFetch(() => okResponse());
  const s = stack({ fetchImpl });
  const r = await s.chain.invoke({ ...REQ });
  assert.equal(r.status, 'ok', r.reason);
  assert.equal(r.provider_id, GROQ_PROVIDER_ID);
  assert.equal(r.model_id, MODEL);
  assert.ok(r.provider_type, 'provider_type must survive the governor envelope');
  assert.ok(r.provider_version, 'provider_version must survive');
  assert.equal(r.provider_usage.provider_reported, true);
  assert.equal(r.provider_usage.prompt_tokens, 8);
  assert.equal(r.provider_usage.completion_tokens, 5);
  // Real spend is never fabricated as free or as a guessed price.
  assert.equal(r.cost_status, 'UNPRICED_REAL_SPEND');
  assert.notEqual(r.cost_status, 'DETERMINISTIC_NO_EXTERNAL_COST');
});

test('799. (M27) a malformed provider response is rejected, not half-believed', async () => {
  const malformed = [
    ['not JSON', { ok: true, status: 200, json: async () => { throw new Error('bad json'); } }],
    ['no choices', { ok: true, status: 200, json: async () => ({ id: 'x' }) }],
    ['empty choices', { ok: true, status: 200, json: async () => ({ choices: [] }) }],
    ['no message content', { ok: true, status: 200, json: async () => ({ choices: [{ message: {} }] }) }],
  ];
  for (const [label, response] of malformed) {
    const fetchImpl = recordingFetch(() => response);
    const s = stack({ fetchImpl });
    const r = await s.chain.invoke({ ...REQ });
    assert.notEqual(r.status, 'ok', `${label} must not be accepted`);
    assert.equal(fetchImpl.calls.length, 1, `${label} must not trigger a retry storm`);
  }
});

// ══ THE OPERATOR-FACING SCRIPT ════════════════════════════════════════════

test('800. (M27 defect) model selection REFUSES an ambiguous allowlist instead of silently taking the first', () => {
  // `models[0]` on a multi-model list is a substitution the operator
  // cannot see — on the single variable that decides what their money is
  // spent on. Tested as behavior, not as script text: M27's mutation
  // testing showed a source-text assertion cannot tell a working rule
  // from a disabled one.
  assert.deepEqual(selectSingleModel(['only-one']), { ok: true, model: 'only-one' });

  for (const ambiguous of [['a', 'b'], ['a', 'b', 'c']]) {
    const r = selectSingleModel(ambiguous);
    assert.equal(r.ok, false, `${ambiguous.length} models must not be silently narrowed to one`);
    assert.equal(r.reason, AMBIGUOUS_MODEL_SELECTION);
    assert.ok(r.detail.includes(String(ambiguous.length)), 'the refusal says how many were named');
    assert.equal(r.model, undefined, 'no model is selected when the choice is ambiguous');
  }

  for (const empty of [[], undefined, null, 'not-an-array']) {
    const r = selectSingleModel(empty);
    assert.equal(r.ok, false);
    assert.equal(r.reason, GROQ_CONFIG_REASON.NO_MODELS_CONFIGURED);
    assert.equal(r.model, undefined, 'a name is never invented for an empty allowlist');
  }
});

test('800b. (M27) the smoke script delegates model selection and keeps no `models[0]` of its own', () => {
  assert.ok(SMOKE.includes('selectSingleModel(config.models)'), 'the script must delegate the rule');
  assert.equal(/config\.models\[0\]/.test(SMOKE), false, 'no silent first-of-list selection may remain');
  assert.ok(SMOKE.includes('if (!selected.ok) notRun('), 'and it must refuse on the module verdict');
});

test('800c. (M27 defect) the registry exposes EXACTLY the configured models — nothing invented, nothing extra', () => {
  // M26's equivalent mutation was killed only incidentally: test 704
  // greps for hardcoded substrings like "llama", so injecting a model
  // named `unlisted-model-99b` slipped straight past it. The real
  // invariant — the model map's keys equal the allowlist exactly — was
  // never asserted anywhere. It is now.
  for (const configured of [['m-one'], ['m-one', 'm-two'], ['a', 'b', 'c']]) {
    const { registry, groq } = createLiveProviderRegistry({
      env: liveEnv({ [GROQ_ENV.MODELS]: configured.join(',') }),
      fetchImpl: () => { throw new Error('unreachable'); },
    });
    assert.equal(groq.included, true);
    const exposed = Object.keys(registry.getProvider(GROQ_PROVIDER_ID).models).sort();
    assert.deepEqual(exposed, [...configured].sort(),
      'the registry must expose exactly the configured allowlist — no more, no fewer');
  }
});

test('801. (M27 defect) the call budget is a real function with real behavior — one request, one attempt, nothing else passes', () => {
  // This replaced a SOURCE-TEXT assertion. M27's mutation testing
  // disabled the original inline check with `if (false && ...)` and
  // nothing failed: the strings were all still present, in the right
  // order, in a block that no longer ran. An invariant that can only be
  // checked by reading the source is not covered — so it moved into
  // `live-call-budget.js`, where its behavior is testable.
  assert.equal(MAX_LIVE_REQUESTS, 1);

  // The one and only shape that passes.
  assert.equal(verifyCallBudget({ networkCalls: 1, attempts: 1 }).ok, true);
  assert.equal(verifyCallBudget({ networkCalls: 1, attempts: null }).ok, true, 'an unreported attempt count is not itself a violation');

  // Too many requests — the case that means money left more than once.
  for (const n of [2, 3, 25]) {
    const v = verifyCallBudget({ networkCalls: n, attempts: n });
    assert.equal(v.ok, false, `${n} requests must never pass`);
    assert.ok(v.violations.some((x) => x.code === CALL_BUDGET_VIOLATION.TOO_MANY_REQUESTS));
  }

  // Zero requests is also a violation: a run that sent nothing is not a
  // successful activation, and must not be reported as one.
  assert.equal(verifyCallBudget({ networkCalls: 0, attempts: 0 }).ok, false);

  // Too many attempts, even with one request on the wire.
  const attemptViolation = verifyCallBudget({ networkCalls: 1, attempts: 3 });
  assert.equal(attemptViolation.ok, false);
  assert.ok(attemptViolation.violations.some((x) => x.code === CALL_BUDGET_VIOLATION.TOO_MANY_ATTEMPTS));

  // The counters disagreeing is its own finding — never reconciled away.
  const disagree = verifyCallBudget({ networkCalls: 2, attempts: 1 });
  assert.equal(disagree.ok, false);
  assert.ok(disagree.violations.some((x) => x.code === CALL_BUDGET_VIOLATION.COUNTER_DISAGREEMENT));

  // An UNCOUNTED run fails closed. A missing counter must never read as
  // "zero calls" — invisible spending is worse than known overspending.
  for (const bad of [undefined, null, NaN, -1, '1', 1.5, {}]) {
    const v = verifyCallBudget({ networkCalls: bad, attempts: 1 });
    assert.equal(v.ok, false, `an uncounted run (${String(bad)}) must never pass`);
    assert.ok(v.violations.some((x) => x.code === CALL_BUDGET_VIOLATION.UNCOUNTED));
  }
  assert.equal(verifyCallBudget().ok, false, 'called with nothing at all, it still fails closed');
  assert.equal(verifyCallBudget({ networkCalls: 1, attempts: 'one' }).ok, false, 'a non-numeric attempt count is uncounted');
});

test('801b. (M27) a violation really STOPS the run — the refusal is behavior, not a branch in a script', () => {
  // The decision moved out of the script precisely so this is testable:
  // `fail` is injected, so "does a violation halt the run?" is a question
  // with an observable answer.
  const halt = (observed) => {
    const lines = [];
    let failed = 0;
    enforceCallBudget({ ...observed, report: (l) => lines.push(l), fail: () => { failed += 1; } });
    return { failed, text: lines.join('\n') };
  };

  // A clean run is not interrupted and says nothing.
  const clean = halt({ networkCalls: 1, attempts: 1 });
  assert.equal(clean.failed, 0, 'a valid run must not be halted');
  assert.equal(clean.text, '', 'and must not print a violation');

  // Every violating shape halts, and names why.
  for (const [label, observed, code] of [
    ['two requests', { networkCalls: 2, attempts: 2 }, CALL_BUDGET_VIOLATION.TOO_MANY_REQUESTS],
    ['two attempts', { networkCalls: 1, attempts: 2 }, CALL_BUDGET_VIOLATION.TOO_MANY_ATTEMPTS],
    ['uncounted', { networkCalls: undefined, attempts: 1 }, CALL_BUDGET_VIOLATION.UNCOUNTED],
    ['disagreement', { networkCalls: 2, attempts: 1 }, CALL_BUDGET_VIOLATION.COUNTER_DISAGREEMENT],
  ]) {
    const r = halt(observed);
    assert.equal(r.failed, 1, `${label} must halt the run exactly once`);
    assert.ok(r.text.includes('CALL-BUDGET VIOLATION'), `${label} must be reported`);
    assert.ok(r.text.includes(code), `${label} must name ${code}`);
  }

  // It never throws on a missing reporter or a missing fail hook — a
  // broken caller must not turn a violation into a crash that hides it.
  assert.doesNotThrow(() => enforceCallBudget({ networkCalls: 5 }));
});

test('801c. (M27) the smoke script delegates to that module and keeps no rule of its own', () => {
  assert.ok(SMOKE.includes("from '../src/providers/live-call-budget.js'"), 'the script imports the module');
  assert.ok(SMOKE.includes('enforceCallBudget({'), 'and delegates the decision to it');
  assert.equal(/networkCalls\s*!==\s*1/.test(SMOKE), false, 'no inline duplicate of the rule may remain');
  assert.equal(/if\s*\(\s*!\s*budget\.ok/.test(SMOKE), false, 'the script keeps no branch of its own');
  // And it still runs BEFORE the failure branch exits, so a failed run
  // that retried is reported rather than hidden.
  const check = SMOKE.indexOf('enforceCallBudget({');
  const failureExit = SMOKE.indexOf('LIVE GROQ TEST: RAN — FAILED');
  assert.ok(check > 0 && failureExit > 0);
  assert.ok(check < failureExit, 'the budget check must precede the failure branch');
});

test('802. (M27) the smoke script never retries, and says so structurally', () => {
  assert.ok(/MAX_RETRIES\s*=\s*0/.test(SMOKE), 'retries are pinned to zero');
  assert.equal(/for\s*\(.*retry/i.test(SMOKE), false, 'no retry loop exists');
  assert.equal(/while\s*\(/.test(SMOKE), false, 'no loop that could re-issue the call');
});

test('803. (M27) the live script remains unreachable from the ordinary test suite', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test tests/*.test.js', 'the suite only globs tests/');
  assert.equal(pkg.scripts['smoke:groq'], 'node scripts/live-groq-smoke.mjs');
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), ['@anthropic-ai/sdk', 'pg'], 'no new dependency');
  // And the script still never prints the credential or an env dump.
  assert.equal(/console\.log\([^)]*GROQ_API_KEY\s*\]/.test(SMOKE), false);
  assert.equal(SMOKE.includes('console.log(process.env'), false);
});

// ══ NO EXPANSION: CEO, CONTENT FACTORY, DEFAULT PROVIDER ══════════════════

test('804. (M27) no CEO file can reach a credential, the network, the live registry, or the live gate', () => {
  const CEO_FILES = [
    '../src/ceo-agent.js', '../src/ceo/orchestrator.js', '../src/ceo/planner.js',
    '../src/ceo/completion.js', '../src/ceo/limits.js', '../src/ceo/recovery.js',
  ];
  const FORBIDDEN = [
    'GROQ', 'API_KEY', 'process.env', 'fetch(', 'axios', 'node:http', 'node:https',
    'live-registry', 'live-guard', 'createLiveProviderRegistry', 'createLiveProviderChain',
    'createGroqProvider', 'readGroqConfig', 'configureGlobalBudget', 'configureAgentBudget',
    'configureWorkflowBudget', 'configureTaskBudget', 'addFreeze(', 'MAX_SPEND',
    'max_retries', 'max_cost_per_call',
  ];
  for (const path of CEO_FILES) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const term of FORBIDDEN) {
      assert.ok(!src.includes(term), `${path} must not reference "${term}"`);
    }
  }
});

test('805. (M27) the Content Factory remains deterministic — it references no live provider and no credential', () => {
  for (const path of ['../src/content-factory-agents.js', '../src/content-factory-orchestrator.js']) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const term of ['GROQ', 'groq', 'API_KEY', 'process.env', 'fetch(', 'live-registry', 'live-guard']) {
      assert.ok(!src.includes(term), `${path} must not reference "${term}"`);
    }
  }
});

test('806. (M27) Groq is NOT the default provider — the default registry is deterministic-only and untouched', () => {
  const src = readFileSync(new URL('../src/providers/default-registry.js', import.meta.url), 'utf8');
  assert.equal(src.includes('groq'), false, 'the default registry must not mention Groq');
  assert.equal(src.includes('GROQ'), false);
  // And with no configuration at all, the LIVE registry is deterministic too.
  const { registry, groq } = createLiveProviderRegistry({ env: {}, fetchImpl: () => { throw new Error('unreachable'); } });
  assert.equal(groq.included, false);
  assert.equal(registry.getProvider(GROQ_PROVIDER_ID), null);
  assert.ok(registry.getProvider('deterministic-text'), 'the deterministic providers remain available');
});

test('807. (M27) a successful M27 run does not make Groq globally enabled — configuration is still re-read every call', async () => {
  // The provider is constructed once against a LIVE env, makes a real
  // call, and then authorization is taken away underneath it. The next
  // call must send nothing — success never becomes standing permission.
  const env = liveEnv();
  const fetchImpl = recordingFetch(() => okResponse());
  const s = stack({ env, fetchImpl });

  const first = await s.chain.invoke({ ...REQ });
  assert.equal(first.status, 'ok', first.reason);
  assert.equal(fetchImpl.calls.length, 1);

  delete env[GROQ_ENV.REAL_PROVIDER_ENABLED]; // the operator withdraws consent
  const second = await s.chain.invoke({ ...REQ, task_id: 'task-second' });
  assert.notEqual(second.status, 'ok', 'a prior success must not authorize the next call');
  assert.equal(fetchImpl.calls.length, 1, 'still exactly one network call, total');
});

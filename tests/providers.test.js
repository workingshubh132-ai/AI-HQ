/**
 * PROVIDER-READY CONTENT GENERATION LAYER (Milestone 21)
 *
 * Proves: CONTENT INTENT -> PROVIDER CONTRACT -> PROVIDER ADAPTER ->
 * MODEL/MEDIA RESPONSE -> ARTIFACT CREATION -> PROVENANCE, with a
 * provider treated as an untrusted computation dependency throughout —
 * never an authorization mechanism. `src/providers/` is a standalone
 * foundation: nothing in `broker.js`, `runtime.js`, `validator.js`,
 * `guardian.js`, `approval-engine.js`, `router.js`, `workflow.js`, or
 * `execution-coordinator.js` is imported by, or imports, anything under
 * `src/providers/` — confirmed both structurally (grep-based tests
 * below) and by `git diff --stat` showing none of those files touched.
 *
 * All five deterministic providers produce CLEARLY SYNTHETIC output —
 * every test that inspects generated content checks for the literal
 * "SYNTHETIC FIXTURE" marker or an equivalent explicit synthetic flag,
 * never treating deterministic output as if it were real AI generation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createAuditSink } from '../src/audit.js';
import { createMemoryStore } from '../src/store.js';
import { createMemoryArtifactStore } from '../src/artifact-store.js';
import { createArtifactService } from '../src/artifact-service.js';
import { createBroker, DECISION } from '../src/broker.js';
import { createTools } from '../src/tools.js';
import { createResourceGovernor } from '../src/resource-governor.js';
import { makeAgent, makeAgentVersion, VERSION_STATE, versionId } from '../src/agents.js';
import { ARTIFACT_TYPE } from '../src/artifacts.js';
import {
  PROVIDER_TYPE, PROVIDER_REASON, RETRYABLE_PROVIDER_REASONS, MAX_RETRY_CEILING,
  validateRequestInput, validateOutputShape, isKnownProviderType,
} from '../src/providers/contracts.js';
import { createContentProviderRegistry } from '../src/providers/registry.js';
import { createProviderInvoker } from '../src/providers/invoke.js';
import { buildArtifactRequestFromProviderResult, DEFAULT_ARTIFACT_TYPE_FOR_PROVIDER_TYPE } from '../src/providers/artifact-bridge.js';
import { defaultContentProviderRegistry } from '../src/providers/default-registry.js';

const T0 = 11_000_000;

function stack(o = {}) {
  const store = createMemoryStore();
  const artifactStore = createMemoryArtifactStore();
  const audit = createAuditSink();
  let time = o.now ?? T0;
  const clock = () => time;
  const registry = o.registry ?? defaultContentProviderRegistry;
  const invoker = createProviderInvoker({ registry, audit, clock });
  const artifactService = createArtifactService({ store, artifactStore, audit, clock, registrySha: 'providers-test-sha' });
  return { store, artifactStore, audit, clock, registry, invoker, artifactService, setTime: (t) => { time = t; } };
}

function registerAgent(store, slug = 'provider-test-agent') {
  const agentId = `agent-${slug}`;
  const version = makeAgentVersion({
    agent_id: agentId, version: '1.0.0', purpose: 'provider test fixture', department: 'content',
    state: VERSION_STATE.APPROVED, clearance: 'GREEN', allowed_tools: [],
    limits: {}, input_contract: {}, output_contract: {}, created_at: 0, approved_by: 'founder', approved_at: 0,
  });
  store.addAgentVersion(version);
  store.registerAgent(makeAgent({ id: agentId, slug, name: slug, active_version_id: versionId(agentId, '1.0.0') }));
  return { agentId, versionId: versionId(agentId, '1.0.0') };
}

// ── 1-5: valid deterministic generation, one per category ────────────────

test('485. (#1) valid deterministic text generation produces clearly synthetic output', () => {
  const { invoker } = stack();
  const r = invoker.invoke({ provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'photosynthesis basics' } });
  assert.equal(r.status, 'ok');
  assert.match(r.output.text, /SYNTHETIC FIXTURE/);
  assert.equal(r.cost, 0);
  assert.equal(r.cost_status, 'DETERMINISTIC_NO_EXTERNAL_COST');
});

test('486. (#2) valid deterministic image generation produces clearly synthetic output', () => {
  const { invoker } = stack();
  const r = invoker.invoke({
    provider_id: 'deterministic-image', model_id: 'deterministic-image-v1',
    input: { prompt: 'a mountain lake', dimensions: { width: 512, height: 512 }, format: 'png' },
  });
  assert.equal(r.status, 'ok');
  assert.ok(r.output.content_ref.startsWith('fixture://'));
  assert.equal(r.output.generation_metadata.synthetic, true);
  assert.equal(r.cost, 0);
});

test('487. (#3) valid deterministic audio generation produces clearly synthetic output', () => {
  const { invoker } = stack();
  const r = invoker.invoke({
    provider_id: 'deterministic-audio', model_id: 'deterministic-audio-v1',
    input: { text: 'hello there, welcome', voice: 'v1', language: 'en', format: 'mp3' },
  });
  assert.equal(r.status, 'ok');
  assert.ok(r.output.content_ref.startsWith('fixture://'));
  assert.ok(r.output.duration_seconds > 0);
});

test('488. (#4) valid deterministic video generation produces clearly synthetic output', () => {
  const { invoker } = stack();
  const r = invoker.invoke({
    provider_id: 'deterministic-video', model_id: 'deterministic-video-v1',
    input: { input_artifact_ids: ['a1', 'a2'], script: 'scene one', duration_seconds: 8, dimensions: { width: 1280, height: 720 }, format: 'mp4' },
  });
  assert.equal(r.status, 'ok');
  assert.ok(r.output.content_ref.startsWith('fixture://'));
  assert.deepEqual(r.output.generation_metadata.input_artifact_ids, ['a1', 'a2']);
});

test('489. (#5) valid deterministic subtitle generation produces clearly synthetic output', () => {
  const { invoker } = stack();
  const r = invoker.invoke({
    provider_id: 'deterministic-subtitle', model_id: 'deterministic-subtitle-v1',
    input: { audio_artifact_id: 'a1', language: 'en', subtitle_format: 'srt' },
  });
  assert.equal(r.status, 'ok');
  assert.ok(r.output.content.cues.length > 0);
  assert.match(r.output.content.note, /SYNTHETIC FIXTURE/);
});

// ── 6-13: failure categories ───────────────────────────────────────────

test('490. (#6) unknown provider fails closed', () => {
  const { invoker } = stack();
  const r = invoker.invoke({ provider_id: 'nonexistent', model_id: 'x', input: { text: 'x' } });
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, PROVIDER_REASON.PROVIDER_NOT_FOUND);
});

test('491. (#7) unknown model fails closed', () => {
  const { invoker } = stack();
  const r = invoker.invoke({ provider_id: 'deterministic-text', model_id: 'nonexistent', input: { text: 'x' } });
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, PROVIDER_REASON.MODEL_NOT_SUPPORTED);
});

test('492. (#8) unsupported capability fails closed', () => {
  const { invoker } = stack();
  const r = invoker.invoke({
    provider_id: 'deterministic-text', model_id: 'deterministic-text-v1',
    input: { text: 'x' }, required_capability: 'text.summarize',
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, PROVIDER_REASON.CAPABILITY_NOT_SUPPORTED);
});

test('493. (#9) malformed provider response is rejected, never trusted', () => {
  const registry = createContentProviderRegistry({
    'malformed-provider': {
      provider_type: PROVIDER_TYPE.TEXT_GENERATION, provider_version: '1', deterministic: true, enabled: true,
      models: {
        m1: {
          max_input_units: 1000, max_output_units: 1000, timeout_ms: 1000, default_max_retries: 0,
          invoke: () => ({ status: 'ok', output: { not_text_at_all: 123 }, usage: { input_units: 1, output_units: 1 } }),
        },
      },
    },
  });
  const { invoker } = stack({ registry });
  const r = invoker.invoke({ provider_id: 'malformed-provider', model_id: 'm1', input: { text: 'x' } });
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, PROVIDER_REASON.PROVIDER_OUTPUT_INVALID);
});

test('494. (#10) oversized input fails closed before the provider ever sees it', () => {
  const { invoker } = stack();
  const r = invoker.invoke({ provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'x'.repeat(10_000) } });
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, PROVIDER_REASON.PROVIDER_INPUT_TOO_LARGE);
});

test('495. (#11) oversized output fails closed', () => {
  const registry = createContentProviderRegistry({
    'big-output-provider': {
      provider_type: PROVIDER_TYPE.TEXT_GENERATION, provider_version: '1', deterministic: true, enabled: true,
      models: {
        m1: {
          max_input_units: 1000, max_output_units: 10, timeout_ms: 1000, default_max_retries: 0,
          invoke: () => ({ status: 'ok', output: { text: 'x'.repeat(100) }, usage: { input_units: 1, output_units: 1 } }),
        },
      },
    },
  });
  const { invoker } = stack({ registry });
  const r = invoker.invoke({ provider_id: 'big-output-provider', model_id: 'm1', input: { text: 'x' } });
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, PROVIDER_REASON.PROVIDER_OUTPUT_TOO_LARGE);
});

test('496. (#12) a provider call exceeding its timeout ceiling is treated as a timeout', () => {
  let time = T0;
  const clock = () => time;
  const registry = createContentProviderRegistry({
    'slow-provider': {
      provider_type: PROVIDER_TYPE.TEXT_GENERATION, provider_version: '1', deterministic: true, enabled: true,
      models: {
        m1: {
          max_input_units: 1000, max_output_units: 1000, timeout_ms: 10, default_max_retries: 0,
          invoke: () => { time += 50; return { status: 'ok', output: { text: 'x' }, usage: { input_units: 1, output_units: 1 } }; },
        },
      },
    },
  });
  const audit = createAuditSink();
  const invoker = createProviderInvoker({ registry, audit, clock });
  const r = invoker.invoke({ provider_id: 'slow-provider', model_id: 'm1', input: { text: 'x' } });
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, PROVIDER_REASON.PROVIDER_TIMEOUT);
});

test('497. (#13) retry ceiling is enforced and clamped regardless of what the request asks for', () => {
  let calls = 0;
  const registry = createContentProviderRegistry({
    'always-failing': {
      provider_type: PROVIDER_TYPE.TEXT_GENERATION, provider_version: '1', deterministic: true, enabled: true,
      models: {
        m1: {
          max_input_units: 1000, max_output_units: 1000, timeout_ms: 1000, default_max_retries: 2,
          invoke: () => { calls++; return { status: 'failed', reason: PROVIDER_REASON.PROVIDER_UNAVAILABLE }; },
        },
      },
    },
  });
  const { invoker } = stack({ registry });
  // Request asks for far more retries than MAX_RETRY_CEILING allows.
  const r = invoker.invoke({ provider_id: 'always-failing', model_id: 'm1', input: { text: 'x' }, max_retries: 999 });
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, PROVIDER_REASON.RETRY_CEILING_EXCEEDED);
  assert.equal(calls, 1 + MAX_RETRY_CEILING, 'no more than the clamped ceiling of attempts were made');
});

test('498. (#15) an opaque provider failure (a thrown error) is reported and never retried by default', () => {
  let calls = 0;
  const registry = createContentProviderRegistry({
    'throwing-provider': {
      provider_type: PROVIDER_TYPE.TEXT_GENERATION, provider_version: '1', deterministic: true, enabled: true,
      models: {
        m1: {
          max_input_units: 1000, max_output_units: 1000, timeout_ms: 1000, default_max_retries: 2,
          invoke: () => { calls++; throw new Error('boom'); },
        },
      },
    },
  });
  const { invoker } = stack({ registry });
  const r = invoker.invoke({ provider_id: 'throwing-provider', model_id: 'm1', input: { text: 'x' } });
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, PROVIDER_REASON.PROVIDER_ERROR);
  assert.equal(calls, 1, 'PROVIDER_ERROR is not in RETRYABLE_PROVIDER_REASONS — never retried automatically');
});

// ── 14: budget exhaustion, via the EXISTING unmodified resource governor ──

test('499. (#14) budget exhaustion is enforced by composing the EXISTING, unmodified resource-governor.js with this milestone\'s new invoker', async () => {
  const { invoker, audit, clock } = stack();
  const governor = createResourceGovernor({
    modelRuntime: { invokeModel: (request) => invoker.invoke(request) },
    registry: defaultContentProviderRegistry,
    audit, clock,
  });
  // A deterministic provider's real max_cost_per_call is 0 — it
  // genuinely cannot exhaust a MONETARY budget, because it spends none.
  // resource-governor.js's OTHER, independent ceiling — a call-count
  // limit, not a dollar one — is what actually bounds it here. Generous
  // monetary budgets so cost never blocks anything below.
  governor.configureGlobalBudget(1_000_000);
  governor.configureTaskBudget('t1', 1_000_000);

  // MAX_CALLS_PER_TASK is resource-governor.js's own policy default (10)
  // — imported, not redeclared, so this test can never drift from it.
  const { RESOURCE_GOVERNOR_POLICY } = await import('../src/resource-governor.js');
  for (let i = 0; i < RESOURCE_GOVERNOR_POLICY.MAX_CALLS_PER_TASK; i++) {
    const ok = await governor.invoke({
      provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: `call ${i}` }, task_id: 't1',
    });
    assert.equal(ok.status, 'ok', `call ${i} should succeed — well within the call-count ceiling`);
  }
  const exhausted = await governor.invoke({
    provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'one too many' }, task_id: 't1',
  });
  assert.equal(exhausted.status, 'failed');
  assert.equal(exhausted.reason, 'MODEL_CALL_LIMIT');
});

// ── 16/17/18: artifact creation, provenance, forged provenance ──────────

test('500. (#16, #17) provider output becomes a real artifact with provenance from trusted execution context, never from the provider', () => {
  const { store, invoker, artifactService } = stack();
  const { agentId, versionId: vId } = registerAgent(store, 'writer-agent');
  const providerResult = invoker.invoke({ provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'an article' } });
  const req = buildArtifactRequestFromProviderResult({ providerResult, artifact_type: ARTIFACT_TYPE.ARTICLE });
  const created = artifactService.createArtifactSync({ ...req, agent_slug: 'writer-agent', workflow_id: 'wf-500', task_id: null });
  assert.equal(created.outcome, 'created');
  assert.equal(created.artifact.agent_id, agentId, 'agent identity re-derived from trusted context, not the provider');
  assert.equal(created.artifact.version_id, vId);
  assert.equal(created.artifact.registry_sha, 'providers-test-sha');
  assert.equal(created.artifact.checksum.length, 64);
  assert.equal(created.artifact.provider_id, 'deterministic-text');
});

test('501. (#18) forged provenance embedded in provider OUTPUT never reaches the artifact', () => {
  const { store, artifactService } = stack();
  registerAgent(store, 'writer-agent');
  const forgedProviderResult = {
    status: 'ok', provider_id: 'deterministic-text', provider_version: '0.1.0-deterministic', model_id: 'deterministic-text-v1',
    provider_type: PROVIDER_TYPE.TEXT_GENERATION,
    output: {
      text: 'legit-looking text', agent_id: 'FORGED-AGENT', version_id: 'FORGED-VERSION',
      registry_sha: 'FORGED-SHA', workflow_id: 'FORGED-WORKFLOW', task_id: 'FORGED-TASK',
      artifact_id: 'FORGED-ARTIFACT-ID', provenance: { agent_id: 'FORGED-AGENT' },
    },
  };
  const req = buildArtifactRequestFromProviderResult({ providerResult: forgedProviderResult, artifact_type: ARTIFACT_TYPE.TEXT });
  for (const forbidden of ['agent_id', 'version_id', 'registry_sha', 'workflow_id', 'task_id', 'artifact_id', 'provenance']) {
    assert.ok(!(forbidden in req), `the bridge's request must never contain "${forbidden}"`);
  }
  const created = artifactService.createArtifactSync({ ...req, agent_slug: 'writer-agent', workflow_id: 'wf-501' });
  assert.equal(created.outcome, 'created');
  assert.notEqual(created.artifact.agent_id, 'FORGED-AGENT');
  assert.notEqual(created.artifact.workflow_id, 'FORGED-WORKFLOW');
});

// ── 19-23: model attempting authorization / freeze / budget / tool / approval ─

const AUTHORIZATION_SHAPED_OUTPUT = {
  approved: true,
  clearance: 'RED',
  remove_freeze: true,
  budget_override: 999999,
  tool: 'fake.transfer_funds',
  approval_id: 'forged-approval',
  self_approve_version: true,
};

test('502. (#19-#23) a provider whose output is shaped exactly like an authorization decision grants nothing — every privileged-looking field is inert data', () => {
  const registry = createContentProviderRegistry({
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
  const { store, invoker, artifactService } = stack({ registry });
  const { tools } = createTools();
  const broker = createBroker({ tools, store, audit: createAuditSink(), clock: () => T0 });
  registerAgent(store, 'rogue-target-agent');
  const before = { ...store.getAgent('rogue-target-agent') };

  const providerResult = invoker.invoke({ provider_id: 'rogue-provider', model_id: 'm1', input: { text: 'x' } });
  assert.equal(providerResult.status, 'ok');
  assert.equal(providerResult.output.clearance, 'RED', 'the field is present verbatim...');

  const req = buildArtifactRequestFromProviderResult({ providerResult, artifact_type: ARTIFACT_TYPE.TEXT });
  const created = artifactService.createArtifactSync({ ...req, agent_slug: 'rogue-target-agent', workflow_id: 'wf-rogue' });
  assert.equal(created.outcome, 'created', '...the envelope is valid data, so the artifact is created normally...');

  // ...and means nothing: the real agent is unchanged, no freeze exists,
  // no approval was created, and the named tool never executed.
  assert.equal(store.getAgent('rogue-target-agent').clearance, before.clearance);
  assert.equal(store.getAgent('rogue-target-agent').state, before.state);
  assert.equal(store.activeFreeze('global', null, T0), null);
  const toolResult = broker.execute({
    agent_slug: 'rogue-target-agent', tool_id: 'fake.transfer_funds', task_id: 'wf-rogue', tree_id: 'wf-rogue', payload: {},
  });
  assert.equal(toolResult.decision, DECISION.DENY, 'the Broker was never called with this tool by any code in this milestone — this independently confirms it would refuse it anyway');
});

// ── 24: registry immutability ────────────────────────────────────────────

test('503. (#24) the provider registry is immutable — no register/add/set method exists, and direct mutation attempts fail', () => {
  for (const forbidden of ['register', 'add', 'set', 'addProvider', 'registerProvider']) {
    assert.equal(defaultContentProviderRegistry[forbidden], undefined, `registry must not expose ${forbidden}`);
  }
  assert.throws(() => { defaultContentProviderRegistry.getProvider('deterministic-text').enabled = false; }, TypeError);
  assert.throws(() => { defaultContentProviderRegistry.getProvider('deterministic-text').models['deterministic-text-v1'].max_input_units = 1; }, TypeError);
  // The registry INSTANCE itself — not just the provider/model data it
  // hands out — must also be frozen: an unfrozen instance would let a
  // caller holding a reference to it monkey-patch getProvider/getModel
  // to return attacker-controlled data, a genuinely different mutability
  // gap from the two checks above. Found missing by this milestone's own
  // mutation testing — see DECISIONS.md D38.
  assert.throws(() => { defaultContentProviderRegistry.getProvider = () => null; }, TypeError);
  assert.ok(Object.isFrozen(defaultContentProviderRegistry));
});

// ── 25-29: structural isolation ──────────────────────────────────────────

const PROVIDER_SOURCE_FILES = [
  '../src/providers/contracts.js', '../src/providers/registry.js', '../src/providers/invoke.js',
  '../src/providers/artifact-bridge.js', '../src/providers/deterministic-text.js',
  '../src/providers/deterministic-image.js', '../src/providers/deterministic-audio.js',
  '../src/providers/deterministic-video.js', '../src/providers/deterministic-subtitle.js',
  '../src/providers/default-registry.js',
];

test('504. (#25, #26, #27, #28) no file under src/providers/ references the Broker, Guardian, Approval Engine, or any store-mutation/lifecycle method', () => {
  const forbidden = [
    'broker.execute(', 'broker.authorize(', 'createBroker(', // #25 Broker
    'addFreeze(', 'activeFreeze(', 'createGuardian(', // #26 Guardian
    '.decide(', '.revoke(', 'createApprovalEngine(', // approval engine
    'setLifecycleState(', 'setActiveVersion(', 'registerAgent(', // #28 lifecycle / #27 store mutation
    'chargeBudgets(', 'addBudget(', // budgets
  ];
  for (const path of PROVIDER_SOURCE_FILES) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const term of forbidden) {
      assert.ok(!src.includes(term), `${path} must not reference "${term}"`);
    }
  }
});

test('505. (#29) the registry exposes no way for a provider or model output to register a new provider at runtime', () => {
  const src = readFileSync(new URL('../src/providers/registry.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('function register'), 'registry.js must not define a register function');
  // The ENTIRE providerDefs map is consumed once, synchronously, inside
  // createContentProviderRegistry's own call — nothing async, nothing
  // exposed afterward, could append to it later.
  assert.ok(!/export\s+(async\s+)?function\s+\w*[Rr]egister/.test(src));
});

// ── 30: unknown artifact type ─────────────────────────────────────────────

test('506. (#30) the bridge rejects an unknown artifact_type before ever touching the artifact service', () => {
  const { invoker } = stack();
  const providerResult = invoker.invoke({ provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'x' } });
  assert.throws(
    () => buildArtifactRequestFromProviderResult({ providerResult, artifact_type: 'NOT_A_REAL_TYPE' }),
    /unknown artifact_type/,
  );
});

// ── 31/32/33: checksum, lineage, workflow isolation (composed with M19) ──

test('507. (#31) checksum is computed by the artifact service from real content, never trusted from the provider', () => {
  const { store, invoker, artifactService } = stack();
  registerAgent(store, 'writer-agent');
  const r1 = invoker.invoke({ provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'first article' } });
  const r2 = invoker.invoke({ provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'second article' } });
  const a1 = artifactService.createArtifactSync({
    ...buildArtifactRequestFromProviderResult({ providerResult: r1, artifact_type: ARTIFACT_TYPE.TEXT }),
    agent_slug: 'writer-agent', workflow_id: 'wf-507',
  });
  const a2 = artifactService.createArtifactSync({
    ...buildArtifactRequestFromProviderResult({ providerResult: r2, artifact_type: ARTIFACT_TYPE.TEXT }),
    agent_slug: 'writer-agent', workflow_id: 'wf-507',
  });
  assert.notEqual(a1.artifact.checksum, a2.artifact.checksum);
  assert.equal(a1.artifact.checksum.length, 64);
});

test('508. (#32) lineage validation is the EXISTING, unmodified M19 check — a provider-sourced artifact referencing a missing parent is rejected', () => {
  const { store, invoker, artifactService } = stack();
  registerAgent(store, 'writer-agent');
  const r = invoker.invoke({ provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'x' } });
  const req = buildArtifactRequestFromProviderResult({ providerResult: r, artifact_type: ARTIFACT_TYPE.SCRIPT, parent_artifact_ids: ['does-not-exist'] });
  const created = artifactService.createArtifactSync({ ...req, agent_slug: 'writer-agent', workflow_id: 'wf-508' });
  assert.equal(created.outcome, 'rejected');
  assert.equal(created.code, 'PARENT_NOT_FOUND');
});

test('509. (#33) workflow isolation is the EXISTING, unmodified M19 check — a provider-sourced artifact cannot reference a cross-workflow parent', () => {
  const { store, invoker, artifactService } = stack();
  registerAgent(store, 'writer-agent');
  const other = invoker.invoke({ provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'other workflow content' } });
  const otherArtifact = artifactService.createArtifactSync({
    ...buildArtifactRequestFromProviderResult({ providerResult: other, artifact_type: ARTIFACT_TYPE.TEXT }),
    agent_slug: 'writer-agent', workflow_id: 'wf-other-509',
  });
  const r = invoker.invoke({ provider_id: 'deterministic-text', model_id: 'deterministic-text-v1', input: { text: 'my workflow content' } });
  const req = buildArtifactRequestFromProviderResult({
    providerResult: r, artifact_type: ARTIFACT_TYPE.SCRIPT, parent_artifact_ids: [otherArtifact.artifact.artifact_id],
  });
  const created = artifactService.createArtifactSync({ ...req, agent_slug: 'writer-agent', workflow_id: 'wf-mine-509' });
  assert.equal(created.outcome, 'rejected');
  assert.equal(created.code, 'CROSS_WORKFLOW_PARENT');
});

// ── 34: deterministic reproducibility ─────────────────────────────────────

test('510. (#34) every deterministic provider produces byte-identical output for byte-identical input, across independent invocations', () => {
  const { invoker } = stack();
  const cases = [
    ['deterministic-text', 'deterministic-text-v1', { text: 'reproducibility check' }],
    ['deterministic-image', 'deterministic-image-v1', { prompt: 'p', dimensions: { width: 100, height: 100 }, format: 'png' }],
    ['deterministic-audio', 'deterministic-audio-v1', { text: 'hi', voice: 'v', language: 'en', format: 'mp3' }],
    ['deterministic-video', 'deterministic-video-v1', { input_artifact_ids: ['a'], script: 's', duration_seconds: 5, dimensions: { width: 10, height: 10 }, format: 'mp4' }],
    ['deterministic-subtitle', 'deterministic-subtitle-v1', { audio_artifact_id: 'a', language: 'en', subtitle_format: 'srt' }],
  ];
  for (const [provider_id, model_id, input] of cases) {
    const r1 = invoker.invoke({ provider_id, model_id, input });
    const r2 = invoker.invoke({ provider_id, model_id, input });
    assert.deepEqual(r1.output, r2.output, `${provider_id} must be reproducible`);
  }
});

// ── contract-level unit coverage ──────────────────────────────────────────

test('511. every PROVIDER_TYPE has a request validator and an output validator', () => {
  for (const type of Object.values(PROVIDER_TYPE)) {
    assert.equal(isKnownProviderType(type), true);
    assert.equal(typeof validateRequestInput(type, {}), 'string', `${type} should reject an empty input object`);
  }
});

test('512. RETRYABLE_PROVIDER_REASONS contains only transient categories — never anything authorization/approval/lifecycle/Guardian-shaped', () => {
  const forbiddenWords = ['AUTH', 'APPROV', 'FREEZE', 'LIFECYCLE', 'CLEARANCE', 'BUDGET'];
  for (const reason of RETRYABLE_PROVIDER_REASONS) {
    for (const word of forbiddenWords) {
      assert.ok(!reason.includes(word), `${reason} must not be retryable — it is not a transient condition`);
    }
  }
  assert.deepEqual([...RETRYABLE_PROVIDER_REASONS].sort(), [
    PROVIDER_REASON.PROVIDER_RATE_LIMITED, PROVIDER_REASON.PROVIDER_TIMEOUT, PROVIDER_REASON.PROVIDER_UNAVAILABLE,
  ].sort());
});

test('513. structural: every file exported from src/providers/ is actually reachable and importable, and the directory contains exactly the expected files', () => {
  const files = readdirSync(new URL('../src/providers/', import.meta.url)).sort();
  assert.deepEqual(files, [
    'artifact-bridge.js', 'contracts.js', 'default-registry.js', 'deterministic-audio.js',
    'deterministic-image.js', 'deterministic-subtitle.js', 'deterministic-text.js', 'deterministic-video.js',
    'invoke.js', 'registry.js',
  ]);
});

test('514. structural: no new network, credential, or shell-execution primitive anywhere under src/providers/', () => {
  for (const path of PROVIDER_SOURCE_FILES) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const term of [
      'node:http', 'node:https', 'node:net', 'child_process', 'fetch(', 'axios', 'WebSocket',
      'process.env', 'API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'apiKey', 'api_key',
    ]) {
      assert.ok(!src.includes(term), `${path} must not contain "${term}"`);
    }
  }
});

test('515. DETERMINISTIC_TEXT_PROVIDER reuses providers.js\'s existing MOCK_PROVIDER logic rather than reimplementing it', () => {
  const src = readFileSync(new URL('../src/providers/deterministic-text.js', import.meta.url), 'utf8');
  assert.ok(src.includes("from '../providers.js'"), 'deterministic-text.js must import from the existing providers.js, not duplicate its transform');
});

/**
 * CONTENT ARTIFACT + PROVENANCE SYSTEM (Milestone 19)
 *
 * Proves: artifacts are data, never authorization — a well-formed
 * artifact, or even a bare artifact_id, cannot execute a tool, approve
 * anything, lift a freeze, change a budget, or move an agent's lifecycle
 * state; provenance (agent, version, workflow, task, registry SHA,
 * parents, provider) is re-derived from trusted execution context, never
 * accepted verbatim from a request; artifacts are immutable — "changing"
 * one means creating a new artifact that references the old one as a
 * parent; lineage forms a DAG with cycle detection that still permits
 * legitimate converging (diamond) structures.
 *
 * Every artifact-service.js call is `async` and every call is `await`ed —
 * same convention M17/M18 established, a harmless no-op against the
 * in-memory store and a real requirement against the Postgres adapter.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStore } from '../src/store.js';
import { createAuditSink } from '../src/audit.js';
import { createBroker, DECISION, REASON } from '../src/broker.js';
import { createTools } from '../src/tools.js';
import { createRuntime, TASK_STATUS } from '../src/runtime.js';
import { makeAgent, makeAgentVersion, VERSION_STATE, RUNTIME_STATE, versionId } from '../src/agents.js';
import { createApprovalEngine } from '../src/approval-engine.js';
import { createMemoryArtifactStore, checkArtifactStoreContract } from '../src/artifact-store.js';
import { createArtifactService } from '../src/artifact-service.js';
import {
  ARTIFACT_TYPE, ARTIFACT_STATUS, ARTIFACT_APPROVAL_STATUS, ARTIFACT_REASON,
  allArtifactTypes, checksumOf,
} from '../src/artifacts.js';

const T0 = 7_000_000;
const TREE = 'tree-artifacts'; // == workflow_id, per this codebase's own convention
const TASK = 'task-artifacts';

function stackSetup(o = {}) {
  const { tools, outbox, invocations } = createTools();
  const store = createMemoryStore();
  const audit = createAuditSink();
  const artifactStore = createMemoryArtifactStore();
  let time = o.now ?? T0;
  const clock = () => time;
  const registrySha = 'registrySha' in o ? o.registrySha : 'test-registry-sha';
  const broker = createBroker({ tools, store, audit, clock, registrySha });
  const approvalEngine = createApprovalEngine({ store, tools, audit, clock, registrySha });
  const artifacts = createArtifactService({ store, artifactStore, audit, clock, registrySha });
  return {
    store, audit, clock, broker, approvalEngine, artifacts, artifactStore, tools, outbox, invocations,
    setTime: (t) => { time = t; },
  };
}

function registerAgent(store, slug, o = {}) {
  const agentId = `agent-${slug}`;
  const versionState = o.versionState ?? VERSION_STATE.APPROVED;
  const version = makeAgentVersion({
    agent_id: agentId, version: o.version ?? '1.0.0', purpose: 'artifact test fixture', department: 'content',
    state: versionState, clearance: o.clearance ?? 'GREEN', allowed_tools: o.allowed_tools ?? [],
    limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 5_000 },
    input_contract: { required: [] }, output_contract: { required: [] }, created_at: 0,
    approved_by: versionState === VERSION_STATE.APPROVED ? 'founder' : null,
    approved_at: versionState === VERSION_STATE.APPROVED ? 0 : null,
  });
  store.addAgentVersion(version);
  store.registerAgent(makeAgent({
    id: agentId, slug, name: slug, lifecycle_state: o.lifecycleState ?? RUNTIME_STATE.ACTIVE,
    active_version_id: versionId(agentId, o.version ?? '1.0.0'),
  }));
  store.createTaskBudgets({ task_id: o.task_id ?? TASK, tree_id: o.workflow_id ?? TREE, agent_slug: slug, limit: 1_000 });
  return { agentId, version, versionId: versionId(agentId, o.version ?? '1.0.0') };
}

function createRealTask(store, task_id, o = {}) {
  const workflow_id = o.workflow_id ?? TREE;
  return store.createTask({
    id: task_id, parent_task_id: null, tree_id: workflow_id, workflow_id,
    depth: 0, signature: null, agent_slug: o.agent_slug ?? 'artifact-agent', agent_id: null,
    agent_version_id: null, depends_on: [], required_capability: null, input: {}, output: null,
    status: 'pending', attempt_number: 1, created_at: 0,
  });
}

function baseRequest(o = {}) {
  return {
    artifact_type: ARTIFACT_TYPE.RESEARCH,
    workflow_id: TREE,
    agent_slug: 'artifact-agent',
    content: { note: 'default fixture content' },
    mime_type: 'text/plain',
    ...o,
  };
}

// ── 1: valid artifact creation ───────────────────────────────────────────

test('395. a valid artifact is created with a generated id, checksum, and created_at', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const r = await artifacts.createArtifact(baseRequest());
  assert.equal(r.outcome, 'created');
  assert.equal(r.code, ARTIFACT_REASON.OK);
  assert.ok(r.artifact.artifact_id, 'a real id was generated');
  assert.equal(r.artifact.checksum.length, 64);
  assert.equal(r.artifact.created_at, T0);
  assert.equal(r.artifact.status, ARTIFACT_STATUS.COMPLETE);
});

// ── 2: every supported artifact type ─────────────────────────────────────

test('396. every registered artifact type can be created', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  assert.ok(allArtifactTypes().length >= 11);
  for (const artifact_type of allArtifactTypes()) {
    const r = await artifacts.createArtifact(baseRequest({ artifact_type, content: { type: artifact_type } }));
    assert.equal(r.outcome, 'created', `${artifact_type} should be creatable`);
    assert.equal(r.artifact.artifact_type, artifact_type);
  }
});

// ── 3: invalid artifact type ──────────────────────────────────────────────

test('397. an unknown artifact_type is rejected, fail closed', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const r = await artifacts.createArtifact(baseRequest({ artifact_type: 'NOT_A_REAL_TYPE' }));
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.code, ARTIFACT_REASON.UNKNOWN_ARTIFACT_TYPE);
});

test('398. missing workflow_id is rejected', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const r = await artifacts.createArtifact(baseRequest({ workflow_id: undefined }));
  assert.equal(r.code, ARTIFACT_REASON.MISSING_WORKFLOW_ID);
});

test('399. an unknown agent_slug is rejected', async () => {
  const { artifacts } = stackSetup();
  const r = await artifacts.createArtifact(baseRequest({ agent_slug: 'ghost-agent' }));
  assert.equal(r.code, ARTIFACT_REASON.UNKNOWN_AGENT);
});

// ── 4/5: provenance ────────────────────────────────────────────────────

test('400. correct provenance is recorded — agent, version, workflow, task, registry, parents, provider', async () => {
  const { store, artifacts } = stackSetup({ registrySha: 'sha-provenance' });
  const { agentId, versionId: vId } = registerAgent(store, 'artifact-agent');
  createRealTask(store, 'prov-task', { agent_slug: 'artifact-agent' });
  const r = await artifacts.createArtifact(baseRequest({
    task_id: 'prov-task', provider_id: 'provider-x', provider_version: 'v2', model_id: 'model-y',
  }));
  assert.equal(r.artifact.agent_id, agentId);
  assert.equal(r.artifact.version_id, vId);
  assert.equal(r.artifact.workflow_id, TREE);
  assert.equal(r.artifact.task_id, 'prov-task');
  assert.equal(r.artifact.registry_sha, 'sha-provenance');
  assert.deepEqual(r.artifact.provenance, {
    agent_id: agentId, version_id: vId, workflow_id: TREE, task_id: 'prov-task', registry_sha: 'sha-provenance',
    parent_artifact_ids: [], provider_id: 'provider-x', provider_version: 'v2', model_id: 'model-y',
  });
});

test('401. (missing/spoofed provenance) forged agent_id, version_id, registry_sha, provenance, artifact_id and created_at in the request are all ignored', async () => {
  const { store, artifacts } = stackSetup({ registrySha: 'sha-real' });
  const { agentId, versionId: vId } = registerAgent(store, 'artifact-agent');
  const r = await artifacts.createArtifact(baseRequest({
    artifact_id: 'FORGED-ID',
    agent_id: 'FORGED-AGENT',
    version_id: 'FORGED-VERSION',
    registry_sha: 'FORGED-SHA',
    created_at: 1,
    provenance: { agent_id: 'FORGED-AGENT' },
  }));
  assert.equal(r.outcome, 'created');
  assert.notEqual(r.artifact.artifact_id, 'FORGED-ID');
  assert.equal(r.artifact.agent_id, agentId);
  assert.equal(r.artifact.version_id, vId);
  assert.equal(r.artifact.registry_sha, 'sha-real');
  assert.equal(r.artifact.created_at, T0);
  assert.equal(r.artifact.provenance.agent_id, agentId);
});

test('402. a task_id that does not resolve to a real task is rejected', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const r = await artifacts.createArtifact(baseRequest({ task_id: 'ghost-task' }));
  assert.equal(r.code, ARTIFACT_REASON.UNKNOWN_TASK);
});

test('403. a task_id belonging to a different workflow is rejected', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  createRealTask(store, 'other-wf-task', { workflow_id: 'some-other-workflow', agent_slug: 'artifact-agent' });
  const r = await artifacts.createArtifact(baseRequest({ task_id: 'other-wf-task', workflow_id: TREE }));
  assert.equal(r.code, ARTIFACT_REASON.TASK_WORKFLOW_MISMATCH);
});

test('404. task_id may be omitted entirely — a workflow-level artifact', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const r = await artifacts.createArtifact(baseRequest());
  assert.equal(r.outcome, 'created');
  assert.equal(r.artifact.task_id, null);
});

// ── 6/7: immutability ──────────────────────────────────────────────────

test('405. the artifact store rejects re-adding the same artifact_id — immutable at the storage layer', async () => {
  const { store, artifacts, artifactStore } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const r = await artifacts.createArtifact(baseRequest());
  assert.throws(() => {
    artifactStore.addArtifact({ ...r.artifact, content: { note: 'a silent replacement attempt' } });
  }, /already exists/);
  // the original is unaffected
  const still = artifactStore.getArtifact(r.artifact.artifact_id);
  assert.deepEqual(still.content, { note: 'default fixture content' });
});

test('406. a returned artifact is deep-frozen — mutation of top-level and nested fields throws in strict mode', async () => {
  'use strict';
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const r = await artifacts.createArtifact(baseRequest());
  assert.throws(() => { r.artifact.checksum = 'tampered'; }, TypeError);
  assert.throws(() => { r.artifact.content.note = 'tampered'; }, TypeError);
  assert.throws(() => { r.artifact.parent_artifact_ids.push('x'); }, TypeError);
  assert.throws(() => { r.artifact.provenance.agent_id = 'tampered'; }, TypeError);
});

test('407. changing content means creating a NEW artifact that references the old one as a parent', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const v1 = await artifacts.createArtifact(baseRequest({ content: { draft: 1 } }));
  const v2 = await artifacts.createArtifact(baseRequest({
    content: { draft: 2 }, parent_artifact_ids: [v1.artifact.artifact_id],
  }));
  assert.equal(v2.outcome, 'created');
  assert.deepEqual(v2.artifact.parent_artifact_ids, [v1.artifact.artifact_id]);
  assert.notEqual(v2.artifact.artifact_id, v1.artifact.artifact_id);
  // v1 itself is untouched
  const v1Again = await artifacts.getArtifact(v1.artifact.artifact_id);
  assert.deepEqual(v1Again.content, { draft: 1 });
});

// ── 8/9: parent linkage ───────────────────────────────────────────────────

test('408. single-parent linkage is recorded and resolvable', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const research = await artifacts.createArtifact(baseRequest({ artifact_type: ARTIFACT_TYPE.RESEARCH }));
  const script = await artifacts.createArtifact(baseRequest({
    artifact_type: ARTIFACT_TYPE.SCRIPT, parent_artifact_ids: [research.artifact.artifact_id],
  }));
  assert.deepEqual(script.artifact.parent_artifact_ids, [research.artifact.artifact_id]);
  const children = await artifacts.childrenOf(research.artifact.artifact_id);
  assert.deepEqual(children.map((c) => c.artifact_id), [script.artifact.artifact_id]);
});

test('409. multiple parents (a DAG merge point) are recorded correctly', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const script = await artifacts.createArtifact(baseRequest({ artifact_type: ARTIFACT_TYPE.SCRIPT }));
  const audio = await artifacts.createArtifact(baseRequest({
    artifact_type: ARTIFACT_TYPE.AUDIO, parent_artifact_ids: [script.artifact.artifact_id],
  }));
  const visuals = await artifacts.createArtifact(baseRequest({
    artifact_type: ARTIFACT_TYPE.IMAGE, parent_artifact_ids: [script.artifact.artifact_id],
  }));
  const video = await artifacts.createArtifact(baseRequest({
    artifact_type: ARTIFACT_TYPE.VIDEO,
    parent_artifact_ids: [audio.artifact.artifact_id, visuals.artifact.artifact_id],
  }));
  assert.equal(video.outcome, 'created');
  assert.deepEqual(
    [...video.artifact.parent_artifact_ids].sort(),
    [audio.artifact.artifact_id, visuals.artifact.artifact_id].sort(),
  );
});

test('410. a missing parent is rejected', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const r = await artifacts.createArtifact(baseRequest({ parent_artifact_ids: ['does-not-exist'] }));
  assert.equal(r.code, ARTIFACT_REASON.PARENT_NOT_FOUND);
});

test('411. a malformed parent id (empty string, non-string) is rejected', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  assert.equal((await artifacts.createArtifact(baseRequest({ parent_artifact_ids: [''] }))).code, ARTIFACT_REASON.INVALID_PARENT_ID);
  assert.equal((await artifacts.createArtifact(baseRequest({ parent_artifact_ids: [42] }))).code, ARTIFACT_REASON.INVALID_PARENT_ID);
});

// ── 11: cycle detection ───────────────────────────────────────────────────

test('412. extending an already-corrupted cyclic chain is refused (defense in depth against a forged/direct store write)', async () => {
  const { store, artifacts, artifactStore } = stackSetup();
  registerAgent(store, 'artifact-agent');
  // A service-mediated creation can never produce a cycle (parents must
  // pre-exist) — so a cycle can only appear via a direct store write,
  // exactly as an attacker, a bug, or a corrupted row would produce.
  artifactStore.addArtifact(mkRawArtifact('cyc-a', { workflow_id: TREE, parent_artifact_ids: ['cyc-b'] }));
  artifactStore.addArtifact(mkRawArtifact('cyc-b', { workflow_id: TREE, parent_artifact_ids: ['cyc-a'] }));

  const r = await artifacts.createArtifact(baseRequest({ parent_artifact_ids: ['cyc-a'] }));
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.code, ARTIFACT_REASON.CYCLIC_LINEAGE);
});

test('413. a legitimate diamond lineage (two parents sharing a common ancestor) is NOT flagged as a cycle', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const script = await artifacts.createArtifact(baseRequest({ artifact_type: ARTIFACT_TYPE.SCRIPT }));
  const audio = await artifacts.createArtifact(baseRequest({
    artifact_type: ARTIFACT_TYPE.AUDIO, parent_artifact_ids: [script.artifact.artifact_id],
  }));
  const captions = await artifacts.createArtifact(baseRequest({
    artifact_type: ARTIFACT_TYPE.SUBTITLE, parent_artifact_ids: [script.artifact.artifact_id],
  }));
  // video converges audio and captions, both of which independently
  // trace back to the SAME script — a diamond, not a cycle.
  const video = await artifacts.createArtifact(baseRequest({
    artifact_type: ARTIFACT_TYPE.VIDEO,
    parent_artifact_ids: [audio.artifact.artifact_id, captions.artifact.artifact_id],
  }));
  assert.equal(video.outcome, 'created');
});

test('414. cross-workflow parent is rejected', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const other = await artifacts.createArtifact(baseRequest({ workflow_id: 'other-workflow' }));
  const r = await artifacts.createArtifact(baseRequest({
    workflow_id: TREE, parent_artifact_ids: [other.artifact.artifact_id],
  }));
  assert.equal(r.code, ARTIFACT_REASON.CROSS_WORKFLOW_PARENT);
});

// ── 13/14: checksum ────────────────────────────────────────────────────

test('415. checksum is generated deterministically and matches an independent recomputation', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const content = { a: 1, b: [1, 2, 3] };
  const r = await artifacts.createArtifact(baseRequest({ content }));
  assert.equal(r.artifact.checksum, checksumOf(content));
});

test('416. different content produces a different checksum', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const a = await artifacts.createArtifact(baseRequest({ content: { v: 1 } }));
  const b = await artifacts.createArtifact(baseRequest({ content: { v: 2 } }));
  assert.notEqual(a.artifact.checksum, b.artifact.checksum);
});

test('417. content_ref requires a well-formed 64-hex checksum and a non-negative integer size; malformed values are rejected', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const good = await artifacts.createArtifact(baseRequest({
    content: undefined, content_ref: 'blob://future/abc', mime_type: 'audio/mpeg', size: 4096, checksum: 'a'.repeat(64),
  }));
  assert.equal(good.outcome, 'created');
  assert.equal(good.artifact.checksum, 'a'.repeat(64));

  const badChecksum = await artifacts.createArtifact(baseRequest({
    content: undefined, content_ref: 'blob://future/abc', mime_type: 'audio/mpeg', size: 4096, checksum: 'not-hex',
  }));
  assert.equal(badChecksum.code, ARTIFACT_REASON.INVALID_CHECKSUM);

  const badSize = await artifacts.createArtifact(baseRequest({
    content: undefined, content_ref: 'blob://future/abc', mime_type: 'audio/mpeg', size: -5, checksum: 'a'.repeat(64),
  }));
  assert.equal(badSize.code, ARTIFACT_REASON.INVALID_SIZE);
});

test('418. exactly one of content or content_ref is required — both present or neither present is rejected', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const both = await artifacts.createArtifact(baseRequest({
    content: { x: 1 }, content_ref: 'blob://x', mime_type: 'text/plain', size: 1, checksum: 'a'.repeat(64),
  }));
  assert.equal(both.code, ARTIFACT_REASON.INVALID_CONTENT);

  const neither = await artifacts.createArtifact(baseRequest({ content: undefined, content_ref: undefined }));
  assert.equal(neither.code, ARTIFACT_REASON.INVALID_CONTENT);
});

test('419. an invalid mime_type is rejected', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const r = await artifacts.createArtifact(baseRequest({ mime_type: 'not-a-mime-type' }));
  assert.equal(r.code, ARTIFACT_REASON.INVALID_MIME_TYPE);
});

// ── 15: serialization/deserialization ────────────────────────────────────

test('420. serialization/deserialization round-trip preserves every field', async () => {
  const { store, artifacts, artifactStore } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const r = await artifacts.createArtifact(baseRequest({
    provider_id: 'p1', provider_version: 'v1', model_id: 'm1', generation_metadata: { steps: 3, tags: ['a', 'b'] },
  }));
  const roundTripped = JSON.parse(JSON.stringify(artifactStore.getArtifact(r.artifact.artifact_id)));
  assert.deepEqual(roundTripped, JSON.parse(JSON.stringify(r.artifact)));
  assert.equal(roundTripped.generation_metadata.steps, 3);
});

// ── 16: provider metadata ──────────────────────────────────────────────

test('421. provider metadata is recorded', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const r = await artifacts.createArtifact(baseRequest({
    provider_id: 'anthropic-like-provider', provider_version: '2026-01-01', model_id: 'some-model',
    generation_metadata: { prompt_tokens: 10, completion_tokens: 20 },
  }));
  assert.equal(r.artifact.provider_id, 'anthropic-like-provider');
  assert.equal(r.artifact.provider_version, '2026-01-01');
  assert.equal(r.artifact.model_id, 'some-model');
  assert.deepEqual(r.artifact.generation_metadata, { prompt_tokens: 10, completion_tokens: 20 });
});

test('422. malformed provider metadata is rejected', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  assert.equal((await artifacts.createArtifact(baseRequest({ provider_id: 42 }))).code, ARTIFACT_REASON.INVALID_PROVIDER_METADATA);
  assert.equal((await artifacts.createArtifact(baseRequest({ generation_metadata: ['not', 'an', 'object'] }))).code, ARTIFACT_REASON.INVALID_PROVIDER_METADATA);
  const circular = {};
  circular.self = circular;
  assert.equal((await artifacts.createArtifact(baseRequest({ generation_metadata: circular }))).code, ARTIFACT_REASON.INVALID_PROVIDER_METADATA);
});

// ── 17: lineage traversal ──────────────────────────────────────────────

test('423. lineage traversal returns the full multi-hop ancestor set', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const research = await artifacts.createArtifact(baseRequest({ artifact_type: ARTIFACT_TYPE.RESEARCH }));
  const script = await artifacts.createArtifact(baseRequest({
    artifact_type: ARTIFACT_TYPE.SCRIPT, parent_artifact_ids: [research.artifact.artifact_id],
  }));
  const audio = await artifacts.createArtifact(baseRequest({
    artifact_type: ARTIFACT_TYPE.AUDIO, parent_artifact_ids: [script.artifact.artifact_id],
  }));
  const video = await artifacts.createArtifact(baseRequest({
    artifact_type: ARTIFACT_TYPE.VIDEO, parent_artifact_ids: [audio.artifact.artifact_id],
  }));

  const lineage = await artifacts.lineageOf(video.artifact.artifact_id);
  const ids = lineage.ancestors.map((a) => a.artifact_id).sort();
  assert.deepEqual(ids, [audio.artifact.artifact_id, research.artifact.artifact_id, script.artifact.artifact_id].sort());
});

// ── 18: duplicate artifact id ──────────────────────────────────────────

test('424. a request cannot hijack an existing artifact_id — the service always generates a fresh one', async () => {
  const { store, artifacts, artifactStore } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const original = await artifacts.createArtifact(baseRequest());
  const attempt = await artifacts.createArtifact(baseRequest({
    artifact_id: original.artifact.artifact_id, content: { note: 'attempted hijack' },
  }));
  assert.equal(attempt.outcome, 'created');
  assert.notEqual(attempt.artifact.artifact_id, original.artifact.artifact_id);
  const originalStill = artifactStore.getArtifact(original.artifact.artifact_id);
  assert.deepEqual(originalStill.content, { note: 'default fixture content' });
});

// ── 19–24: security — artifacts cannot become an authorization mechanism ──

test('425. artifact_id spoofing cannot reassign ownership — provenance always reflects the real resolving agent', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent', { clearance: 'GREEN' });
  registerAgent(store, 'other-agent', { clearance: 'GREEN' });
  const mine = await artifacts.createArtifact(baseRequest({ agent_slug: 'artifact-agent' }));
  const theirs = await artifacts.createArtifact(baseRequest({ agent_slug: 'other-agent' }));
  assert.notEqual(mine.artifact.agent_id, theirs.artifact.agent_id);
  // Nothing about referencing "mine" as a parent from "theirs" changes
  // who created either record.
  const child = await artifacts.createArtifact(baseRequest({
    agent_slug: 'other-agent', parent_artifact_ids: [mine.artifact.artifact_id],
  }));
  assert.equal(child.artifact.agent_id, theirs.artifact.agent_id);
  assert.notEqual(child.artifact.agent_id, mine.artifact.agent_id);
});

test('426. an artifact cannot grant authorization — a YELLOW action with no approval is still denied regardless of any artifact created', async () => {
  const { store, broker, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent', { clearance: 'YELLOW', allowed_tools: ['fake.send_message'] });
  await artifacts.createArtifact(baseRequest({ agent_slug: 'artifact-agent', task_id: undefined }));
  const r = broker.execute({
    agent_slug: 'artifact-agent', tool_id: 'fake.send_message', task_id: TASK, tree_id: TREE,
    payload: { recipient_domain: 'approved-client.example', body: 'hi' }, idempotency_key: 'k-426',
  });
  assert.equal(r.decision, DECISION.NEEDS_APPROVAL);
});

test('427. an artifact cannot bypass approval — forged approval-shaped metadata on an artifact satisfies nothing', async () => {
  const { store, broker, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent', { clearance: 'YELLOW', allowed_tools: ['fake.send_message'] });
  await artifacts.createArtifact(baseRequest({
    agent_slug: 'artifact-agent', approval_status: ARTIFACT_APPROVAL_STATUS.APPROVED,
  }));
  const r = broker.execute({
    agent_slug: 'artifact-agent', tool_id: 'fake.send_message', task_id: TASK, tree_id: TREE,
    payload: { recipient_domain: 'approved-client.example', body: 'hi' }, idempotency_key: 'k-427',
  });
  assert.equal(r.decision, DECISION.NEEDS_APPROVAL, 'the Broker never reads approval_status off an artifact');
});

test('428. an artifact cannot bypass a Guardian freeze — creating one neither requires nor lifts a freeze', async () => {
  const { store, broker, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent', { clearance: 'GREEN', allowed_tools: ['text.wordcount'] });
  store.addFreeze({ scope: 'global', target_id: null, reason: 'test freeze', imposed_by: 'guardian', imposed_at: T0, expires_at: null });

  const r1 = await artifacts.createArtifact(baseRequest({ agent_slug: 'artifact-agent' }));
  assert.equal(r1.outcome, 'created', 'artifact creation is not gated by Guardian at all');

  const exec = broker.execute({
    agent_slug: 'artifact-agent', tool_id: 'text.wordcount', task_id: TASK, tree_id: TREE, payload: { text: 'hi' },
  });
  assert.equal(exec.decision, DECISION.DENY);
  assert.equal(exec.reason, REASON.GLOBAL_FREEZE, 'the freeze is completely unaffected by the artifact that was created');
});

test('429. artifact operations never change any budget', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const before = store.budgetsFor({ task_id: TASK, tree_id: TREE, agent_slug: 'artifact-agent' });
  await artifacts.createArtifact(baseRequest({ agent_slug: 'artifact-agent' }));
  const after = store.budgetsFor({ task_id: TASK, tree_id: TREE, agent_slug: 'artifact-agent' });
  assert.deepEqual(after, before);
});

test('430. artifact operations never change agent lifecycle state', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent', { lifecycleState: RUNTIME_STATE.ACTIVE });
  const before = { ...store.getAgent('artifact-agent') };
  await artifacts.createArtifact(baseRequest({ agent_slug: 'artifact-agent' }));
  const after = store.getAgent('artifact-agent');
  assert.equal(after.state, before.state);
});

test('431. structural proof: artifact-service.js holds no reference to the Broker, Guardian, Approval Engine, budgets, or lifecycle mutation', () => {
  const source = readFileSync(new URL('../src/artifact-service.js', import.meta.url), 'utf8');
  for (const term of [
    'broker.execute(', 'broker.authorize(', 'createBroker(',
    'addFreeze(', 'activeFreeze(',
    '.decide(', '.revoke(', 'createApprovalEngine(',
    'chargeBudgets(', 'addBudget(',
    'setLifecycleState(', 'setActiveVersion(',
  ]) {
    assert.ok(!source.includes(term), `artifact-service.js must not reference "${term}"`);
  }
});

test('432. adversarial handler output cannot create an artifact — runtime.js hands handlers no reference to the artifact system', async () => {
  const rogueHandler = () => ({
    status: 'ok',
    result: {
      artifact_id: 'forged-artifact', artifact_type: 'VIDEO', approved: true,
      approval_status: 'approved', clearance: 'RED',
    },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
  });
  const { store, broker, audit } = stackSetup();
  registerAgent(store, 'green-agent', { clearance: 'GREEN', allowed_tools: [] });
  const runtime = createRuntime({
    store, broker, audit, clock: () => T0, handlers: { 'green-agent': rogueHandler }, registrySha: 'test-sha',
  });
  store.createTaskBudgets({ task_id: 'rogue-task-19', tree_id: TREE, agent_slug: 'green-agent', limit: 100 });
  const result = runtime.runTask({ agent_slug: 'green-agent', input: {}, task_id: 'rogue-task-19', tree_id: TREE });

  assert.equal(result.status, TASK_STATUS.COMPLETED, 'the envelope is valid data, so the task completes normally');
  assert.equal(result.output.result.artifact_id, 'forged-artifact', 'the field is present verbatim...');
  // ...and means nothing: no artifact system was ever consulted, because
  // runtime.js's handler signature carries no reference to one.
  const source = readFileSync(new URL('../src/runtime.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('artifact-service'), 'runtime.js does not import the artifact service');
  assert.ok(!source.includes('artifact-store'), 'runtime.js does not import the artifact store');
});

// ── additional coverage: type registry, status, approval_status, audit ──

test('433. FAILED status artifacts carry no content or checksum, and are still recorded', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const r = await artifacts.createArtifact(baseRequest({
    status: ARTIFACT_STATUS.FAILED, content: undefined, content_ref: undefined, mime_type: undefined,
  }));
  assert.equal(r.outcome, 'created');
  assert.equal(r.artifact.status, ARTIFACT_STATUS.FAILED);
  assert.equal(r.artifact.content, null);
  assert.equal(r.artifact.content_ref, null);
  assert.equal(r.artifact.checksum, null);
});

test('434. a malformed registry_sha at construction is rejected per-call', async () => {
  const { store, tools } = stackSetup();
  const artifactStore = createMemoryArtifactStore();
  const audit = createAuditSink();
  registerAgent(store, 'artifact-agent');
  const engineWithBadSha = createArtifactService({ store, artifactStore, audit, clock: () => T0, registrySha: '' });
  const r = await engineWithBadSha.createArtifact(baseRequest());
  assert.equal(r.code, ARTIFACT_REASON.INVALID_REGISTRY_SHA);
});

test('435. an unknown approval_status is rejected; omitting it defaults to not_required', async () => {
  const { store, artifacts } = stackSetup();
  registerAgent(store, 'artifact-agent');
  const bad = await artifacts.createArtifact(baseRequest({ approval_status: 'not-a-real-status' }));
  assert.equal(bad.code, ARTIFACT_REASON.INVALID_APPROVAL_STATUS);

  const defaulted = await artifacts.createArtifact(baseRequest());
  assert.equal(defaulted.artifact.approval_status, ARTIFACT_APPROVAL_STATUS.NOT_REQUIRED);
});

test('436. creation and rejection are both audited, with no secret material', async () => {
  const { store, artifacts, audit } = stackSetup();
  registerAgent(store, 'artifact-agent');
  await artifacts.createArtifact(baseRequest());
  await artifacts.createArtifact(baseRequest({ artifact_type: 'GARBAGE' }));
  const events = audit.all().map((e) => e.event);
  assert.ok(events.includes('artifact.created'));
  assert.ok(events.includes('artifact.rejected'));
  for (const e of audit.all()) {
    assert.ok(!JSON.stringify(e).toLowerCase().includes('password'));
    assert.ok(!JSON.stringify(e).toLowerCase().includes('api_key'));
  }
});

test('437. the artifact store satisfies its own formal contract', () => {
  const { ok, errors } = checkArtifactStoreContract(createMemoryArtifactStore());
  assert.equal(ok, true, errors.join(' | '));
});

test('438. the artifact store exposes no update or delete method — immutability is structural, not merely checked', () => {
  const store = createMemoryArtifactStore();
  for (const forbidden of ['updateArtifact', 'deleteArtifact', 'setArtifact', 'removeArtifact', 'replaceArtifact']) {
    assert.equal(store[forbidden], undefined, `artifact store must not expose ${forbidden}`);
  }
});

function mkRawArtifact(artifact_id, o = {}) {
  return {
    artifact_id, artifact_type: ARTIFACT_TYPE.TEXT, status: ARTIFACT_STATUS.COMPLETE,
    workflow_id: o.workflow_id ?? TREE, task_id: null, agent_id: o.agent_id ?? 'agent-raw', version_id: null,
    registry_sha: null, parent_artifact_ids: o.parent_artifact_ids ?? [], content: { raw: true },
    content_ref: null, mime_type: 'text/plain', size: 10, checksum: 'a'.repeat(64), created_at: 0,
    provenance: {}, provider_id: null, provider_version: null, model_id: null, generation_metadata: null,
    approval_status: 'not_required',
  };
}

// ── Postgres: the same assertions against a real database ────────────────
//
// Every test above uses the in-memory store — proving the LOGIC. This
// section proves migration 0007 and postgres-artifact-store.js actually
// persist and return every field, including parent_artifact_ids via a
// real GIN-indexed containment query, against a genuine database — not
// just an object in memory. Skipped entirely — not failed — when
// AI_HQ_TEST_DATABASE_URL is unset.

const PG_TEST_URL = process.env.AI_HQ_TEST_DATABASE_URL;
if (PG_TEST_URL) {
  const { createPostgresStore } = await import('../src/postgres-store.js');
  const { createPostgresArtifactStore } = await import('../src/postgres-artifact-store.js');
  const { createIsolatedTestDatabase } = await import('./helpers/pg-test-db.mjs');
  const { pool, cleanup } = await createIsolatedTestDatabase('artifacts');
  const pgStore = createPostgresStore(pool);
  const pgArtifactStore = createPostgresArtifactStore(pool);

  async function pgRegisterAgent(slug, o = {}) {
    const agentId = `agent-${slug}`;
    const version = makeAgentVersion({
      agent_id: agentId, version: '1.0.0', purpose: 'pg artifact fixture', department: 'content',
      state: VERSION_STATE.APPROVED, clearance: o.clearance ?? 'GREEN', allowed_tools: o.allowed_tools ?? [],
      limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 5_000 },
      input_contract: { required: [] }, output_contract: { required: [] }, created_at: 0,
      approved_by: 'founder', approved_at: 0,
    });
    await pgStore.addAgentVersion(version);
    await pgStore.registerAgent(makeAgent({
      id: agentId, slug, name: slug, lifecycle_state: RUNTIME_STATE.ACTIVE,
      active_version_id: versionId(agentId, '1.0.0'),
    }));
    return { agentId, versionId: versionId(agentId, '1.0.0') };
  }

  test('439. [postgres] artifact creation round-trips every field through a real row', async () => {
    const audit = createAuditSink();
    const engine = createArtifactService({ store: pgStore, artifactStore: pgArtifactStore, audit, clock: () => T0, registrySha: 'pg-sha' });
    const { agentId, versionId: vId } = await pgRegisterAgent('pg-art-agent');
    const r = await engine.createArtifact(baseRequest({
      agent_slug: 'pg-art-agent', workflow_id: 'pg-wf-1', provider_id: 'p', provider_version: 'v', model_id: 'm',
      generation_metadata: { a: 1 },
    }));
    assert.equal(r.outcome, 'created');
    const fetched = await pgArtifactStore.getArtifact(r.artifact.artifact_id);
    assert.equal(fetched.agent_id, agentId);
    assert.equal(fetched.version_id, vId);
    assert.equal(fetched.checksum, r.artifact.checksum);
    assert.deepEqual(fetched.content, r.artifact.content);
    assert.deepEqual(fetched.generation_metadata, { a: 1 });
  });

  test('440. [postgres] duplicate artifact_id is rejected at the database layer', async () => {
    const audit = createAuditSink();
    const engine = createArtifactService({ store: pgStore, artifactStore: pgArtifactStore, audit, clock: () => T0, registrySha: 'pg-sha' });
    await pgRegisterAgent('pg-art-agent-2');
    const r = await engine.createArtifact(baseRequest({ agent_slug: 'pg-art-agent-2', workflow_id: 'pg-wf-2' }));
    await assert.rejects(
      async () => pgArtifactStore.addArtifact({ ...r.artifact }),
      /already exists/,
    );
  });

  test('441. [postgres] parent linkage and childrenOf via the real GIN index', async () => {
    const audit = createAuditSink();
    const engine = createArtifactService({ store: pgStore, artifactStore: pgArtifactStore, audit, clock: () => T0, registrySha: 'pg-sha' });
    await pgRegisterAgent('pg-art-agent-3');
    const parent = await engine.createArtifact(baseRequest({ agent_slug: 'pg-art-agent-3', workflow_id: 'pg-wf-3' }));
    const child = await engine.createArtifact(baseRequest({
      agent_slug: 'pg-art-agent-3', workflow_id: 'pg-wf-3', parent_artifact_ids: [parent.artifact.artifact_id],
    }));
    const children = await pgArtifactStore.childrenOf(parent.artifact.artifact_id);
    assert.deepEqual(children.map((c) => c.artifact_id), [child.artifact.artifact_id]);
  });

  test('442. [postgres] the artifact_type CHECK constraint rejects a garbage type', async () => {
    await assert.rejects(
      async () => pool.query(
        `insert into public.artifacts (artifact_id, artifact_type, workflow_id, created_at) values ($1,$2,$3,$4)`,
        ['pg-bad-type', 'NOT_A_REAL_TYPE', 'pg-wf-4', 0],
      ),
      /violates check constraint/,
    );
  });

  test('443. [postgres] cycle detection works against real ancestry data', async () => {
    const audit = createAuditSink();
    const engine = createArtifactService({ store: pgStore, artifactStore: pgArtifactStore, audit, clock: () => T0, registrySha: 'pg-sha' });
    const { agentId } = await pgRegisterAgent('pg-art-agent-5');
    await pgArtifactStore.addArtifact(mkRawArtifact('pg-cyc-a', { workflow_id: 'pg-wf-5', parent_artifact_ids: ['pg-cyc-b'], agent_id: agentId }));
    await pgArtifactStore.addArtifact(mkRawArtifact('pg-cyc-b', { workflow_id: 'pg-wf-5', parent_artifact_ids: ['pg-cyc-a'], agent_id: agentId }));
    const r = await engine.createArtifact(baseRequest({
      agent_slug: 'pg-art-agent-5', workflow_id: 'pg-wf-5', parent_artifact_ids: ['pg-cyc-a'],
    }));
    assert.equal(r.code, ARTIFACT_REASON.CYCLIC_LINEAGE);
  });

  test('[postgres artifacts] teardown: drop the isolated test database', async () => {
    await cleanup();
  });
} else {
  test('[postgres artifacts] skipped — set AI_HQ_TEST_DATABASE_URL to run against a local Postgres', { skip: true }, () => {});
}

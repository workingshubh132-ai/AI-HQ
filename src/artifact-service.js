/**
 * ARTIFACT SERVICE (Milestone 19)
 *
 * The one governed path that creates a content artifact, plus the read
 * paths (`getArtifact`, `childrenOf`, `lineageOf`) that traverse them.
 *
 * ── NOT AN AUTHORIZATION BOUNDARY ────────────────────────────────────────
 *
 * `createArtifact` decides whether a REQUEST IS WELL-FORMED — a real
 * agent, a real task in the declared workflow, real and same-workflow
 * parents, no cycle, a coherent content/checksum/mime_type triple. It
 * never decides whether the agent was ALLOWED to produce this artifact —
 * that already happened, upstream, via the Broker/Guardian/Approval
 * Engine, before whatever called this function got here. This file holds
 * no reference to `broker.execute`, `broker.authorize`, Guardian's
 * `activeFreeze`/`addFreeze`, the Approval Engine's `decide`/`revoke`, or
 * any budget-charging method — structurally, not just by convention (see
 * tests/artifacts.test.js's grep-based proof). Recording provenance is
 * not an authorization decision, and gating creation on lifecycle or
 * clearance here would risk this file quietly becoming a second
 * enforcement point — exactly what the M19 directive forbids. See
 * DECISIONS.md D36.
 *
 * ── ANTI-IMPERSONATION ───────────────────────────────────────────────────
 *
 * A creation request supplies `agent_slug` — the same trust boundary
 * every other governed path in this codebase already accepts (compare
 * `approval-engine.js`'s `requestApproval`). This file NEVER reads
 * `agent_id`, `version_id`, `registry_sha`, `artifact_id`, `created_at`,
 * or `provenance` from the request object — even if present, they are
 * ignored. The real `agent_id`/`version_id` are re-derived from
 * `store.getAgent(agent_slug)`; `registry_sha` comes only from this
 * service's own constructor injection (mirroring `createBroker`'s and
 * `createApprovalEngine`'s identical `registrySha` parameter); `provenance`
 * is a DERIVED, read-only view built from those already-validated fields,
 * never accepted as input. An agent cannot make an artifact appear to
 * have been produced by a different agent, version, or build.
 *
 * ── IMMUTABILITY ──────────────────────────────────────────────────────────
 *
 * If content needs to change, this file creates a NEW artifact
 * referencing the previous one as a parent — it has no update path,
 * because `artifact-store.js` exposes none.
 *
 * ── ASYNC BY DESIGN, LIKE M17/M18 — NOT WIRED INTO THE SYNCHRONOUS CORE ──
 *
 * Every store call in `createArtifact` is `await`ed, deliberately,
 * following the exact fix M17's `agent-lifecycle.js` and M18's
 * `approval-engine.js` made after finding the same class of bug: an
 * unawaited call against a real async Postgres store returns a pending
 * Promise, always truthy, which silently defeats an `if (!x)` check.
 * `createArtifact` is not on broker.js/runtime.js/workflow.js/router.js/
 * guardian.js's synchronous hot path (D28), so there is no boundary to
 * preserve by staying synchronous — being genuinely async is what makes
 * it genuinely portable to both the in-memory and Postgres artifact
 * stores, proven directly by running the same assertions against both.
 *
 * ── createArtifactSync — M20's ONE EXCEPTION, NARROWLY SCOPED ────────────
 *
 * M20 wires artifact creation into `runtime.js`'s handler execution,
 * which is (D28) synchronous and always will be against anything but the
 * in-memory store. A handler cannot `await` — it is called as a plain
 * function — so it needs a genuinely synchronous entry point, not a
 * Promise it cannot resolve inline. `createArtifactSync` is that entry
 * point: the SAME validation rules (the same imported checks, the SAME
 * `hasCycle` function below), called without `await`, safe ONLY against
 * the in-memory store and the in-memory artifact store — which is all
 * `runtime.js` ever runs against (D28), so this is an existing
 * constraint restated, not a new one. It guards against its own misuse:
 * if any store call returns something Promise-shaped (i.e., it was
 * handed a real async store by mistake), it throws immediately rather
 * than silently reading `undefined` off an unawaited Promise — the exact
 * failure mode M17-M19 each found and fixed, closed here by construction
 * instead of by discovery. See DECISIONS.md D37.
 */

import { randomUUID } from 'node:crypto';
import {
  ARTIFACT_REASON, ARTIFACT_STATUS, ARTIFACT_APPROVAL_STATUS,
  isKnownArtifactType, isNonEmptyString, isValidMimeType, isValidChecksum,
  checksumOf, byteSizeOf, isSerializableMetadata,
} from './artifacts.js';

/** Defensive bound on ancestor traversal — not a product requirement,
 * a safety valve against a pathological or adversarially corrupted
 * store causing an unbounded walk. No legitimate lineage in this system
 * approaches this depth. */
const MAX_LINEAGE_NODES = 10_000;

/**
 * True if, starting at `startId` and walking `parent_artifact_ids` edges
 * as recorded in the store, the SAME node is revisited while still on
 * the current path (a back-edge) — the standard "node on the active
 * recursion stack" cycle test, not a plain "seen before" set. A plain
 * seen-before set would wrongly reject a legitimate DIAMOND lineage —
 * e.g. `video`'s parents `audio` and `visuals` both descending from the
 * same `script` — which is explicitly a valid DAG shape per the M19
 * directive's own examples, not a cycle.
 *
 * Because `createArtifact` only ever links a NEW artifact to
 * ALREADY-EXISTING parents, the store this function walks is, by
 * construction, always acyclic when built exclusively through this
 * service. This check exists as defense in depth against a store
 * corrupted or extended by some other path (a forged direct insert, a
 * bug, a future caller) — see DECISIONS.md D36.
 *
 * @param {(id:string) => object|null} getArtifact synchronous lookup
 * @param {string} startId
 * @returns {boolean}
 */
function hasCycle(getArtifact, startId) {
  const onPath = new Set();
  const done = new Set();
  let guard = 0;

  function visit(id) {
    if (done.has(id)) return false;
    if (onPath.has(id)) return true;
    if (++guard > MAX_LINEAGE_NODES) return true;
    onPath.add(id);
    const node = getArtifact(id);
    if (node) {
      for (const parentId of node.parent_artifact_ids) {
        if (visit(parentId)) return true;
      }
    }
    onPath.delete(id);
    done.add(id);
    return false;
  }

  return visit(startId);
}

/** Throws loudly if `value` looks like a Promise, rather than letting a
 * synchronous caller silently treat a pending Promise as data — see
 * `createArtifactSync`'s header comment above. */
function assertNotPromise(value, where) {
  if (value !== null && typeof value === 'object' && typeof value.then === 'function') {
    throw new Error(
      `createArtifactSync: ${where} returned a Promise. createArtifactSync is only safe against ` +
        'the synchronous in-memory store and artifact store — use the async createArtifact against ' +
        'a Postgres-backed store instead.',
    );
  }
  return value;
}

/**
 * @param {object} deps
 * @param {object} deps.store the MAIN storage-contract store — used only
 *   to resolve the real agent identity (`getAgent`) and, when a task_id
 *   is supplied, to verify it (`getTask`). Never written to.
 * @param {object} deps.artifactStore an ARTIFACT_STORE_CONTRACT-conforming
 *   store (see artifact-store.js) — memory or Postgres.
 * @param {object} deps.audit
 * @param {() => number} deps.clock
 * @param {string|null} [deps.registrySha] identity of the code that ran,
 *   same convention as createBroker/createApprovalEngine/
 *   createAgentLifecycle. Optional; null means "not tracked."
 */
export function createArtifactService({ store, artifactStore, audit, clock, registrySha = null }) {
  function writeAudit(event, fields) {
    audit.write({ event, at: clock(), registry_sha: registrySha, ...fields });
  }

  function generateArtifactId() {
    // Clock prefix for log readability; randomUUID() is what actually
    // guarantees uniqueness across instances sharing a clock tick — the
    // exact lesson M18's approval_id collision bug taught (DECISIONS.md
    // D35), applied here from the start instead of relearned.
    return `artifact-${clock()}-${randomUUID()}`;
  }

  /**
   * The one governed creation path. Never mutates an existing artifact;
   * never auto-approves anything; never trusts caller-supplied identity.
   *
   * @param {object} request
   * @returns {Promise<{outcome:string, code:string, artifact?:object, detail?:string}>}
   */
  async function createArtifact(request = {}) {
    const fail = (code, detail) => {
      const record = { outcome: 'rejected', code, detail: detail ?? null };
      writeAudit('artifact.rejected', record);
      return record;
    };

    if (!request || typeof request !== 'object') return fail(ARTIFACT_REASON.MISSING_ARTIFACT_ID, 'request must be an object');

    // 1 — artifact type
    if (!isKnownArtifactType(request.artifact_type)) {
      return fail(ARTIFACT_REASON.UNKNOWN_ARTIFACT_TYPE, request.artifact_type);
    }

    // 2 — status
    const status = request.status ?? ARTIFACT_STATUS.COMPLETE;
    if (status !== ARTIFACT_STATUS.COMPLETE && status !== ARTIFACT_STATUS.FAILED) {
      return fail(ARTIFACT_REASON.INVALID_STATUS, status);
    }

    // 3 — workflow identity
    if (!isNonEmptyString(request.workflow_id)) {
      return fail(ARTIFACT_REASON.MISSING_WORKFLOW_ID);
    }
    const workflow_id = request.workflow_id;

    // 4 — agent identity, RE-DERIVED — never trusted from the request
    if (!isNonEmptyString(request.agent_slug)) {
      return fail(ARTIFACT_REASON.UNKNOWN_AGENT, 'agent_slug is required');
    }
    const agent = await store.getAgent(request.agent_slug);
    if (!agent) return fail(ARTIFACT_REASON.UNKNOWN_AGENT, request.agent_slug);
    const agent_id = agent.agent_id;
    const version_id = agent.version_id ?? null;

    // 5 — task identity, when supplied, must resolve and belong to this workflow
    let task_id = null;
    if (request.task_id !== undefined && request.task_id !== null) {
      if (!isNonEmptyString(request.task_id)) return fail(ARTIFACT_REASON.UNKNOWN_TASK, request.task_id);
      const task = await store.getTask(request.task_id);
      if (!task) return fail(ARTIFACT_REASON.UNKNOWN_TASK, request.task_id);
      // tree_id IS workflow_id throughout this codebase (see workflow.js's
      // own header comment); some fixtures set only one of the two.
      const taskWorkflowId = task.workflow_id ?? task.tree_id ?? null;
      if (taskWorkflowId !== workflow_id) return fail(ARTIFACT_REASON.TASK_WORKFLOW_MISMATCH, request.task_id);
      task_id = request.task_id;
    }

    // 6 — registry SHA (constructor-injected; validated per-call too,
    // per the directive's explicit "invalid registry SHA" requirement)
    if (registrySha != null && !isNonEmptyString(registrySha)) {
      return fail(ARTIFACT_REASON.INVALID_REGISTRY_SHA, registrySha);
    }

    // 7 — parents: existence, same-workflow, and no cycle
    const parentIdsInput = request.parent_artifact_ids ?? [];
    if (!Array.isArray(parentIdsInput)) return fail(ARTIFACT_REASON.INVALID_PARENT_ID, 'parent_artifact_ids must be an array');
    const parent_artifact_ids = [];
    for (const pid of parentIdsInput) {
      if (!isNonEmptyString(pid)) return fail(ARTIFACT_REASON.INVALID_PARENT_ID, pid);
      const parent = await artifactStore.getArtifact(pid);
      if (!parent) return fail(ARTIFACT_REASON.PARENT_NOT_FOUND, pid);
      if (parent.workflow_id !== workflow_id) return fail(ARTIFACT_REASON.CROSS_WORKFLOW_PARENT, pid);
      parent_artifact_ids.push(pid);
    }
    // Synchronous lookup closure for hasCycle — artifactStore.getArtifact
    // may be async (Postgres); resolve every candidate ancestor's data
    // up front so the cycle walk itself can stay synchronous recursion.
    const ancestryCache = new Map();
    for (const pid of parent_artifact_ids) {
      await cacheAncestry(artifactStore, pid, ancestryCache);
    }
    const cachedGet = (id) => ancestryCache.get(id) ?? null;
    for (const pid of parent_artifact_ids) {
      if (hasCycle(cachedGet, pid)) return fail(ARTIFACT_REASON.CYCLIC_LINEAGE, pid);
    }

    // 8 — content / content_ref
    const hasInline = request.content !== undefined && request.content !== null;
    const hasRef = isNonEmptyString(request.content_ref);
    let content = null;
    let content_ref = null;
    let mime_type = null;
    let size = null;
    let checksum = null;

    if (status === ARTIFACT_STATUS.FAILED) {
      if (hasInline || hasRef) return fail(ARTIFACT_REASON.INVALID_CONTENT, 'a FAILED artifact must carry no content');
    } else {
      if (hasInline === hasRef) {
        return fail(ARTIFACT_REASON.INVALID_CONTENT, 'exactly one of content or content_ref is required');
      }
      if (!isValidMimeType(request.mime_type)) return fail(ARTIFACT_REASON.INVALID_MIME_TYPE, request.mime_type);
      mime_type = request.mime_type;

      if (hasInline) {
        content = request.content;
        // Derived, never trusted from the caller — the same reasoning
        // M4.5/M4.6 already established for payload hashing: the human
        // (here, any downstream consumer) must be able to trust the
        // checksum independent of what the producer claims.
        checksum = checksumOf(content);
        size = byteSizeOf(content);
      } else {
        content_ref = request.content_ref;
        if (!Number.isInteger(request.size) || request.size < 0) {
          return fail(ARTIFACT_REASON.INVALID_SIZE, request.size);
        }
        size = request.size;
        if (!isValidChecksum(request.checksum)) return fail(ARTIFACT_REASON.INVALID_CHECKSUM, request.checksum);
        checksum = request.checksum;
      }
    }

    // 9 — provider metadata (informational only, never authorization)
    for (const [key, value] of Object.entries({
      provider_id: request.provider_id, provider_version: request.provider_version, model_id: request.model_id,
    })) {
      if (value !== undefined && value !== null && !isNonEmptyString(value)) {
        return fail(ARTIFACT_REASON.INVALID_PROVIDER_METADATA, key);
      }
    }
    if (!isSerializableMetadata(request.generation_metadata ?? null)) {
      return fail(ARTIFACT_REASON.INVALID_PROVIDER_METADATA, 'generation_metadata');
    }

    // 10 — approval_status: descriptive only, reusing the Approval
    // Engine's own vocabulary (see artifacts.js's header comment)
    const approval_status = request.approval_status ?? ARTIFACT_APPROVAL_STATUS.NOT_REQUIRED;
    if (!Object.values(ARTIFACT_APPROVAL_STATUS).includes(approval_status)) {
      return fail(ARTIFACT_REASON.INVALID_APPROVAL_STATUS, approval_status);
    }

    const artifact_id = generateArtifactId();
    const created_at = clock();

    const provenance = {
      agent_id, version_id, workflow_id, task_id, registry_sha: registrySha,
      parent_artifact_ids, provider_id: request.provider_id ?? null,
      provider_version: request.provider_version ?? null, model_id: request.model_id ?? null,
    };

    const artifact = {
      artifact_id,
      artifact_type: request.artifact_type,
      status,
      workflow_id,
      task_id,
      agent_id,
      version_id,
      registry_sha: registrySha,
      parent_artifact_ids,
      content,
      content_ref,
      mime_type,
      size,
      checksum,
      created_at,
      provenance,
      provider_id: request.provider_id ?? null,
      provider_version: request.provider_version ?? null,
      model_id: request.model_id ?? null,
      generation_metadata: request.generation_metadata ?? null,
      approval_status,
    };

    const stored = await artifactStore.addArtifact(artifact);
    writeAudit('artifact.created', {
      outcome: 'created', code: ARTIFACT_REASON.OK, artifact_id, artifact_type: artifact.artifact_type,
      agent_id, version_id, workflow_id, task_id, checksum,
    });
    return { outcome: 'created', code: ARTIFACT_REASON.OK, artifact: stored };
  }

  /**
   * The synchronous twin of `createArtifact` — same rules, same reason
   * codes, same anti-impersonation and lineage checks, called without
   * `await`. See this file's header ("createArtifactSync — M20's ONE
   * EXCEPTION") for why this exists and what it must never be used
   * against.
   *
   * @param {object} request
   * @returns {{outcome:string, code:string, artifact?:object, detail?:string}}
   */
  function createArtifactSync(request = {}) {
    const fail = (code, detail) => {
      const record = { outcome: 'rejected', code, detail: detail ?? null };
      writeAudit('artifact.rejected', record);
      return record;
    };

    if (!request || typeof request !== 'object') return fail(ARTIFACT_REASON.MISSING_ARTIFACT_ID, 'request must be an object');

    if (!isKnownArtifactType(request.artifact_type)) {
      return fail(ARTIFACT_REASON.UNKNOWN_ARTIFACT_TYPE, request.artifact_type);
    }

    const status = request.status ?? ARTIFACT_STATUS.COMPLETE;
    if (status !== ARTIFACT_STATUS.COMPLETE && status !== ARTIFACT_STATUS.FAILED) {
      return fail(ARTIFACT_REASON.INVALID_STATUS, status);
    }

    if (!isNonEmptyString(request.workflow_id)) {
      return fail(ARTIFACT_REASON.MISSING_WORKFLOW_ID);
    }
    const workflow_id = request.workflow_id;

    if (!isNonEmptyString(request.agent_slug)) {
      return fail(ARTIFACT_REASON.UNKNOWN_AGENT, 'agent_slug is required');
    }
    const agent = assertNotPromise(store.getAgent(request.agent_slug), 'store.getAgent');
    if (!agent) return fail(ARTIFACT_REASON.UNKNOWN_AGENT, request.agent_slug);
    const agent_id = agent.agent_id;
    const version_id = agent.version_id ?? null;

    let task_id = null;
    if (request.task_id !== undefined && request.task_id !== null) {
      if (!isNonEmptyString(request.task_id)) return fail(ARTIFACT_REASON.UNKNOWN_TASK, request.task_id);
      const task = assertNotPromise(store.getTask(request.task_id), 'store.getTask');
      if (!task) return fail(ARTIFACT_REASON.UNKNOWN_TASK, request.task_id);
      const taskWorkflowId = task.workflow_id ?? task.tree_id ?? null;
      if (taskWorkflowId !== workflow_id) return fail(ARTIFACT_REASON.TASK_WORKFLOW_MISMATCH, request.task_id);
      task_id = request.task_id;
    }

    if (registrySha != null && !isNonEmptyString(registrySha)) {
      return fail(ARTIFACT_REASON.INVALID_REGISTRY_SHA, registrySha);
    }

    const parentIdsInput = request.parent_artifact_ids ?? [];
    if (!Array.isArray(parentIdsInput)) return fail(ARTIFACT_REASON.INVALID_PARENT_ID, 'parent_artifact_ids must be an array');
    const parent_artifact_ids = [];
    const syncGetArtifact = (id) => assertNotPromise(artifactStore.getArtifact(id), 'artifactStore.getArtifact');
    for (const pid of parentIdsInput) {
      if (!isNonEmptyString(pid)) return fail(ARTIFACT_REASON.INVALID_PARENT_ID, pid);
      const parent = syncGetArtifact(pid);
      if (!parent) return fail(ARTIFACT_REASON.PARENT_NOT_FOUND, pid);
      if (parent.workflow_id !== workflow_id) return fail(ARTIFACT_REASON.CROSS_WORKFLOW_PARENT, pid);
      parent_artifact_ids.push(pid);
    }
    // No async ancestry pre-caching needed here (unlike createArtifact):
    // artifactStore.getArtifact is itself already synchronous against the
    // in-memory store, so hasCycle can call it directly.
    for (const pid of parent_artifact_ids) {
      if (hasCycle(syncGetArtifact, pid)) return fail(ARTIFACT_REASON.CYCLIC_LINEAGE, pid);
    }

    const hasInline = request.content !== undefined && request.content !== null;
    const hasRef = isNonEmptyString(request.content_ref);
    let content = null;
    let content_ref = null;
    let mime_type = null;
    let size = null;
    let checksum = null;

    if (status === ARTIFACT_STATUS.FAILED) {
      if (hasInline || hasRef) return fail(ARTIFACT_REASON.INVALID_CONTENT, 'a FAILED artifact must carry no content');
    } else {
      if (hasInline === hasRef) {
        return fail(ARTIFACT_REASON.INVALID_CONTENT, 'exactly one of content or content_ref is required');
      }
      if (!isValidMimeType(request.mime_type)) return fail(ARTIFACT_REASON.INVALID_MIME_TYPE, request.mime_type);
      mime_type = request.mime_type;

      if (hasInline) {
        content = request.content;
        checksum = checksumOf(content);
        size = byteSizeOf(content);
      } else {
        content_ref = request.content_ref;
        if (!Number.isInteger(request.size) || request.size < 0) {
          return fail(ARTIFACT_REASON.INVALID_SIZE, request.size);
        }
        size = request.size;
        if (!isValidChecksum(request.checksum)) return fail(ARTIFACT_REASON.INVALID_CHECKSUM, request.checksum);
        checksum = request.checksum;
      }
    }

    for (const [key, value] of Object.entries({
      provider_id: request.provider_id, provider_version: request.provider_version, model_id: request.model_id,
    })) {
      if (value !== undefined && value !== null && !isNonEmptyString(value)) {
        return fail(ARTIFACT_REASON.INVALID_PROVIDER_METADATA, key);
      }
    }
    if (!isSerializableMetadata(request.generation_metadata ?? null)) {
      return fail(ARTIFACT_REASON.INVALID_PROVIDER_METADATA, 'generation_metadata');
    }

    const approval_status = request.approval_status ?? ARTIFACT_APPROVAL_STATUS.NOT_REQUIRED;
    if (!Object.values(ARTIFACT_APPROVAL_STATUS).includes(approval_status)) {
      return fail(ARTIFACT_REASON.INVALID_APPROVAL_STATUS, approval_status);
    }

    const artifact_id = generateArtifactId();
    const created_at = clock();

    const provenance = {
      agent_id, version_id, workflow_id, task_id, registry_sha: registrySha,
      parent_artifact_ids, provider_id: request.provider_id ?? null,
      provider_version: request.provider_version ?? null, model_id: request.model_id ?? null,
    };

    const artifact = {
      artifact_id,
      artifact_type: request.artifact_type,
      status,
      workflow_id,
      task_id,
      agent_id,
      version_id,
      registry_sha: registrySha,
      parent_artifact_ids,
      content,
      content_ref,
      mime_type,
      size,
      checksum,
      created_at,
      provenance,
      provider_id: request.provider_id ?? null,
      provider_version: request.provider_version ?? null,
      model_id: request.model_id ?? null,
      generation_metadata: request.generation_metadata ?? null,
      approval_status,
    };

    const stored = assertNotPromise(artifactStore.addArtifact(artifact), 'artifactStore.addArtifact');
    writeAudit('artifact.created', {
      outcome: 'created', code: ARTIFACT_REASON.OK, artifact_id, artifact_type: artifact.artifact_type,
      agent_id, version_id, workflow_id, task_id, checksum,
    });
    return { outcome: 'created', code: ARTIFACT_REASON.OK, artifact: stored };
  }

  async function getArtifact(artifact_id) {
    return artifactStore.getArtifact(artifact_id);
  }

  async function childrenOf(artifact_id) {
    return artifactStore.childrenOf(artifact_id);
  }

  /**
   * Full ancestor set of `artifact_id`, via a plain visited-set walk —
   * safe on a possibly-corrupted/cyclic store because each node is
   * visited at most once regardless (unlike `hasCycle`, this does not
   * need path-tracking: it only needs to terminate and be complete, not
   * to distinguish a back-edge from a converging diamond edge).
   *
   * @returns {Promise<{artifact:object|null, ancestors:object[]}>}
   */
  async function lineageOf(artifact_id) {
    const artifact = await artifactStore.getArtifact(artifact_id);
    if (!artifact) return { artifact: null, ancestors: [] };

    const visited = new Set([artifact_id]);
    const ancestors = [];
    const queue = [...artifact.parent_artifact_ids];
    let guard = 0;
    while (queue.length) {
      if (++guard > MAX_LINEAGE_NODES) break;
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      const node = await artifactStore.getArtifact(id);
      if (!node) continue;
      ancestors.push(node);
      queue.push(...node.parent_artifact_ids);
    }
    return { artifact, ancestors };
  }

  return { createArtifact, createArtifactSync, getArtifact, childrenOf, lineageOf };
}

/** Populates `cache` with `artifactId` and every ancestor reachable from
 * it, resolved through the (possibly async) artifactStore, so the
 * synchronous `hasCycle` walk has everything it needs already in hand. */
async function cacheAncestry(artifactStore, artifactId, cache) {
  if (cache.has(artifactId)) return;
  const node = await artifactStore.getArtifact(artifactId);
  cache.set(artifactId, node);
  if (!node) return;
  for (const parentId of node.parent_artifact_ids) {
    await cacheAncestry(artifactStore, parentId, cache);
  }
}

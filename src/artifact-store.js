/**
 * ARTIFACT STORE
 *
 * A deliberately SEPARATE storage abstraction from `storage.js`'s
 * `STORAGE_CONTRACT` — not an extension of it. `STORAGE_CONTRACT` is "the
 * state every backend must satisfy for the Broker" (agents, approvals,
 * freezes, budgets, idempotency); artifacts are never read by the Broker,
 * Guardian, or Approval Engine, so folding them into that contract would
 * conflate two genuinely different concerns for no benefit — exactly the
 * "duplicate persistence interfaces unnecessarily" this milestone's
 * directive warns against, just in the other direction. See
 * DECISIONS.md D36.
 *
 * The shape mirrors `storage.js`/`store.js` on purpose: a frozen
 * method:arity contract, a structural checker, and a reference in-memory
 * implementation that self-checks against it at construction — the same
 * pattern that has already caught real drift bugs in this codebase
 * (`postgres-store.js`'s M18 gaps, found by exactly this kind of check).
 *
 * Four methods, and — deliberately — nothing else. There is no update,
 * no delete, no replace. Immutability here is not a checked rule; it is
 * the absence of any code path that could violate it, the same design
 * `audit.js` already uses for its own append-only records ("not because
 * they are guarded, but because they do not exist").
 */

export const ARTIFACT_STORE_CONTRACT = Object.freeze({
  // Throws on a duplicate artifact_id — the one enforcement point
  // immutability actually needs. Returns the stored artifact.
  addArtifact: 1,
  // Returns null for an unknown id, never throws — same convention
  // storage.js's STORAGE_INVARIANTS already establishes for getAgent/
  // getTask/etc.
  getArtifact: 1,
  // Every artifact recorded under this workflow_id, any order.
  artifactsForWorkflow: 1,
  // Every artifact whose own parent_artifact_ids includes this id —
  // the DAG's forward edges, for lineage traversal (see
  // artifact-service.js's lineageOf).
  childrenOf: 1,
});

/**
 * @param {object} candidate
 * @returns {{ok: boolean, errors: string[]}}
 */
export function checkArtifactStoreContract(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, errors: ['candidate is not an object'] };
  }
  for (const [method, arity] of Object.entries(ARTIFACT_STORE_CONTRACT)) {
    const fn = candidate[method];
    if (typeof fn !== 'function') {
      errors.push(`missing method: ${method}`);
      continue;
    }
    if (fn.length !== arity) {
      errors.push(`${method}: expected arity ${arity}, got ${fn.length}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * @param {object} candidate
 * @param {string} [label]
 */
export function assertArtifactStoreContract(candidate, label = 'artifactStore') {
  const { ok, errors } = checkArtifactStoreContract(candidate);
  if (!ok) {
    throw new Error(`${label} does not satisfy ARTIFACT_STORE_CONTRACT: ${errors.join(' | ')}`);
  }
}

/**
 * Recursively freezes `value` in place. Used so a returned artifact's
 * nested `content`/`provenance`/`generation_metadata` objects cannot be
 * mutated through a shared reference — a plain `Object.freeze` only
 * locks the top level, and "artifact content mutation" is exactly what
 * this milestone requires be impossible, not merely discouraged.
 */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * @param {object} [seed]
 * @param {object[]} [seed.artifacts]
 * @returns {object} a conforming, empty (or seeded) in-memory artifact store
 */
export function createMemoryArtifactStore(seed = {}) {
  return finish(buildMemoryArtifactStore(seed));
}

function finish(store) {
  assertArtifactStoreContract(store, 'createMemoryArtifactStore()');
  return store;
}

function buildMemoryArtifactStore(seed = {}) {
  /** @type {Map<string, object>} artifact_id -> frozen artifact record */
  const artifacts = new Map((seed.artifacts ?? []).map((a) => [a.artifact_id, deepFreeze({ ...a })]));

  return {
    addArtifact(artifact) {
      if (artifacts.has(artifact.artifact_id)) {
        throw new Error(`artifact ${artifact.artifact_id} already exists — artifacts are immutable`);
      }
      const frozen = deepFreeze({ ...artifact });
      artifacts.set(artifact.artifact_id, frozen);
      return frozen;
    },

    getArtifact(artifactId) {
      return artifacts.has(artifactId) ? artifacts.get(artifactId) : null;
    },

    artifactsForWorkflow(workflowId) {
      return [...artifacts.values()].filter((a) => a.workflow_id === workflowId);
    },

    childrenOf(artifactId) {
      return [...artifacts.values()].filter((a) => a.parent_artifact_ids.includes(artifactId));
    },
  };
}

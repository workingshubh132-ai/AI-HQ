/**
 * STORAGE CONTRACT
 *
 * The interface every state backend must satisfy. `store.js` is the
 * reference implementation — in-memory, process-local, non-durable. A
 * future Postgres/Supabase adapter satisfies the same contract and can
 * replace it without any change to broker.js, runtime.js, or validator.js.
 *
 * ── WHY THIS FILE EXISTS RATHER THAN A DIRECT SWAP ─────────────────────
 *
 * broker.js and runtime.js already call `store.<method>()` without
 * knowing anything is a Map. That decoupling happened for free during
 * Milestones 4 and 5. What was missing was the contract written down
 * as something other than "whatever store.js happens to export" — so a
 * future adapter has a target to implement, and a way to prove it meets
 * it, instead of reverse-engineering the shape from call sites.
 *
 * ── WHAT THIS FILE DOES NOT DO ─────────────────────────────────────────
 *
 * It does not connect to anything. It does not add a dependency. It does
 * not move authorization logic here — every method below stores and
 * retrieves; none of them decide whether an action is allowed. That
 * remains the Broker's job, unconditionally.
 *
 * The contract below covers exactly the methods actually called from
 * src/ or tests/ today. Three methods that exist on the in-memory store —
 * listAgentVersions, listTasks, getAgentRecord — are deliberately
 * excluded as unused introspection; a fourth, putAgent, was removed
 * outright as a latent authorization bypass. See DECISIONS.md D23.
 * addBudget was excluded for the same reason until M8 gave it a real
 * caller; see D25.
 *
 * Constitution: sections 6, 7, 25 (agents as data; version immutability).
 */

/**
 * Method name -> arity. Arity is the cheapest possible contract check:
 * it catches a missing method or an obviously wrong signature without
 * needing a type system. It does not, and cannot, verify semantics —
 * that is what STORAGE_CONTRACT_TESTS (in tests/storage-contract.test.js)
 * is for.
 */
export const STORAGE_CONTRACT = Object.freeze({
  // ── agents (read path the Broker depends on) ──────────────────────────
  getAgent: 1, // (slug) -> resolved flat agent | null

  // ── agent versions — IMMUTABLE ────────────────────────────────────────
  addAgentVersion: 1, // (version) -> version. Throws on a duplicate version_id.
  getAgentVersion: 1, // (versionId) -> version | null

  // ── agent records — mutable runtime state ─────────────────────────────
  registerAgent: 1, // (agentRecord) -> agentRecord. Also updates the resolved view.
  setActiveVersion: 2, // (slug, versionId) -> agentRecord. Human-controlled path.
  setLifecycleState: 2, // (slug, state) -> agentRecord. Human/Guardian-controlled path.

  // ── tasks ──────────────────────────────────────────────────────────────
  createTask: 1, // (task) -> task
  getTask: 1, // (id) -> task | null
  updateTask: 2, // (id, patch) -> task. Throws on an unknown id.

  // ── approvals ──────────────────────────────────────────────────────────
  approvalsForTask: 1, // (taskId) -> approval[]
  addApproval: 1, // (approval) -> void

  // ── freezes ────────────────────────────────────────────────────────────
  activeFreeze: 3, // (scope, targetId, now) -> freeze | null
  addFreeze: 1, // (freeze) -> void

  // ── budgets ────────────────────────────────────────────────────────────
  budgetsFor: 1, // ({task_id, tree_id, agent_slug}) -> budget[]
  createTaskBudgets: 1, // ({task_id, tree_id, agent_slug, limit}) -> budget[]
  addBudget: 1, // ({level, target_id, limit, spent}) -> void. One row, no
  // dedup — the caller's job. First real caller: workflow.js (M8), which
  // needs to add exactly one task-level row per child task without
  // re-creating the shared tree-level row createTaskBudgets would.
  chargeBudgets: 2, // (applicable, cost) -> void. Called only after real execution.

  // ── idempotency ────────────────────────────────────────────────────────
  getIdempotency: 1, // (key) -> record | null
  claimIdempotency: 1, // (key) -> void. Before execution.
  recordIdempotency: 2, // (key, record) -> void. After execution.
});

/**
 * Invariants a conforming implementation must uphold. Not machine-checked
 * here — this is the specification the contract tests in
 * tests/storage-contract.test.js verify against any factory passed to them.
 * Restated here so the rule is legible next to the method it governs,
 * rather than only inside a test file.
 */
export const STORAGE_INVARIANTS = Object.freeze([
  'addAgentVersion throws on a version_id that already exists — versions are immutable',
  'getAgent, getAgentVersion, getTask, getIdempotency return null for an unknown key, never throw',
  'updateTask throws on an unknown task id — a silent no-op would hide a bug as a success',
  'activeFreeze respects expires_at: an expired freeze is not active',
  'budgetsFor returns exactly the levels applicable to the given scope, not all budgets',
  'chargeBudgets only mutates the budgets it is given, and only by the stated cost',
  'No method here decides whether an action is authorized. That is the Broker.',
]);

/**
 * Structural check: does `candidate` implement every contract method as a
 * function? Arity is checked where the implementation is a plain function
 * (not, e.g., a class method with defaults) — a mismatch here means the
 * signature drifted from the contract, not a definite implementation bug,
 * so it is reported as a name+expected/actual pair rather than thrown
 * immediately, leaving the throw decision to the caller.
 *
 * @param {object} candidate
 * @returns {{ok: boolean, errors: string[]}}
 */
export function checkStorageContract(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, errors: ['candidate is not an object'] };
  }
  for (const [method, arity] of Object.entries(STORAGE_CONTRACT)) {
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
 * Throws with every violation listed, rather than the first one — a
 * future adapter under development benefits from seeing the whole gap at
 * once rather than fixing one method per test run.
 *
 * @param {object} candidate
 * @param {string} [label] for the error message
 */
export function assertStorageContract(candidate, label = 'store') {
  const { ok, errors } = checkStorageContract(candidate);
  if (!ok) {
    throw new Error(`${label} does not satisfy the storage contract:\n  - ${errors.join('\n  - ')}`);
  }
}

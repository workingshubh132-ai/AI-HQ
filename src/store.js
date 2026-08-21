/**
 * IN-MEMORY STORE
 *
 * The reference implementation of the storage contract defined in
 * storage.js. Holds every piece of state the Broker consults: agents,
 * approvals, freezes, budgets and idempotency records.
 *
 * Process-local, non-durable — everything here is lost on exit. A future
 * Postgres/Supabase adapter implements the same contract and can replace
 * this file without any change to broker.js, runtime.js, or validator.js,
 * because none of them import this file directly; they only call methods
 * on whatever `store` object they were handed. See DECISIONS.md D23.
 *
 * ⚠️  CONCURRENCY LIMITATION — READ THIS BEFORE TRUSTING IDEMPOTENCY
 *
 * This implementation runs inside one process with no locking. It proves the
 * idempotency LOGIC — claim before execute, replay after authorization, never
 * execute twice for one key. It does NOT prove distributed or concurrent
 * idempotency.
 *
 * Two processes calling with the same key simultaneously could both pass the
 * lookup and both execute. A real deployment must enforce the claim with a
 * unique database constraint and insert-before-execute inside a transaction.
 *
 * Do not describe this as concurrency-safe. It is not.
 *
 * Constitution: sections 12, 14, 29.
 */

import { resolveAgent } from './agents.js';
import { assertStorageContract } from './storage.js';

/** @typedef {'agent'|'workflow'|'ai_ceo'|'global'} FreezeScope */
/** @typedef {'soft'|'hard'} FreezeClass */

/**
 * @param {object} [seed]
 * @param {object[]} [seed.agents]
 * @param {object[]} [seed.approvals]
 * @param {object[]} [seed.freezes]
 * @param {object[]} [seed.budgets]
 */
export function createMemoryStore(seed = {}) {
  return finish(buildMemoryStore(seed));
}

/**
 * Self-check against the formal contract before the object leaves this
 * function. If a method is renamed or removed here without updating
 * storage.js, this throws immediately at construction — the cheapest
 * possible regression test for the contract, running on every single
 * call site that creates a store, including every test in this suite.
 */
function finish(store) {
  assertStorageContract(store, 'createMemoryStore()');
  return store;
}

function buildMemoryStore(seed = {}) {
  const agents = new Map((seed.agents ?? []).map((a) => [a.slug, a]));
  const approvals = [...(seed.approvals ?? [])];
  const freezes = [...(seed.freezes ?? [])];
  const budgets = [...(seed.budgets ?? [])];
  /** @type {Map<string, {state:'in_flight'|'completed'|'failed', result?:unknown, error?:string}>} */
  const idempotency = new Map();
  /** Immutable version records, keyed by version_id. Append-only. */
  const agentVersions = new Map();
  /** Mutable agent runtime records, keyed by slug. */
  const agentRecords = new Map();
  /** Task records, keyed by task id. */
  const tasks = new Map();

  return {
    // ── agents ────────────────────────────────────────────────────────────
    //
    // No direct write method exists here. The only way an entry reaches
    // `agents` (the flat, resolved view the Broker reads) is through
    // registerAgent / setActiveVersion / setLifecycleState below, all of
    // which go through resolveAgent(). A prior version of this file
    // exposed putAgent(), a direct write that bypassed resolution entirely
    // — nothing called it, but had something called it, it could have
    // inserted a flat agent object with version_state hardcoded to
    // 'approved', skipping the human-approval path the Broker's
    // VERSION_NOT_APPROVED check exists to enforce. Removed rather than
    // formalized into the contract. See DECISIONS.md D23.
    getAgent(slug) {
      return agents.get(slug) ?? null;
    },

    // ── agent versions (IMMUTABLE) ────────────────────────────────────────
    /**
     * Stores a version record. Refuses to overwrite an existing one.
     *
     * Immutability is what makes reproducibility possible without storing
     * configuration snapshots: a task recording a version_id is recording
     * the exact configuration that ran, forever.
     */
    addAgentVersion(version) {
      if (agentVersions.has(version.version_id)) {
        throw new Error(`agent version ${version.version_id} already exists and is immutable`);
      }
      agentVersions.set(version.version_id, version);
      return version;
    },
    getAgentVersion(versionId) {
      return agentVersions.get(versionId) ?? null;
    },

    // ── agent records ─────────────────────────────────────────────────────
    /**
     * Registers an agent and stores the RESOLVED flat view that the Broker
     * consumes. Resolution happens here so broker.js never learns that
     * versions exist.
     */
    registerAgent(agentRecord) {
      agentRecords.set(agentRecord.slug, agentRecord);
      const version = agentRecord.active_version_id
        ? agentVersions.get(agentRecord.active_version_id) ?? null
        : null;
      agents.set(agentRecord.slug, resolveAgent(agentRecord, version));
      return agentRecord;
    },
    /** Pointing an agent at a version. Only a human should call this path. */
    setActiveVersion(slug, versionIdValue) {
      const record = agentRecords.get(slug);
      if (!record) throw new Error(`unknown agent: ${slug}`);
      const updated = { ...record, active_version_id: versionIdValue };
      agentRecords.set(slug, updated);
      agents.set(slug, resolveAgent(updated, agentVersions.get(versionIdValue) ?? null));
      return updated;
    },
    /** Runtime lifecycle changes. Never creates a version. */
    setLifecycleState(slug, state) {
      const record = agentRecords.get(slug);
      if (!record) throw new Error(`unknown agent: ${slug}`);
      const updated = { ...record, lifecycle_state: state };
      agentRecords.set(slug, updated);
      agents.set(slug, resolveAgent(updated, agentVersions.get(updated.active_version_id) ?? null));
      return updated;
    },

    // ── tasks ─────────────────────────────────────────────────────────────
    createTask(task) {
      tasks.set(task.id, task);
      return task;
    },
    getTask(id) {
      return tasks.get(id) ?? null;
    },
    updateTask(id, patch) {
      const existing = tasks.get(id);
      if (!existing) throw new Error(`unknown task: ${id}`);
      const updated = { ...existing, ...patch };
      tasks.set(id, updated);
      return updated;
    },

    // ── approvals ─────────────────────────────────────────────────────────
    /** All approvals for a task, newest last. Matching is the Broker's job. */
    approvalsForTask(taskId) {
      return approvals.filter((a) => a.task_id === taskId);
    },
    addApproval(approval) {
      approvals.push(approval);
    },

    // ── freezes ───────────────────────────────────────────────────────────
    /**
     * An active freeze is one that has not expired. Soft freezes may carry
     * expires_at; hard freezes must not (human release only).
     * @param {FreezeScope} scope
     * @param {string|null} targetId
     * @param {number} now epoch ms
     */
    activeFreeze(scope, targetId, now) {
      return (
        freezes.find(
          (f) =>
            f.scope === scope &&
            (scope === 'global' || f.target_id === targetId) &&
            (f.expires_at == null || f.expires_at > now),
        ) ?? null
      );
    },
    addFreeze(freeze) {
      freezes.push(freeze);
    },

    // ── budgets ───────────────────────────────────────────────────────────
    /**
     * Budgets applicable to one request, as a list of levels. A list rather
     * than four fixed fields so a fifth level is data, not code.
     * Levels: task | tree | agent_day | global_month
     */
    budgetsFor({ task_id, tree_id, agent_slug }) {
      return budgets.filter((b) => {
        if (b.level === 'task') return b.target_id === task_id;
        if (b.level === 'tree') return b.target_id === tree_id;
        if (b.level === 'agent_day') return b.target_id === agent_slug;
        if (b.level === 'global_month') return true;
        return false;
      });
    },
    /**
     * Creates the four budget levels a task needs before it can run.
     * Without these the Broker denies with BUDGET_MISSING, which is the
     * correct default — a task with no budget is not authorised to spend.
     */
    createTaskBudgets({ task_id, tree_id, agent_slug, limit }) {
      const created = [
        { level: 'task', target_id: task_id, limit, spent: 0 },
        { level: 'tree', target_id: tree_id, limit, spent: 0 },
        { level: 'agent_day', target_id: agent_slug, limit, spent: 0 },
      ];
      if (!budgets.some((b) => b.level === 'global_month')) {
        created.push({ level: 'global_month', target_id: null, limit: limit * 10, spent: 0 });
      }
      budgets.push(...created);
      return created;
    },
    /** Charged only after a handler has actually run. */
    chargeBudgets(applicable, cost) {
      for (const b of applicable) b.spent += cost;
    },
    /**
     * One budget row, exactly as given, no deduplication. Promoted from
     * unused introspection to the formal contract in M8: workflow.js needs
     * to add a task-level row per child task in a tree without
     * re-creating createTaskBudgets' shared tree-level row a second time.
     * The caller is responsible for not creating a duplicate.
     */
    addBudget(budget) {
      budgets.push(budget);
    },

    // ── idempotency ───────────────────────────────────────────────────────
    getIdempotency(key) {
      return idempotency.get(key) ?? null;
    },
    /** Claim the key BEFORE executing, so a re-entrant call cannot slip past. */
    claimIdempotency(key) {
      idempotency.set(key, { state: 'in_flight' });
    },
    recordIdempotency(key, record) {
      idempotency.set(key, record);
    },

    // ── introspection — NOT part of the storage contract ─────────────────
    //
    // These three exist because they were cheap to write, not because
    // anything in src/ or tests/ calls them. A future adapter is not
    // required to implement them. Read-only, so unlike putAgent (removed
    // in M6) none of them can be used to bypass authorization — but
    // relying on any of them from new code should mean adding it to
    // STORAGE_CONTRACT in storage.js first, with a contract test, not
    // reaching for a convenience method a Postgres adapter may not have.
    // (addBudget was the fourth; it moved above when M8 gave it a real
    // caller — see DECISIONS.md D25.)
    listAgentVersions(agentId) {
      return [...agentVersions.values()].filter((v) => v.agent_id === agentId);
    },
    listTasks() {
      return [...tasks.values()];
    },
    getAgentRecord(slug) {
      return agentRecords.get(slug) ?? null;
    },
  };
}

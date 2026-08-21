/**
 * IN-MEMORY STORE
 *
 * Holds every piece of state the Broker consults: agents, approvals,
 * freezes, budgets and idempotency records.
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
  const agents = new Map((seed.agents ?? []).map((a) => [a.slug, a]));
  const approvals = [...(seed.approvals ?? [])];
  const freezes = [...(seed.freezes ?? [])];
  const budgets = [...(seed.budgets ?? [])];
  /** @type {Map<string, {state:'in_flight'|'completed'|'failed', result?:unknown, error?:string}>} */
  const idempotency = new Map();

  return {
    // ── agents ────────────────────────────────────────────────────────────
    getAgent(slug) {
      return agents.get(slug) ?? null;
    },
    putAgent(agent) {
      agents.set(agent.slug, agent);
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
    addBudget(budget) {
      budgets.push(budget);
    },
    /** Charged only after a handler has actually run. */
    chargeBudgets(applicable, cost) {
      for (const b of applicable) b.spent += cost;
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
  };
}

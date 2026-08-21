/**
 * GUARDIAN — AUTONOMOUS SAFETY CONTROLLER (Milestone 10)
 *
 * Guardian OBSERVES and FREEZES. It never grants authority.
 *
 * Its entire write surface is ONE call: `store.addFreeze(...)` — the exact
 * primitive the Broker (since M4), runtime.js (since M8), and router.js
 * (since M9) already check via `store.activeFreeze(...)`. Guardian adds no
 * new enforcement point; it is a new, automated CALLER of an enforcement
 * point that has existed since the beginning. Before this file, nothing in
 * src/ ever called `addFreeze` — only tests did.
 *
 * ── WHAT GUARDIAN CANNOT DO, BY CONSTRUCTION ────────────────────────────
 *
 * `createGuardian` takes only `store`, `audit`, `clock`, and a policy of
 * plain numbers. It holds no reference to the Broker, no reference to
 * runtime.js, no reference to the workflow engine, no reference to the
 * router. It cannot call a tool, cannot execute a task, cannot approve a
 * version, cannot change clearance or allowed_tools, cannot raise a
 * budget limit, and cannot lift a freeze — there is no "lift" method on
 * the storage contract for it to call even if it wanted to (freezes are
 * append-only; a soft freeze self-expires via `expires_at`, a hard one
 * requires a future human-release mechanism that does not exist yet — see
 * store.js's own freeze comment). Guardian imposing a freeze and Guardian
 * removing one are not symmetric powers: only the first exists.
 *
 * ── DETERMINISTIC, NOT STATISTICAL ──────────────────────────────────────
 *
 * Every policy below is a fixed threshold over a fixed-size recent window
 * of audit records — plain counting, the same "same input, same output"
 * discipline every other module in this codebase holds to. No machine
 * learning, no LLM judgment, no randomness, no wall-clock time window
 * (this system has no real background clock — `evaluate()` is called
 * explicitly, exactly like router.js's routing and workflow.js's
 * stepping, not on a timer that does not exist).
 *
 * ── EVIDENCE IS THE AUDIT LOG, NOT A NEW OBSERVATION CHANNEL ────────────
 *
 * Guardian reads exactly what audit.js already recorded — runtime.task,
 * broker.decision, workflow.retry events, and store.js's own budget rows.
 * It requires no new instrumentation anywhere else in the codebase.
 *
 * Constitution: sections 6, 12, 13, 17, 20.
 */

/**
 * Numeric thresholds. Deliberately named constants, not magic numbers —
 * this is the "first Guardian implementation" moment OPERATING_MODEL.md's
 * open-questions table names for deciding soft-freeze thresholds and
 * cooling period. See DECISIONS.md D27 for why these specific values.
 */
export const GUARDIAN_POLICY = Object.freeze({
  AGENT_FAILURE_WINDOW: 5,
  AGENT_FAILURE_THRESHOLD: 3, // >=3 of the last 5 terminal tasks failed
  WORKFLOW_FAILURE_WINDOW: 5,
  WORKFLOW_FAILURE_THRESHOLD: 3,
  DENIAL_WINDOW: 5,
  DENIAL_THRESHOLD: 3, // >=3 of the last 5 Broker decisions for this agent were DENY
  RETRY_WINDOW: 5,
  RETRY_THRESHOLD: 3, // >=3 of the last 5 retry decisions in this workflow were accepted
  GLOBAL_BUDGET_EXHAUSTION_RATIO: 1.0, // spent/limit — a global emergency condition
  AGENT_BUDGET_WARNING_RATIO: 0.9, // an early-warning throttle, below full exhaustion
  SOFT_FREEZE_COOLDOWN_MS: 15 * 60 * 1000, // 15 minutes; a placeholder duration, not tuned against real traffic
});

export const GUARDIAN_REASON = Object.freeze({
  AGENT_FAILURE_RATE_EXCEEDED: 'AGENT_FAILURE_RATE_EXCEEDED',
  WORKFLOW_FAILURE_RATE_EXCEEDED: 'WORKFLOW_FAILURE_RATE_EXCEEDED',
  AUTHORIZATION_DENIAL_SPIKE: 'AUTHORIZATION_DENIAL_SPIKE',
  RETRY_SPIKE: 'RETRY_SPIKE',
  GLOBAL_BUDGET_EXHAUSTED: 'GLOBAL_BUDGET_EXHAUSTED',
  AGENT_BUDGET_WARNING: 'AGENT_BUDGET_WARNING',
});

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} deps.audit
 * @param {() => number} deps.clock
 * @param {object} [deps.policy] overrides GUARDIAN_POLICY, for tests that
 *   need a low threshold without waiting for real traffic volume.
 */
export function createGuardian({ store, audit, clock, policy = GUARDIAN_POLICY }) {
  function writeAudit(event, fields) {
    audit.write({ event, at: clock(), ...fields });
  }

  /**
   * The ONLY place this file calls store.addFreeze. Idempotent in effect:
   * if the scope/target is already frozen, does not add a second freeze —
   * repeated breaches of an already-frozen condition are recorded as
   * `guardian.condition_persists`, not as freeze spam.
   */
  function impose({ scope, target_id, reason, detail, hard = false }) {
    const now = clock();
    if (store.activeFreeze(scope, target_id, now)) {
      writeAudit('guardian.condition_persists', { scope, target_id, reason, detail: detail ?? null });
      return { imposed: false, reason: 'ALREADY_FROZEN' };
    }
    const expires_at = hard ? null : now + policy.SOFT_FREEZE_COOLDOWN_MS;
    store.addFreeze({ scope, target_id, reason, imposed_by: 'guardian', imposed_at: now, expires_at });
    writeAudit('guardian.freeze', { scope, target_id, reason, detail: detail ?? null, hard, expires_at });
    return { imposed: true, reason, expires_at };
  }

  /** Most recent `n` audit records matching `event` and `field === value`. */
  function recent(event, field, value, n) {
    return audit.all().filter((r) => r.event === event && r[field] === value).slice(-n);
  }

  // ── 1. agent failure rate ─────────────────────────────────────────────
  function evaluateAgentFailureRate(agent_slug) {
    const window = recent('runtime.task', 'agent_slug', agent_slug, policy.AGENT_FAILURE_WINDOW)
      .filter((r) => r.status === 'completed' || r.status === 'failed');
    const failures = window.filter((r) => r.status === 'failed').length;
    writeAudit('guardian.check', { check: 'agent_failure_rate', target_id: agent_slug, window: window.length, failures });
    if (failures >= policy.AGENT_FAILURE_THRESHOLD) {
      return impose({
        scope: 'agent', target_id: agent_slug, reason: GUARDIAN_REASON.AGENT_FAILURE_RATE_EXCEEDED,
        detail: `${failures}/${window.length} recent tasks failed`,
      });
    }
    return { imposed: false };
  }

  // ── 2. workflow failure rate ──────────────────────────────────────────
  function evaluateWorkflowFailureRate(tree_id) {
    const window = recent('runtime.task', 'tree_id', tree_id, policy.WORKFLOW_FAILURE_WINDOW)
      .filter((r) => r.status === 'completed' || r.status === 'failed');
    const failures = window.filter((r) => r.status === 'failed').length;
    writeAudit('guardian.check', { check: 'workflow_failure_rate', target_id: tree_id, window: window.length, failures });
    if (failures >= policy.WORKFLOW_FAILURE_THRESHOLD) {
      return impose({
        scope: 'workflow', target_id: tree_id, reason: GUARDIAN_REASON.WORKFLOW_FAILURE_RATE_EXCEEDED,
        detail: `${failures}/${window.length} recent tasks failed`,
      });
    }
    return { imposed: false };
  }

  // ── 3. repeated authorization denials ─────────────────────────────────
  function evaluateAuthorizationDenials(agent_slug) {
    const window = recent('broker.decision', 'agent_slug', agent_slug, policy.DENIAL_WINDOW);
    const denials = window.filter((r) => r.decision === 'DENY').length;
    writeAudit('guardian.check', { check: 'authorization_denials', target_id: agent_slug, window: window.length, denials });
    if (denials >= policy.DENIAL_THRESHOLD) {
      return impose({
        scope: 'agent', target_id: agent_slug, reason: GUARDIAN_REASON.AUTHORIZATION_DENIAL_SPIKE,
        detail: `${denials}/${window.length} recent Broker decisions were DENY`,
      });
    }
    return { imposed: false };
  }

  // ── 4. abnormal retry rate ────────────────────────────────────────────
  function evaluateRetrySpike(workflow_id) {
    const window = recent('workflow.retry', 'workflow_id', workflow_id, policy.RETRY_WINDOW);
    const accepted = window.filter((r) => r.decision === 'accepted').length;
    writeAudit('guardian.check', { check: 'retry_spike', target_id: workflow_id, window: window.length, accepted });
    if (accepted >= policy.RETRY_THRESHOLD) {
      return impose({
        scope: 'workflow', target_id: workflow_id, reason: GUARDIAN_REASON.RETRY_SPIKE,
        detail: `${accepted}/${window.length} recent retries were accepted`,
      });
    }
    return { imposed: false };
  }

  // ── 5. global budget exhaustion — the global emergency condition ─────
  function evaluateGlobalBudget() {
    const rows = store.budgetsFor({}).filter((b) => b.level === 'global_month' && b.limit > 0);
    const exhausted = rows.find((b) => b.spent / b.limit >= policy.GLOBAL_BUDGET_EXHAUSTION_RATIO);
    writeAudit('guardian.check', { check: 'global_budget', rows: rows.length, exhausted: !!exhausted });
    if (exhausted) {
      return impose({
        scope: 'global', target_id: null, reason: GUARDIAN_REASON.GLOBAL_BUDGET_EXHAUSTED,
        detail: `spent ${exhausted.spent} >= limit ${exhausted.limit}`, hard: true,
      });
    }
    return { imposed: false };
  }

  // ── 6. abnormal per-agent spending — early warning, below exhaustion ──
  function evaluateAgentBudgetWarning(agent_slug) {
    const row = store.budgetsFor({ agent_slug }).find((b) => b.level === 'agent_day' && b.limit > 0);
    const ratio = row ? row.spent / row.limit : 0;
    writeAudit('guardian.check', { check: 'agent_budget_warning', target_id: agent_slug, ratio });
    if (row && ratio >= policy.AGENT_BUDGET_WARNING_RATIO) {
      return impose({
        scope: 'agent', target_id: agent_slug, reason: GUARDIAN_REASON.AGENT_BUDGET_WARNING,
        detail: `spent ${row.spent} of ${row.limit} (${Math.round(ratio * 100)}%)`,
      });
    }
    return { imposed: false };
  }

  /** Every tree/workflow id Guardian has ever observed in the audit log —
   * it has no other way to enumerate workflows, since (per D25) workflow
   * records live in workflow.js's own closure, not in store. */
  function knownWorkflowIds() {
    const ids = new Set();
    for (const r of audit.all()) {
      if (r.tree_id) ids.add(r.tree_id);
      if (r.workflow_id) ids.add(r.workflow_id);
    }
    return [...ids];
  }

  /** Runs every policy once, over the current store and audit state. */
  function evaluate() {
    const results = [];
    for (const agent of store.listAgents()) {
      results.push({ check: 'agent_failure_rate', target_id: agent.slug, ...evaluateAgentFailureRate(agent.slug) });
      results.push({ check: 'authorization_denials', target_id: agent.slug, ...evaluateAuthorizationDenials(agent.slug) });
      results.push({ check: 'agent_budget_warning', target_id: agent.slug, ...evaluateAgentBudgetWarning(agent.slug) });
    }
    for (const treeId of knownWorkflowIds()) {
      results.push({ check: 'workflow_failure_rate', target_id: treeId, ...evaluateWorkflowFailureRate(treeId) });
      results.push({ check: 'retry_spike', target_id: treeId, ...evaluateRetrySpike(treeId) });
    }
    results.push({ check: 'global_budget', target_id: null, ...evaluateGlobalBudget() });
    return { checked_at: clock(), results };
  }

  return {
    evaluate,
    evaluateAgentFailureRate,
    evaluateWorkflowFailureRate,
    evaluateAuthorizationDenials,
    evaluateRetrySpike,
    evaluateGlobalBudget,
    evaluateAgentBudgetWarning,
  };
}

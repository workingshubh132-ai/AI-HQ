/**
 * CEO DECISION LIMITS (Milestone 24)
 *
 * Explicit, small, fail-closed ceilings on everything the CEO
 * orchestrator can do repeatedly. The M24 directive's own requirement:
 * "CEO planning/recovery must have explicit limits... Fail closed when
 * limits are reached. Do not create an infinite autonomous loop."
 *
 * ── WHY THESE LIVE IN THEIR OWN FILE ─────────────────────────────────────
 *
 * Same reasoning `limits.js` (task-tree ceilings, M5) and
 * `router.js`'s `MAX_AGENT_CONCURRENCY` already follow: a ceiling that
 * bounds autonomous behavior is decided ONCE, in one readable place, so
 * it can be audited, mutation-tested, and changed deliberately — never
 * rediscovered scattered across a loop condition. Nothing reads a limit
 * from a goal, a plan, a provider's output, or any other runtime-
 * supplied value; every ceiling here is a source constant.
 *
 * ── THE DECISION BUDGET IS THE BACKSTOP ──────────────────────────────────
 *
 * Each individual ceiling below bounds one KIND of repetition. They
 * could still, in principle, compose into a long run (many stages, each
 * recovering). `MAX_CEO_DECISIONS_PER_WORKFLOW` is the single aggregate
 * ceiling over EVERY CEO decision of every kind in one workflow —
 * planning, proposing, recovering, evaluating — so no combination of
 * the others can produce an unbounded run. It is deliberately the one
 * limit a reader can check alone to know the CEO terminates.
 *
 * Constitution: sections 13, 18, 20.
 */

export const CEO_LIMITS = Object.freeze({
  /** How many times `planGoal()` may iterate while building one plan.
   * The planner is deterministic and single-pass today, so this is
   * headroom for a future multi-pass planner, enforced now rather than
   * added later once a loop already exists. */
  MAX_PLANNING_ITERATIONS: 3,

  /** How many recovery attempts the CEO may make for ONE stage before
   * that stage is abandoned as failed. Deliberately smaller than
   * `workflow.js`'s own MAX_TASK_RETRY_CEILING (3) is generous, because
   * a CEO recovery is a NEW task proposal, not workflow.js's automatic
   * same-signature retry — the two bound different things and both
   * still apply. */
  MAX_RECOVERY_ATTEMPTS_PER_STAGE: 2,

  /** How many times the CEO may re-plan (build a fresh plan for the same
   * goal after the previous plan proved unexecutable). */
  MAX_REPLAN_CYCLES: 1,

  /** The aggregate backstop over every CEO decision of every kind in one
   * workflow — see this file's header. Sized so a full 12-stage Content
   * Factory run (1 plan + 12 proposals + 12 completion reads + slack for
   * bounded recovery) fits comfortably, while any genuinely runaway loop
   * hits it long before it could do damage. */
  MAX_CEO_DECISIONS_PER_WORKFLOW: 64,
});

export const CEO_LIMIT_REASON = Object.freeze({
  PLANNING_ITERATIONS_EXCEEDED: 'PLANNING_ITERATIONS_EXCEEDED',
  RECOVERY_ATTEMPTS_EXCEEDED: 'RECOVERY_ATTEMPTS_EXCEEDED',
  REPLAN_CYCLES_EXCEEDED: 'REPLAN_CYCLES_EXCEEDED',
  DECISION_BUDGET_EXCEEDED: 'DECISION_BUDGET_EXCEEDED',
});

/**
 * A tiny, explicit decision counter. Created per workflow run, never
 * shared, never reset mid-run, never raised by anything the CEO reads
 * at runtime — `spend()` returns false the moment the budget is gone,
 * and every caller treats false as "stop," never as "warn and
 * continue."
 *
 * @param {number} [budget]
 */
export function createDecisionBudget(budget = CEO_LIMITS.MAX_CEO_DECISIONS_PER_WORKFLOW) {
  let spent = 0;
  return Object.freeze({
    /** @returns {boolean} true if the decision may proceed */
    spend(kind) {
      if (spent >= budget) return false;
      spent++;
      return true;
    },
    get spent() { return spent; },
    get remaining() { return Math.max(0, budget - spent); },
    get budget() { return budget; },
  });
}

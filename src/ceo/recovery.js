/**
 * CEO RECOVERY POLICY (Milestone 24)
 *
 * A pure function from "this stage failed, for this reason, after this
 * many attempts" to "what may the CEO do about it." No store, no clock,
 * no randomness, no I/O — so it is directly unit-testable and directly
 * mutation-testable, exactly like `contracts.js`'s validators and
 * `content-factory-agents.js`'s `runQualityControlChecks`.
 *
 * ── EVERY OUTCOME IS A REQUEST OR A STOP. THERE IS NO THIRD KIND. ────────
 *
 * This file cannot bypass anything, because the only things it can
 * return are (a) "ask the existing machinery again, differently," or
 * (b) "stop." It never returns "proceed anyway," "ignore the freeze,"
 * "raise the budget," or "approve it." Those actions have no
 * representation in `RECOVERY_ACTION` at all — a stronger guarantee
 * than a rule that says not to take them.
 *
 * Specifically, per the M24 directive's own recovery table:
 *
 *   HANDLER_ERROR        → RETRY_STAGE, only while under the per-stage
 *                          ceiling. A retry is a NEW proposal through
 *                          the full router/workflow gauntlet, never a
 *                          resurrection of the failed task.
 *   AGENT_FROZEN         → REROUTE_STAGE. The freeze is never touched.
 *                          The router is asked again, and it will
 *                          exclude the frozen agent by its own
 *                          unmodified eligibility rule; if that leaves
 *                          no candidate, the next failure is
 *                          NO_ELIGIBLE_AGENT and the workflow stops.
 *   NO_ELIGIBLE_AGENT    → STOP_BLOCKED. Reported, never worked around.
 *   BUDGET_INSUFFICIENT  → STOP_BUDGET. Never a request to raise it.
 *   APPROVAL_REQUIRED    → REQUEST_APPROVAL, which reaches only
 *                          `requestApproval` — the CEO never holds
 *                          `decide`. A human decides. See
 *                          orchestrator.js and DECISIONS.md D41.
 *   GLOBAL_FREEZE        → STOP_FROZEN.
 *   WORKFLOW_FROZEN      → STOP_FROZEN.
 *
 * Anything unrecognised falls through to STOP_UNRECOVERABLE — fail
 * closed on an unfamiliar failure rather than guessing that a retry is
 * safe.
 *
 * Constitution: sections 13, 18, 20.
 */

import { CEO_LIMITS, CEO_LIMIT_REASON } from './limits.js';

export const RECOVERY_ACTION = Object.freeze({
  /** Propose the same stage again, through the full unmodified gauntlet. */
  RETRY_STAGE: 'RETRY_STAGE',
  /** Propose the same stage again so the router may pick a DIFFERENT
   * eligible specialist. The CEO never names one; the router decides. */
  REROUTE_STAGE: 'REROUTE_STAGE',
  /** Ask the existing Approval Engine for an approval. Never self-approve. */
  REQUEST_APPROVAL: 'REQUEST_APPROVAL',
  /** No eligible specialist exists for a required capability. */
  STOP_BLOCKED: 'STOP_BLOCKED',
  /** A budget ceiling was reached. Never a request to raise it. */
  STOP_BUDGET: 'STOP_BUDGET',
  /** A freeze covers this work. Never lifted, never bypassed. */
  STOP_FROZEN: 'STOP_FROZEN',
  /** A per-stage or aggregate CEO limit was reached. */
  STOP_LIMIT: 'STOP_LIMIT',
  /** An unrecognised failure. Fail closed. */
  STOP_UNRECOVERABLE: 'STOP_UNRECOVERABLE',
});

/** Failure reasons this policy recognises, drawn verbatim from the
 * existing vocabularies these failures actually arrive with —
 * `RUNTIME_REASON` (runtime.js), `ROUTING_REASON` (router.js),
 * `WORKFLOW_REASON` (workflow.js). No parallel vocabulary is invented. */
const RETRYABLE_RUNTIME_FAILURES = Object.freeze(new Set(['HANDLER_ERROR']));
const FREEZE_FAILURES = Object.freeze(new Set(['GLOBAL_FREEZE', 'WORKFLOW_FROZEN']));
const AGENT_FREEZE_FAILURES = Object.freeze(new Set(['AGENT_FROZEN']));
const BLOCKED_FAILURES = Object.freeze(new Set(['NO_ELIGIBLE_AGENT', 'CAPABILITY_NOT_DECLARED', 'WORKFLOW_TYPE_NOT_SUPPORTED', 'AGENT_NOT_ACTIVE']));
const BUDGET_FAILURES = Object.freeze(new Set(['BUDGET_INSUFFICIENT', 'BUDGET_EXCEEDED', 'BUDGET_MISSING']));
const APPROVAL_FAILURES = Object.freeze(new Set(['NEEDS_APPROVAL', 'APPROVAL_REQUIRED']));

/**
 * @param {object} args
 * @param {string} args.failure_reason  a RUNTIME_REASON / ROUTING_REASON /
 *   WORKFLOW_REASON code, exactly as the failing layer reported it
 * @param {number} args.attempts  how many times this stage has already
 *   been attempted (1 after the first failure)
 * @returns {{action:string, reason:string, detail:string|null}}
 */
export function decideRecovery({ failure_reason, attempts }) {
  const settle = (action, reason, detail = null) => ({ action, reason, detail });

  // Freezes first, and unconditionally: no attempt count, no capability
  // lookup, and no other branch below can override a freeze into an
  // action that proceeds. Checked before the per-stage ceiling too, so a
  // freeze always reports as a freeze rather than as a limit.
  if (FREEZE_FAILURES.has(failure_reason)) {
    return settle(RECOVERY_ACTION.STOP_FROZEN, failure_reason, 'a freeze covers this work; the CEO never lifts or bypasses one');
  }

  if (BUDGET_FAILURES.has(failure_reason)) {
    return settle(RECOVERY_ACTION.STOP_BUDGET, failure_reason, 'a budget ceiling was reached; the CEO never requests a raise');
  }

  if (APPROVAL_FAILURES.has(failure_reason)) {
    return settle(RECOVERY_ACTION.REQUEST_APPROVAL, failure_reason, 'requests an approval; a human decides — the CEO never self-approves');
  }

  if (BLOCKED_FAILURES.has(failure_reason)) {
    return settle(RECOVERY_ACTION.STOP_BLOCKED, failure_reason, 'no eligible specialist; reported, never worked around');
  }

  // Only now does the per-stage ceiling apply — it bounds the two
  // actions that actually repeat work.
  if (attempts >= CEO_LIMITS.MAX_RECOVERY_ATTEMPTS_PER_STAGE) {
    return settle(
      RECOVERY_ACTION.STOP_LIMIT, CEO_LIMIT_REASON.RECOVERY_ATTEMPTS_EXCEEDED,
      `${attempts} >= ${CEO_LIMITS.MAX_RECOVERY_ATTEMPTS_PER_STAGE}`,
    );
  }

  if (AGENT_FREEZE_FAILURES.has(failure_reason)) {
    // Ask the router again. It will exclude the frozen agent by its own
    // unmodified rule. Nothing here touches the freeze.
    return settle(RECOVERY_ACTION.REROUTE_STAGE, failure_reason, 'asks the router for another eligible specialist; the freeze is untouched');
  }

  if (RETRYABLE_RUNTIME_FAILURES.has(failure_reason)) {
    return settle(RECOVERY_ACTION.RETRY_STAGE, failure_reason, 'transient handler failure; re-proposed through the full gauntlet');
  }

  return settle(RECOVERY_ACTION.STOP_UNRECOVERABLE, failure_reason ?? 'UNKNOWN', 'unrecognised failure; failing closed rather than guessing a retry is safe');
}

/** Actions that mean "the CEO stops working on this goal." Exported so
 * callers classify with the same set this file defines, rather than
 * re-listing STOP_ codes and drifting. */
export const TERMINAL_RECOVERY_ACTIONS = Object.freeze(new Set([
  RECOVERY_ACTION.STOP_BLOCKED,
  RECOVERY_ACTION.STOP_BUDGET,
  RECOVERY_ACTION.STOP_FROZEN,
  RECOVERY_ACTION.STOP_LIMIT,
  RECOVERY_ACTION.STOP_UNRECOVERABLE,
]));

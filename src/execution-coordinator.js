/**
 * EXECUTION COORDINATOR (Milestone 14)
 *
 * The piece M9–M13 left isolated: something that actually calls
 * `router.route()` before a task is admitted, and calls `guardian.evaluate()`
 * at a real point in execution rather than only from a test. Before this
 * file, nothing in src/ ever called either — `workflow.js`'s `addTask()`
 * took an explicit, caller-supplied `agent_slug` and never consulted the
 * router (router.js's own header predicted this gap: "a caller still calls
 * `engine.addTask({ agent_slug: decision.selected_agent_slug, ... })`" —
 * no such caller existed). This file IS that caller.
 *
 * ── WHAT THIS FILE ADDS, PRECISELY ──────────────────────────────────────
 *
 *   proposeTask()   router.route() → (on success) workflow.addTask()
 *   runStep()       workflow.step() → release router reservations for
 *                   every task that went terminal this round →
 *                   guardian.evaluate()
 *   runToCompletion()  repeats runStep() until the workflow is terminal
 *                      or WAITING, mirroring workflow.js's own
 *                      runToCompletion() with the same two additions.
 *
 * It is deliberately thin. `workflow.js`, `router.js`, `guardian.js`, and
 * `runtime.js` are byte-for-byte unchanged by this milestone — this file
 * only calls their existing public methods in a new order. Every
 * authorization decision this file's output depends on was already made
 * by one of those four files, or by the Broker underneath runtime.js. This
 * file makes none itself: it holds no reference to the Broker, cannot call
 * a tool, cannot approve a version, cannot lift a freeze, and cannot alter
 * a budget. If this whole file were deleted and a caller went back to
 * calling `workflow.addTask()` directly with a hand-typed `agent_slug`
 * (exactly as every test before M14 already does), nothing downstream
 * would notice or behave differently — the same property router.js's own
 * header already claims for itself.
 *
 * ── WHY ROUTER SELECTION HAS TO HAPPEN BEFORE addTask(), NOT INSIDE IT ──
 *
 * `workflow.addTask()`'s signature requires a concrete `agent_slug` — that
 * is what makes it possible for a caller to bypass the router entirely and
 * still work, which is the property the paragraph above relies on.
 * `proposeTask()` below is the caller that resolves `required_capability`
 * to a concrete `agent_slug` via `router.route()` first, then hands that
 * slug to the unmodified `addTask()`. `addTask()` re-derives and re-checks
 * agent/version validity from scratch regardless of what the router said
 * (unknown agent, invalid agent, unapproved version, inactive agent, loop
 * detection, depth, fan-out, total nodes, tree budget) — the router's
 * selection is advice consumed once, not a credential carried forward.
 *
 * ── RESERVATION BOOKKEEPING addTask() CANNOT DO ITSELF ──────────────────
 *
 * `router.route()` reserves a concurrency slot for the agent it selects
 * as part of selecting it (router.js's own design, since M9). Two things
 * can happen after that which the router has no way to observe on its
 * own, so this file observes them instead:
 *
 *   1. addTask() rejects the proposal anyway (duplicate task_id, loop
 *      detected, tree budget exhausted, depth/fan-out/node ceiling, the
 *      agent stopped being active between routing and admission). The
 *      task will never run. `proposeTask()` releases the reservation
 *      immediately so a caller retrying a fixed proposal does not find
 *      the agent artificially at capacity for work that never happened.
 *   2. A routed, admitted task later reaches a terminal state (COMPLETED,
 *      FAILED, or CANCELLED via dependency propagation) inside
 *      `workflow.step()`. `runStep()` releases the reservation for every
 *      such task after each step, exactly the cadence router.js's own
 *      header names ("a caller releases that slot ... once the task
 *      reaches a terminal state").
 *
 * `router.release()` is documented as idempotent and safe to call on a
 * reservation that was never held (unknown agent, unknown task) — which is
 * exactly what happens for every task admitted via `workflow.addTask()`
 * directly, bypassing `proposeTask()`, as every pre-M14 test still does.
 * `runStep()` calling `release()` on those tasks too is therefore a
 * harmless no-op, not a new assumption this file introduces.
 *
 * ── RETRIED TASKS ARE A DOCUMENTED, BOUNDED GAP, NOT AN OVERSIGHT ────────
 *
 * `workflow.step()`'s automatic retry (`retryTask()`) creates a new task
 * bound to the SAME `agent_slug` as the failed original — it does not
 * re-route, by design (M8's retry semantics: "a retry is a new attempt,"
 * not a new admission decision, and this milestone does not rewrite
 * workflow.js). A retried task therefore never acquires a router
 * reservation and never needs one released. Router concurrency accounting
 * does not include in-flight retries. This is not a security gap: a
 * retried task still passes through runtime.js's full pre-flight
 * (approved version, active state, agent/workflow/global freeze) exactly
 * like any other task, unchanged.
 *
 * ── GUARDIAN'S INTEGRATION POINT ─────────────────────────────────────────
 *
 * `guardian.evaluate()` reads the audit log `workflow.step()` just wrote to
 * (runtime.task, broker.decision events) and may impose a freeze —
 * exactly the same store freeze primitive the Broker, runtime.js,
 * and router.js already check via `store.activeFreeze()`. Calling it once
 * per `runStep()` is what makes Guardian's freezes take effect on the NEXT
 * round: a frozen agent's still-PENDING task fails runtime.js's own
 * pre-flight the next time `workflow.step()` tries to run it (unchanged
 * code, already fail-closed since M8), and a frozen agent is excluded from
 * `router.route()`'s candidates the next time `proposeTask()` is called for
 * it (unchanged code, already fail-closed since M9) — so a workflow
 * waiting between phases for a caller to propose the next task finds that
 * proposal refused with `NO_ELIGIBLE_AGENT` before anything executes, not
 * merely after a failed attempt. This file adds no new freeze check of its
 * own; it only calls the existing one at a point where it matters.
 *
 * ── WHAT THIS FILE MUST NEVER DO ─────────────────────────────────────────
 *
 * Select an agent by any means other than `router.route()`. Admit a task by
 * any means other than the unmodified `workflow.addTask()`. Execute a task
 * by any means other than the unmodified `workflow.step()` (which itself
 * still calls only the unmodified `runtime.runTask()`). Impose or lift a
 * freeze. Touch a budget, a credential, or a tool.
 *
 * Constitution: sections 6, 13, 18, 20, 25.
 */

import { WORKFLOW_STATE } from './workflow.js';
import { TASK_STATUS } from './runtime.js';
import { MAX_TOTAL_NODES } from './limits.js';

export const COORDINATOR_REASON = Object.freeze({
  OK: 'OK',
  /** router.route() did not return 'routed' — see routing_reason for why
   * (NO_ELIGIBLE_AGENT, GLOBAL_FREEZE, WORKFLOW_FROZEN, MALFORMED_REQUEST). */
  ROUTING_FAILED: 'ROUTING_FAILED',
});

const TERMINAL_STATES = new Set([WORKFLOW_STATE.COMPLETED, WORKFLOW_STATE.FAILED, WORKFLOW_STATE.CANCELLED]);

/**
 * @param {object} deps
 * @param {{addTask:Function, step:Function}} deps.workflow  an unmodified
 *   createWorkflowEngine() instance
 * @param {{route:Function, release:Function}} deps.router  an unmodified
 *   createRouter() instance
 * @param {{evaluate:Function}} deps.guardian  an unmodified createGuardian()
 *   instance
 * @param {object} deps.store  read-only use only: looking up a cancelled
 *   task's agent_slug so its router reservation can be released
 * @param {object} deps.audit
 * @param {() => number} deps.clock
 */
export function createExecutionCoordinator({ workflow, router, guardian, store, audit, clock }) {
  function writeAudit(event, fields) {
    audit.write({ event, at: clock(), ...fields });
  }

  /**
   * Resolves `required_capability` to a concrete agent via the router,
   * then admits the task through the unmodified workflow gauntlet.
   *
   * @param {{workflow_id:string, task_id:string, parent_task_id?:string|null,
   *   required_capability:string, required_workflow_type?:string, input:unknown,
   *   depends_on?:string[]}} args
   * @returns {object} the addTask()-shaped decision, plus selected_agent_slug
   *   and the raw routing decision on acceptance; a coordinator-shaped
   *   rejection (reason ROUTING_FAILED) if routing itself never reached
   *   an agent.
   */
  function proposeTask({
    workflow_id, task_id, parent_task_id = null, required_capability,
    required_workflow_type = undefined, input, depends_on = [],
  }) {
    const routing = router.route({
      task_id,
      required_capability,
      workflow_id,
      required_workflow_type,
    });

    if (routing.decision !== 'routed') {
      writeAudit('coordinator.task_proposal', {
        workflow_id, task_id, parent_task_id, required_capability,
        agent_slug: null, decision: 'rejected', reason: COORDINATOR_REASON.ROUTING_FAILED,
        routing_reason: routing.reason,
      });
      return {
        decision: 'rejected', reason: COORDINATOR_REASON.ROUTING_FAILED,
        routing_reason: routing.reason, routing,
      };
    }

    const agent_slug = routing.selected_agent_slug;
    const admission = workflow.addTask({ workflow_id, task_id, parent_task_id, agent_slug, input, depends_on });

    if (admission.decision !== 'accepted') {
      // The router already reserved a slot for a task that will never
      // exist. Release it now, not on some later terminal event that will
      // never come, per the file header.
      router.release({ agent_slug, task_id });
      writeAudit('coordinator.task_proposal', {
        workflow_id, task_id, parent_task_id, required_capability, agent_slug,
        decision: 'rejected', reason: admission.reason,
      });
      return admission;
    }

    writeAudit('coordinator.task_proposal', {
      workflow_id, task_id, parent_task_id, required_capability, agent_slug,
      decision: 'accepted', reason: COORDINATOR_REASON.OK,
    });

    return { ...admission, selected_agent_slug: agent_slug, routing };
  }

  /** Releases router reservations for every task that went terminal this
   * step — see the file header's "RESERVATION BOOKKEEPING" section. */
  function releaseTerminalReservations(result) {
    for (const task of result.ran) {
      if (task.status === TASK_STATUS.COMPLETED || task.status === TASK_STATUS.FAILED) {
        router.release({ agent_slug: task.agent_slug, task_id: task.id });
      }
    }
    for (const task_id of result.cancelled) {
      const task = store.getTask(task_id);
      if (task) router.release({ agent_slug: task.agent_slug, task_id });
    }
  }

  /**
   * One bounded round: the unmodified workflow.step(), then router
   * reservation cleanup, then a Guardian evaluation pass so any freeze
   * condition workflow.step()'s own audit writes just created takes effect
   * before the next round. See the file header's "GUARDIAN'S INTEGRATION
   * POINT" section for exactly what that does and does not mean.
   *
   * @returns {object} workflow.step()'s own return shape, plus `guardian`
   *   (the return of this round's guardian.evaluate() call).
   */
  function runStep({ workflow_id }) {
    const result = workflow.step({ workflow_id });
    releaseTerminalReservations(result);
    const guardianResult = guardian.evaluate();
    return { ...result, guardian: guardianResult };
  }

  /**
   * Repeatedly steps until the workflow reaches a terminal state or makes
   * no further progress (WAITING — e.g. blocked on a caller to propose the
   * next phase), mirroring workflow.js's own runToCompletion() exactly,
   * with the same max_steps insurance ceiling.
   */
  function runToCompletion({ workflow_id, max_steps = MAX_TOTAL_NODES + 8 }) {
    let last;
    for (let i = 0; i < max_steps; i++) {
      last = runStep({ workflow_id });
      if (TERMINAL_STATES.has(last.workflow.state)) return last;
      if (last.workflow.state === WORKFLOW_STATE.WAITING) return last;
    }
    return last;
  }

  return { proposeTask, runStep, runToCompletion };
}

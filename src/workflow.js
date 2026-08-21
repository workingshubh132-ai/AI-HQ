/**
 * WORKFLOW ENGINE
 *
 * Turns the single-task runtime into a bounded, dependency-aware, loop-safe
 * orchestrator for multiple tasks. It is an ORCHESTRATOR, not an authorizer:
 * every task still runs through the unmodified runtime.runTask(), which
 * still gates agent execution, and every tool call inside a task still
 * reaches broker.execute() unchanged. Creating a task here is never
 * permission to perform a tool action — that permission is decided exactly
 * where it always was.
 *
 * ── THE ARCHITECTURE THIS FILE SITS INSIDE ─────────────────────────────
 *
 *   Workflow Engine  (this file — orchestration only)
 *         │
 *         ▼
 *      Task           →  Agent Runtime  →  Model / Handler
 *                                                │
 *                                                ▼
 *                                        Validated Result
 *                                                │
 *                                                ▼
 *                                             Broker  →  Tool
 *
 * ── WHAT THIS FILE MUST NEVER DO ────────────────────────────────────────
 *
 * Modify clearance, scopes, budgets' authorization semantics, approve a
 * version, override a freeze, call a tool directly, or touch a credential.
 * It has no reference to anything that could — it takes `runtime` (already
 * built, already bounded) and `store` (the same storage contract everything
 * else uses), and nothing else.
 *
 * ── WHY WORKFLOW RECORDS LIVE HERE, NOT IN store.js ─────────────────────
 *
 * A workflow is orchestration bookkeeping — state, node count, task
 * ordering — not a security-relevant entity the Broker or a future audit
 * needs to query independently. Same call M7 made for model-call budgets:
 * kept in model-runtime.js's own closure rather than extending store.js's
 * formal contract for a concern the Broker never consults. tree_id IS the
 * workflow_id throughout, which is what lets the existing tree-level budget
 * dimension (already in store.js, already tested) serve as the workflow's
 * shared spending ceiling with zero new storage primitives.
 *
 * Constitution: sections 13, 18, 19, 20.
 */

import { taskSignature, MAX_DEPTH, MAX_FANOUT, MAX_TOTAL_NODES } from './limits.js';
import { TASK_STATUS } from './runtime.js';

export const WORKFLOW_STATE = Object.freeze({
  CREATED: 'created',
  RUNNING: 'running',
  WAITING: 'waiting',     // nothing currently runnable, not yet terminal
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const TERMINAL_STATES = new Set([WORKFLOW_STATE.COMPLETED, WORKFLOW_STATE.FAILED, WORKFLOW_STATE.CANCELLED]);
const RUNNABLE_STATES = new Set([WORKFLOW_STATE.CREATED, WORKFLOW_STATE.RUNNING, WORKFLOW_STATE.WAITING]);

export const WORKFLOW_REASON = Object.freeze({
  OK: 'OK',
  UNKNOWN_WORKFLOW: 'UNKNOWN_WORKFLOW',
  WORKFLOW_NOT_RUNNABLE: 'WORKFLOW_NOT_RUNNABLE',
  MALFORMED_PROPOSAL: 'MALFORMED_PROPOSAL',
  UNKNOWN_AGENT: 'UNKNOWN_AGENT',
  INVALID_AGENT: 'INVALID_AGENT',
  VERSION_NOT_APPROVED: 'VERSION_NOT_APPROVED',
  AGENT_NOT_ACTIVE: 'AGENT_NOT_ACTIVE',
  DEPTH_EXCEEDED: 'DEPTH_EXCEEDED',
  FANOUT_EXCEEDED: 'FANOUT_EXCEEDED',
  TOTAL_NODES_EXCEEDED: 'TOTAL_NODES_EXCEEDED',
  LOOP_DETECTED: 'LOOP_DETECTED',
  MISSING_DEPENDENCY: 'MISSING_DEPENDENCY',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  UNKNOWN_TASK: 'UNKNOWN_TASK',
  NOT_RETRYABLE: 'NOT_RETRYABLE',
  RETRY_CEILING_EXCEEDED: 'RETRY_CEILING_EXCEEDED',
});

/**
 * Failure classifications safe to retry automatically. Everything else —
 * an invalid authorization, an unapproved version, a policy violation, a
 * malformed task, a security failure — is a fact that will be exactly as
 * true on a second attempt, and retrying it turns one alarming event into
 * a pattern the system tolerates. Only a plausibly transient failure
 * (today: the handler itself threw) is retried.
 */
const RETRYABLE_REASONS = new Set(['HANDLER_ERROR']);

/** No workflow may retry a task more than this, however configured. */
const MAX_TASK_RETRY_CEILING = 3;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {object} deps
 * @param {{runTask: Function}} deps.runtime  the existing, unmodified agent runtime
 * @param {object} deps.store
 * @param {object} deps.audit
 * @param {() => number} deps.clock
 */
export function createWorkflowEngine({ runtime, store, audit, clock }) {
  /** @type {Map<string, object>} workflow_id -> workflow record */
  const workflows = new Map();

  function writeAudit(event, fields) {
    audit.write({ event, at: clock(), ...fields });
  }

  // ── workflow lifecycle ───────────────────────────────────────────────

  /**
   * @param {{workflow_id:string, budget_limit:number}} args
   * @returns {object} the workflow record
   */
  function createWorkflow({ workflow_id, budget_limit }) {
    if (workflows.has(workflow_id)) throw new Error(`workflow ${workflow_id} already exists`);
    const now = clock();
    const workflow = {
      id: workflow_id,
      state: WORKFLOW_STATE.CREATED,
      root_task_id: null,
      task_ids: [],
      node_count: 0,
      budget_limit,
      created_at: now,
      completed_at: null,
      failure_reason: null,
    };
    workflows.set(workflow_id, workflow);

    // The tree-level budget IS the workflow-wide ceiling — see file header.
    // global_month is shared across the whole process; only created once.
    // budgetsFor's global_month branch returns unconditionally regardless
    // of the other fields, so an empty query object is a correct, honest
    // way to ask "does a global_month row exist at all" — no placeholder
    // values standing in for real ones.
    store.addBudget({ level: 'tree', target_id: workflow_id, limit: budget_limit, spent: 0 });
    if (!store.budgetsFor({}).some((b) => b.level === 'global_month')) {
      store.addBudget({ level: 'global_month', target_id: null, limit: budget_limit * 10, spent: 0 });
    }

    writeAudit('workflow.created', { workflow_id, budget_limit });
    return { ...workflow };
  }

  function getWorkflow(workflow_id) {
    const w = workflows.get(workflow_id);
    return w ? { ...w } : null;
  }

  /**
   * All currently-PENDING work in a cancelled/failed workflow's tree is
   * cancelled. A task already RUNNING cannot be interrupted — nothing in
   * this codebase is asynchronous or preemptible yet; runTask() runs a
   * task to completion synchronously within one call, so by the time
   * control returns here a task is already terminal. "Cancel" therefore
   * means "prevent not-yet-started work from starting," honestly, not
   * "interrupt work in progress."
   */
  function cancelWorkflow({ workflow_id, reason }) {
    const workflow = workflows.get(workflow_id);
    if (!workflow) throw new Error(`unknown workflow: ${workflow_id}`);
    if (TERMINAL_STATES.has(workflow.state)) return { ...workflow };

    const now = clock();
    for (const id of workflow.task_ids) {
      const t = store.getTask(id);
      if (t.status === TASK_STATUS.PENDING) {
        store.updateTask(id, { status: TASK_STATUS.CANCELLED, completed_at: now, error: `workflow cancelled: ${reason ?? 'no reason given'}` });
      }
    }
    workflow.state = WORKFLOW_STATE.CANCELLED;
    workflow.completed_at = now;
    workflow.failure_reason = reason ?? 'cancelled';
    writeAudit('workflow.cancelled', { workflow_id, reason: reason ?? null });
    return { ...workflow };
  }

  // ── task admission — the gauntlet every task, human-proposed or
  //    model-proposed, must pass before it becomes real ───────────────

  /**
   * @param {{workflow_id, task_id, parent_task_id?, agent_slug, input, depends_on?}} args
   * @returns {{decision:'accepted'|'rejected', reason:string, task?:object, detail?:string}}
   */
  function addTask({ workflow_id, task_id, parent_task_id = null, agent_slug, input, depends_on = [] }) {
    const settle = (decision, reason, extra = {}) => {
      writeAudit('workflow.task_proposal', { workflow_id, task_id, parent_task_id, agent_slug, decision, reason, ...extra });
      return { decision, reason, ...extra };
    };

    const workflow = workflows.get(workflow_id);
    if (!workflow) return settle('rejected', WORKFLOW_REASON.UNKNOWN_WORKFLOW);
    if (!RUNNABLE_STATES.has(workflow.state)) return settle('rejected', WORKFLOW_REASON.WORKFLOW_NOT_RUNNABLE);

    // ── shape ────────────────────────────────────────────────────────
    if (typeof task_id !== 'string' || task_id === '') return settle('rejected', WORKFLOW_REASON.MALFORMED_PROPOSAL, { detail: 'task_id required' });
    if (workflow.task_ids.includes(task_id)) return settle('rejected', WORKFLOW_REASON.MALFORMED_PROPOSAL, { detail: 'duplicate task_id' });
    if (typeof agent_slug !== 'string' || agent_slug === '') return settle('rejected', WORKFLOW_REASON.MALFORMED_PROPOSAL, { detail: 'agent_slug required' });
    if (input === undefined) return settle('rejected', WORKFLOW_REASON.MALFORMED_PROPOSAL, { detail: 'input required' });
    if (!Array.isArray(depends_on)) return settle('rejected', WORKFLOW_REASON.MALFORMED_PROPOSAL, { detail: 'depends_on must be an array' });

    // ── total node ceiling — the one that matters most; depth and
    //    fanout alone permit 8^4 ≈ 4,600 tasks while both read as
    //    "satisfied" ────────────────────────────────────────────────
    if (workflow.node_count >= MAX_TOTAL_NODES) return settle('rejected', WORKFLOW_REASON.TOTAL_NODES_EXCEEDED);

    // ── depth ────────────────────────────────────────────────────────
    let depth = 0;
    if (parent_task_id !== null) {
      if (!workflow.task_ids.includes(parent_task_id)) {
        return settle('rejected', WORKFLOW_REASON.MALFORMED_PROPOSAL, { detail: 'unknown parent_task_id' });
      }
      depth = store.getTask(parent_task_id).depth + 1;
    }
    if (depth > MAX_DEPTH) return settle('rejected', WORKFLOW_REASON.DEPTH_EXCEEDED, { detail: `depth ${depth} exceeds ${MAX_DEPTH}` });

    // ── fan-out ──────────────────────────────────────────────────────
    if (parent_task_id !== null) {
      const siblingCount = workflow.task_ids
        .map((id) => store.getTask(id))
        .filter((t) => t.parent_task_id === parent_task_id).length;
      if (siblingCount >= MAX_FANOUT) return settle('rejected', WORKFLOW_REASON.FANOUT_EXCEEDED, { detail: `${siblingCount} >= ${MAX_FANOUT}` });
    }

    // ── dependencies must already exist in THIS workflow — no forward
    //    references, so resolution is always a single pass ────────────
    for (const dep of depends_on) {
      if (!workflow.task_ids.includes(dep)) return settle('rejected', WORKFLOW_REASON.MISSING_DEPENDENCY, { detail: dep });
    }

    // ── loop detection — deterministic, not heuristic. Two tasks with
    //    the same (agent, action, input) inside one tree are the same
    //    work proposed twice, whether that came from a human, a buggy
    //    handler, or a model that "returned JSON" describing a cycle ───
    const signature = taskSignature({ agent_slug, action_type: 'agent.run', input });
    const existingSignatures = new Set(workflow.task_ids.map((id) => store.getTask(id).signature));
    if (existingSignatures.has(signature)) return settle('rejected', WORKFLOW_REASON.LOOP_DETECTED);

    // ── agent / version — fail fast here; runtime.js re-checks
    //    authoritatively the moment this task actually executes. Two
    //    boundaries, same pattern as D20. ───────────────────────────
    const agent = store.getAgent(agent_slug);
    if (!agent) return settle('rejected', WORKFLOW_REASON.UNKNOWN_AGENT);
    if (typeof agent.clearance !== 'string' || !Array.isArray(agent.allowed_tools)) {
      return settle('rejected', WORKFLOW_REASON.INVALID_AGENT);
    }
    if (agent.version_state !== 'approved') return settle('rejected', WORKFLOW_REASON.VERSION_NOT_APPROVED);
    if (agent.state !== 'active') return settle('rejected', WORKFLOW_REASON.AGENT_NOT_ACTIVE);

    // ── workflow-wide budget — has the shared ceiling already been
    //    spent by earlier tasks in this same tree? Complements, does not
    //    replace, the Broker's own per-call BUDGET_EXCEEDED check ──────
    const treeBudget = store.budgetsFor({ tree_id: workflow_id, agent_slug }).find((b) => b.level === 'tree');
    if (treeBudget && treeBudget.spent >= treeBudget.limit) return settle('rejected', WORKFLOW_REASON.BUDGET_EXCEEDED);

    // ── every check passed — this task becomes real ─────────────────
    const task = store.createTask({
      id: task_id,
      parent_task_id,
      tree_id: workflow_id,
      workflow_id,
      depth,
      signature,
      agent_slug,
      agent_id: agent.agent_id,
      agent_version_id: agent.version_id,
      depends_on: [...depends_on],
      required_capability: null,
      input,
      output: null,
      status: TASK_STATUS.PENDING,
      attempt_number: 1,
      retry_of_task_id: null,
      created_at: clock(),
      started_at: null,
      completed_at: null,
      registry_sha: null,
    });

    // One task-level budget row per task; one agent_day row per agent
    // slug encountered, created once and shared by every task using it.
    if (!store.budgetsFor({ tree_id: workflow_id, agent_slug }).some((b) => b.level === 'agent_day')) {
      store.addBudget({ level: 'agent_day', target_id: agent_slug, limit: workflow.budget_limit, spent: 0 });
    }
    store.addBudget({ level: 'task', target_id: task_id, limit: workflow.budget_limit, spent: 0 });

    workflow.task_ids.push(task_id);
    workflow.node_count++;
    if (workflow.root_task_id === null) workflow.root_task_id = task_id;
    if (workflow.state === WORKFLOW_STATE.CREATED) workflow.state = WORKFLOW_STATE.RUNNING;

    return settle('accepted', WORKFLOW_REASON.OK, { task });
  }

  // ── retry — a NEW task record, never a resurrected old one. Same
  //    principle as idempotency: "a retry is a new attempt and the
  //    caller must decide it is safe." Deliberately bypasses loop
  //    detection (a retry legitimately repeats the prior signature on
  //    purpose) but nothing else — bounded instead by the ceiling. ────

  function retryTask({ workflow_id, task_id }) {
    const settle = (decision, reason, extra = {}) => {
      writeAudit('workflow.retry', { workflow_id, task_id, decision, reason, ...extra });
      return { decision, reason, ...extra };
    };

    const workflow = workflows.get(workflow_id);
    if (!workflow) return settle('rejected', WORKFLOW_REASON.UNKNOWN_WORKFLOW);
    if (workflow.state !== WORKFLOW_STATE.RUNNING && workflow.state !== WORKFLOW_STATE.WAITING) {
      return settle('rejected', WORKFLOW_REASON.WORKFLOW_NOT_RUNNABLE);
    }

    const original = store.getTask(task_id);
    if (!original || !workflow.task_ids.includes(task_id)) return settle('rejected', WORKFLOW_REASON.UNKNOWN_TASK);
    if (original.status !== TASK_STATUS.FAILED) return settle('rejected', WORKFLOW_REASON.NOT_RETRYABLE, { detail: 'task is not FAILED' });
    if (!RETRYABLE_REASONS.has(original.failure_reason_code)) {
      return settle('rejected', WORKFLOW_REASON.NOT_RETRYABLE, { detail: original.failure_reason_code ?? 'unknown' });
    }

    const attemptNumber = (original.attempt_number ?? 1) + 1;
    if (attemptNumber > MAX_TASK_RETRY_CEILING) return settle('rejected', WORKFLOW_REASON.RETRY_CEILING_EXCEEDED, { detail: `attempt ${attemptNumber} > ${MAX_TASK_RETRY_CEILING}` });
    if (workflow.node_count >= MAX_TOTAL_NODES) return settle('rejected', WORKFLOW_REASON.TOTAL_NODES_EXCEEDED);

    const agent = store.getAgent(original.agent_slug);
    if (!agent || agent.version_state !== 'approved' || agent.state !== 'active') {
      return settle('rejected', WORKFLOW_REASON.VERSION_NOT_APPROVED, { detail: 'agent no longer valid for retry' });
    }

    const retryTaskId = `${original.id}-retry-${attemptNumber}`;
    const retried = store.createTask({
      id: retryTaskId,
      parent_task_id: original.parent_task_id,
      tree_id: workflow_id,
      workflow_id,
      depth: original.depth,
      signature: original.signature,
      agent_slug: original.agent_slug,
      agent_id: original.agent_id,
      agent_version_id: original.agent_version_id,
      depends_on: [...(original.depends_on ?? [])],
      required_capability: original.required_capability ?? null,
      input: original.input,
      output: null,
      status: TASK_STATUS.PENDING,
      attempt_number: attemptNumber,
      retry_of_task_id: original.id,
      created_at: clock(),
      started_at: null,
      completed_at: null,
      registry_sha: null,
    });
    store.addBudget({ level: 'task', target_id: retryTaskId, limit: workflow.budget_limit, spent: 0 });

    workflow.task_ids.push(retryTaskId);
    workflow.node_count++;

    return settle('accepted', WORKFLOW_REASON.OK, { task: retried });
  }

  // ── stepping — advance the workflow by exactly one bounded round ────

  /**
   * One round: propagate failure/cancellation to blocked dependents to a
   * fixed point, run every currently-ready task once through the
   * unmodified runtime, admit any child tasks those runs propose, queue
   * automatic retries for newly-failed retryable tasks, then recompute
   * workflow state. Call repeatedly (or via runToCompletion) until
   * terminal.
   *
   * @returns {{ran:object[], cancelled:string[], retried:object[], workflow:object}}
   */
  function step({ workflow_id }) {
    const workflow = workflows.get(workflow_id);
    if (!workflow) throw new Error(`unknown workflow: ${workflow_id}`);
    if (TERMINAL_STATES.has(workflow.state)) return { ran: [], cancelled: [], retried: [], workflow: { ...workflow } };

    const now = clock();
    const byId = () => new Map(workflow.task_ids.map((id) => [id, store.getTask(id)]));
    let tasks = byId();

    // 1 — propagate: a task depending on a failed/cancelled task can
    // never run. Iterate to a fixed point so a chain (B on A, C on B)
    // cancels in one step rather than one hop per step call.
    const cancelledThisStep = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks.values()) {
        if (task.status !== TASK_STATUS.PENDING) continue;
        const blocker = (task.depends_on ?? []).find((depId) => {
          const dep = tasks.get(depId);
          return dep && (dep.status === TASK_STATUS.FAILED || dep.status === TASK_STATUS.CANCELLED);
        });
        if (blocker) {
          const cancelled = store.updateTask(task.id, {
            status: TASK_STATUS.CANCELLED,
            completed_at: now,
            error: `dependency ${blocker} did not complete`,
          });
          tasks.set(task.id, cancelled);
          cancelledThisStep.push(task.id);
          writeAudit('workflow.task_cancelled', { workflow_id, task_id: task.id, reason: 'DEPENDENCY_FAILED', detail: blocker });
          changed = true;
        }
      }
    }

    // 2 — ready = PENDING with every dependency COMPLETED
    const ready = [...tasks.values()].filter(
      (t) => t.status === TASK_STATUS.PENDING && (t.depends_on ?? []).every((depId) => tasks.get(depId)?.status === TASK_STATUS.COMPLETED),
    );

    // 3 — run each ready task through the UNCHANGED runtime, respecting
    // the shared tree budget before spending more of it
    const ran = [];
    const newlyFailed = [];
    for (const task of ready) {
      const treeBudget = store.budgetsFor({ tree_id: workflow_id, agent_slug: task.agent_slug }).find((b) => b.level === 'tree');
      if (treeBudget && treeBudget.spent >= treeBudget.limit) {
        writeAudit('workflow.budget_exhausted', { workflow_id, task_id: task.id });
        continue; // leave PENDING; fail closed by not running, not by guessing
      }

      const result = runtime.runTask({
        agent_slug: task.agent_slug,
        input: task.input,
        task_id: task.id,
        tree_id: workflow_id,
        depth: task.depth,
      });
      ran.push(result);
      tasks.set(task.id, result);
      if (result.status === TASK_STATUS.FAILED) newlyFailed.push(result);

      // 4 — untrusted child proposals: the ONLY path from "a handler's
      // envelope contains JSON" to "a real task" is the full addTask
      // gauntlet above. A model proposing 20 children gets the first 8
      // admitted (fan-out) and the rest explicitly rejected and audited
      // — never silently truncated, never silently allowed.
      if (result.status === TASK_STATUS.COMPLETED && Array.isArray(result.output?.proposed_child_tasks)) {
        let n = 0;
        for (const proposal of result.output.proposed_child_tasks) {
          n++;
          if (!isPlainObject(proposal) || typeof proposal.agent_slug !== 'string' || proposal.input === undefined) {
            writeAudit('workflow.task_proposal', {
              workflow_id, task_id: `${task.id}-child-${n}`, parent_task_id: task.id,
              decision: 'rejected', reason: WORKFLOW_REASON.MALFORMED_PROPOSAL,
            });
            continue;
          }
          addTask({
            workflow_id,
            task_id: `${task.id}-child-${n}`,
            parent_task_id: task.id,
            agent_slug: proposal.agent_slug,
            input: proposal.input,
            depends_on: Array.isArray(proposal.depends_on) ? proposal.depends_on : [],
          });
        }
      }
    }

    // 5 — automatic bounded retry for newly-failed, retryable tasks
    const retried = [];
    for (const failedTask of newlyFailed) {
      if (!RETRYABLE_REASONS.has(failedTask.failure_reason_code)) continue;
      const outcome = retryTask({ workflow_id, task_id: failedTask.id });
      if (outcome.decision === 'accepted') retried.push(outcome.task);
    }

    // 6 — recompute state from the tree's current, final-for-this-step shape
    tasks = byId();
    const all = [...tasks.values()];
    const anyPending = all.some((t) => t.status === TASK_STATUS.PENDING);
    const anyFailed = all.some((t) => t.status === TASK_STATUS.FAILED);
    const anyCancelled = all.some((t) => t.status === TASK_STATUS.CANCELLED);

    if (!anyPending) {
      if (anyFailed) {
        workflow.state = WORKFLOW_STATE.FAILED;
        workflow.failure_reason = all.find((t) => t.status === TASK_STATUS.FAILED)?.error ?? 'a task failed';
      } else if (anyCancelled) {
        workflow.state = WORKFLOW_STATE.CANCELLED;
        workflow.failure_reason = workflow.failure_reason ?? 'a task was cancelled';
      } else {
        workflow.state = WORKFLOW_STATE.COMPLETED;
      }
      workflow.completed_at = now;
    } else {
      const madeProgress = ran.length > 0 || cancelledThisStep.length > 0 || retried.length > 0;
      workflow.state = madeProgress ? WORKFLOW_STATE.RUNNING : WORKFLOW_STATE.WAITING;
    }

    return { ran, cancelled: cancelledThisStep, retried, workflow: { ...workflow } };
  }

  /**
   * Repeatedly steps until the workflow reaches a terminal state or
   * makes no further progress, bounded by max_steps regardless — cheap
   * insurance against a step-logic edge case looping forever, on top of
   * (not instead of) MAX_TOTAL_NODES already bounding the tree itself.
   */
  function runToCompletion({ workflow_id, max_steps = MAX_TOTAL_NODES + 8 }) {
    let last;
    for (let i = 0; i < max_steps; i++) {
      last = step({ workflow_id });
      if (TERMINAL_STATES.has(last.workflow.state)) return last.workflow;
      if (last.workflow.state === WORKFLOW_STATE.WAITING) return last.workflow; // stuck; caller decides
    }
    return last.workflow;
  }

  return { createWorkflow, getWorkflow, addTask, retryTask, step, runToCompletion, cancelWorkflow };
}

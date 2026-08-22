/**
 * MODEL RESOURCE GOVERNOR (Milestone 13)
 *
 * The single place model-call resource consumption is attributed and
 * bounded across the full hierarchy the M13 directive names:
 *
 *   GLOBAL → AGENT → WORKFLOW → TASK → MODEL CALL
 *
 * Every level is checked, reserved, and charged independently on every
 * call. That is what makes "a child cannot consume more than its parent
 * allows" true WITHOUT needing to validate at configuration time that a
 * workflow's ceiling is <= its agent's ceiling: whichever ceiling is
 * tightest is the one that actually stops the call, every time,
 * regardless of what number any other level was configured with.
 *
 * ── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────
 *
 * It does not authorize a tool call (the Broker's job). It does not
 * select an agent (the router's job). It does not coordinate tasks (the
 * workflow engine's job). It does not freeze anything (Guardian's job —
 * see guardian.js's new `evaluateModelResourceFailures`, which reads the
 * `model.governor` audit events this file writes; the Governor itself
 * has no reference to `store.addFreeze` or anything that could impose
 * one). It holds no reference to the Broker, to store's mutation
 * methods, to agents.js, or to anything that could grant clearance,
 * approve a version, lift a freeze, or raise a budget. Its constructor
 * takes only `modelRuntime` (already governed, already bounded — see
 * async-model-runtime.js), the read-only closed `registry` (to look up
 * a model's own declared worst-case cost — the same reference
 * model-runtime.js already holds), `audit`, `clock`, and a policy of
 * plain numbers this file's own API configures. See DECISIONS.md D30.
 *
 * ── RESERVE, INVOKE, SETTLE ─────────────────────────────────────────────
 *
 * Every call: (1) validate request shape, (2) look up the model's
 * declared worst-case cost, (3) check every applicable ceiling
 * (global → agent → workflow → task → per-scope call-count), (4) reserve
 * that worst case at every level — synchronously, before the one
 * `await` in this whole function, which is what makes concurrent
 * reservations safe in a single-threaded event loop without a lock:
 * two overlapping `invoke()` calls cannot interleave their reservation
 * step, because nothing yields control between it and the check that
 * guards it — (5) invoke the already-governed model runtime, (6) settle
 * every reservation against the real outcome — release the unused
 * portion on success, release the FULL reservation on failure, since a
 * failed call spent nothing real.
 *
 * ── AGENTS AND MODELS CANNOT RAISE THEIR OWN LIMITS ─────────────────────
 *
 * Every ceiling comes from this file's own closure, set only through
 * `configure*Budget()` — never read from the `request` object a handler
 * supplies. A request may carry `max_retries` (already clamped
 * server-side by async-model-runtime.js) but nothing resembling a
 * budget or limit value; if it does, this file ignores it. Test 268
 * proves this directly: a request smuggling `budget_limit: Infinity`
 * changes nothing.
 *
 * ── ESTIMATED VS ACTUAL, HONESTLY ────────────────────────────────────────
 *
 * The reservation amount (`estimated_cost`, before the call) is always
 * the model's declared `max_cost_per_call` — a real, worst-case ceiling
 * every provider definition must declare, not a guess. After the call,
 * `usage_status` is `'ACTUAL'` only when the provider returned finite,
 * non-negative `input_units`/`output_units`; otherwise it is
 * `'ESTIMATED'` and the charge falls back to the same worst-case ceiling
 * rather than trusting arithmetic on a NaN or negative number into the
 * budget ledger. Never a fabricated token count. Never a fabricated
 * monetary figure presented as measured.
 *
 * Constitution: sections 13, 22, 23.
 */

import { sanitizeUsageUnits } from './async-model-runtime.js';

export const RESOURCE_REASON = Object.freeze({
  // Reused, not duplicated — model-runtime.js / async-model-runtime.js
  // already define and enforce these at the request/provider/model
  // level; the governor delegates to them rather than re-checking.
  //   INVALID_REQUEST          → malformed request shape
  //   INPUT_LIMIT_EXCEEDED     → "MODEL_INPUT_TOO_LARGE"
  //   OUTPUT_LIMIT_EXCEEDED    → "MODEL_OUTPUT_TOO_LARGE"
  //   TIMEOUT                  → "MODEL_TIMEOUT"
  //   RETRY_CEILING_EXCEEDED   → "MODEL_RETRY_LIMIT"
  //   BUDGET_MISSING/EXCEEDED  → the provider:model level (unchanged)
  //
  // Genuinely new — no existing reason expresses these:
  GLOBAL_MODEL_BUDGET_EXCEEDED: 'GLOBAL_MODEL_BUDGET_EXCEEDED',
  AGENT_MODEL_BUDGET_EXCEEDED: 'AGENT_MODEL_BUDGET_EXCEEDED',
  WORKFLOW_MODEL_BUDGET_EXCEEDED: 'WORKFLOW_MODEL_BUDGET_EXCEEDED',
  TASK_MODEL_BUDGET_EXCEEDED: 'TASK_MODEL_BUDGET_EXCEEDED',
  MODEL_CALL_LIMIT: 'MODEL_CALL_LIMIT',
  RESOURCE_RESERVATION_FAILED: 'RESOURCE_RESERVATION_FAILED',
  MODEL_USAGE_UNAVAILABLE: 'MODEL_USAGE_UNAVAILABLE', // an audited qualifier on a SUCCESSFUL call, never a denial reason on its own
});

export const RESOURCE_GOVERNOR_POLICY = Object.freeze({
  MAX_CALLS_PER_TASK: 10,
  MAX_CALLS_PER_WORKFLOW: 50,
});

function newScope(limit) {
  return { limit, spent: 0, reserved: 0 };
}

/**
 * @param {object} deps
 * @param {{invokeModel: Function}} deps.modelRuntime  an already-governed
 *   runtime — async-model-runtime.js's createAsyncModelRuntime() output.
 *   This file never talks to a provider directly.
 * @param {{getProvider:Function, getModel:Function}} deps.registry  the
 *   same closed, read-only registry model runtimes already hold — used
 *   only to read a model's declared max_cost_per_call.
 * @param {object} deps.audit
 * @param {() => number} deps.clock
 * @param {object} [deps.policy]
 */
export function createResourceGovernor({ modelRuntime, registry, audit, clock, policy = RESOURCE_GOVERNOR_POLICY }) {
  const global = newScope(null);
  /** @type {Map<string, {limit:number, spent:number, reserved:number}>} */
  const agents = new Map();
  const workflows = new Map();
  const tasks = new Map();
  const taskCalls = new Map(); // task_id -> count
  const workflowCalls = new Map(); // workflow_id -> count

  function writeAudit(event, fields) {
    audit.write({ event, at: clock(), ...fields });
  }

  // ── configuration — the ONLY way a ceiling is ever set ───────────────
  function configureGlobalBudget(limit) {
    global.limit = limit;
  }
  function configureAgentBudget(agent_slug, limit) {
    agents.set(agent_slug, newScope(limit));
  }
  function configureWorkflowBudget(workflow_id, limit) {
    workflows.set(workflow_id, newScope(limit));
  }
  function configureTaskBudget(task_id, limit) {
    tasks.set(task_id, newScope(limit));
  }

  // ── introspection ──────────────────────────────────────────────────
  const usageOf = (scope) => (scope ? { limit: scope.limit, spent: scope.spent, reserved: scope.reserved } : null);
  function getGlobalUsage() { return usageOf(global); }
  function getAgentUsage(agent_slug) { return usageOf(agents.get(agent_slug)); }
  function getWorkflowUsage(workflow_id) { return usageOf(workflows.get(workflow_id)); }
  function getTaskUsage(task_id) { return usageOf(tasks.get(task_id)); }

  /**
   * Checks and reserves one scope. Returns null on success, or a
   * {reason, detail} object fully describing why it failed — never
   * throws, never partially reserves.
   */
  function tryReserve(scope, amount, exceededReason, label) {
    // The global scope always exists as an object (there is exactly one),
    // but its `limit` starts null until configureGlobalBudget() is
    // called — checking `!scope` alone would miss that case, since
    // `0 + 0 + amount > null` coerces to `> 0`, which is almost always
    // true and would misreport an unconfigured global scope as
    // "exceeded" rather than "never configured."
    if (!scope || !Number.isFinite(scope.limit)) {
      return { reason: RESOURCE_REASON.RESOURCE_RESERVATION_FAILED, detail: `no ${label} budget configured` };
    }
    if (scope.spent + scope.reserved + amount > scope.limit) {
      return {
        reason: exceededReason,
        detail: `${label}: ${scope.spent}+${scope.reserved}+${amount} > ${scope.limit}`,
      };
    }
    scope.reserved += amount;
    return null;
  }

  function release(scope, amount) {
    if (!scope) return;
    scope.reserved = Math.max(0, scope.reserved - amount);
  }

  function settle(scope, reservedAmount, actualAmount) {
    if (!scope) return;
    scope.reserved = Math.max(0, scope.reserved - reservedAmount);
    scope.spent += actualAmount;
  }

  /**
   * @param {object} request  same shape async-model-runtime.js accepts,
   *   PLUS agent_version_id for attribution. workflow_id and task_id are
   *   read from `tree_id`/`task_id` (the existing field names throughout
   *   this codebase) so no field is invented that duplicates one that
   *   already exists.
   */
  async function invoke(request) {
    const startedAt = clock();
    const settleAudit = (status, reason, patch = {}) => {
      const record = {
        event: 'model.governor',
        at: clock(),
        agent_slug: request?.agent_slug ?? null,
        agent_version_id: request?.agent_version_id ?? null,
        workflow_id: request?.tree_id ?? null,
        task_id: request?.task_id ?? null,
        provider_id: request?.provider_id ?? null,
        model_id: request?.model_id ?? null,
        status,
        reason,
        elapsed_ms: clock() - startedAt,
        ...patch,
      };
      audit.write(record);
      return record;
    };

    // 0 — shape. Reuses the exact reason model-runtime.js already uses
    // for this condition — not duplicated.
    if (!request || typeof request !== 'object') {
      return settleAudit('failed', 'INVALID_REQUEST', { output: null, error: 'no request' });
    }
    if (typeof request.provider_id !== 'string' || typeof request.model_id !== 'string') {
      return settleAudit('failed', 'INVALID_REQUEST', { output: null, error: 'provider_id and model_id are required' });
    }

    const model = registry.getModel(request.provider_id, request.model_id);
    if (!model) return settleAudit('failed', 'UNKNOWN_MODEL', { output: null });

    const amount = model.max_cost_per_call; // the worst-case reservation — see file header
    const agentSlug = request.agent_slug ?? null;
    const workflowId = request.tree_id ?? null;
    const taskId = request.task_id ?? null;

    // 1 — call-count ceilings, cheapest checks, before touching any budget
    if (taskId) {
      const count = taskCalls.get(taskId) ?? 0;
      if (count >= policy.MAX_CALLS_PER_TASK) {
        return settleAudit('failed', RESOURCE_REASON.MODEL_CALL_LIMIT, { output: null, detail: `task ${taskId}: ${count} >= ${policy.MAX_CALLS_PER_TASK}` });
      }
    }
    if (workflowId) {
      const count = workflowCalls.get(workflowId) ?? 0;
      if (count >= policy.MAX_CALLS_PER_WORKFLOW) {
        return settleAudit('failed', RESOURCE_REASON.MODEL_CALL_LIMIT, { output: null, detail: `workflow ${workflowId}: ${count} >= ${policy.MAX_CALLS_PER_WORKFLOW}` });
      }
    }

    // 2 — reserve top-down: global, then agent, then workflow, then task.
    // Whichever is tightest is the one that actually binds — see header.
    const reservations = [];
    const chain = [
      [global, RESOURCE_REASON.GLOBAL_MODEL_BUDGET_EXCEEDED, 'global'],
      agentSlug ? [agents.get(agentSlug), RESOURCE_REASON.AGENT_MODEL_BUDGET_EXCEEDED, `agent ${agentSlug}`] : null,
      workflowId ? [workflows.get(workflowId), RESOURCE_REASON.WORKFLOW_MODEL_BUDGET_EXCEEDED, `workflow ${workflowId}`] : null,
      taskId ? [tasks.get(taskId), RESOURCE_REASON.TASK_MODEL_BUDGET_EXCEEDED, `task ${taskId}`] : null,
    ].filter(Boolean);

    for (const [scope, reason, label] of chain) {
      const failure = tryReserve(scope, amount, reason, label);
      if (failure) {
        // Fail closed: release whatever was already reserved earlier in
        // this same chain before reporting the failure.
        for (const [reservedScope] of reservations) release(reservedScope, amount);
        return settleAudit('failed', failure.reason, { output: null, detail: failure.detail, estimated_cost: amount });
      }
      reservations.push([scope]);
    }

    // 3 — call counts are committed now, not on success only: an
    // attempted call that got far enough to reserve budget is a real
    // attempt, whether or not it ultimately succeeds.
    if (taskId) taskCalls.set(taskId, (taskCalls.get(taskId) ?? 0) + 1);
    if (workflowId) workflowCalls.set(workflowId, (workflowCalls.get(workflowId) ?? 0) + 1);

    // 4 — invoke the already-governed inner runtime. Every check it owns
    // (input size, provider:model budget, retry ceiling, timeout, output
    // size, output contract) still applies, unchanged, underneath this.
    const result = await modelRuntime.invokeModel(request);

    // 5 — settle every reservation against the real outcome.
    if (result.status !== 'ok') {
      for (const [scope] of reservations) release(scope, amount);
      return settleAudit('failed', result.reason, {
        output: null, detail: result.detail ?? null, estimated_cost: amount, inner_status: result.status,
      });
    }

    const inputUnits = sanitizeUsageUnits(result.usage?.input_units);
    const outputUnits = sanitizeUsageUnits(result.usage?.output_units);
    const usageValid = inputUnits !== null && outputUnits !== null && Number.isFinite(result.cost) && result.cost >= 0;
    const actualCost = usageValid ? result.cost : amount; // never trust a negative/NaN figure into the ledger
    const usageStatus = usageValid ? 'ACTUAL' : 'ESTIMATED';

    for (const [scope] of reservations) settle(scope, amount, actualCost);

    return settleAudit('ok', 'OK', {
      output: result.output,
      usage: usageValid ? result.usage : null,
      usage_status: usageStatus,
      estimated_cost: amount,
      actual_cost: actualCost,
      attempts: result.attempts ?? null,
    });
  }

  return {
    invoke,
    configureGlobalBudget,
    configureAgentBudget,
    configureWorkflowBudget,
    configureTaskBudget,
    getGlobalUsage,
    getAgentUsage,
    getWorkflowUsage,
    getTaskUsage,
  };
}

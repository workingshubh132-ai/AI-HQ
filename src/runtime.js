/**
 * MINIMAL AI-HQ RUNTIME
 *
 * Executes exactly one bounded task through one agent.
 *
 * ── WHY THE RUNTIME HAS ITS OWN PRE-FLIGHT CHECKS ──────────────────────
 *
 * The Broker gates TOOL CALLS. It never sees an agent being invoked. A
 * handler that computes without calling a tool would therefore run even for
 * a paused agent or an unapproved version — the Broker would have no
 * opportunity to object, because nothing was ever asked of it.
 *
 * So the runtime gates AGENT EXECUTION and the Broker gates TOOL EXECUTION.
 * Two boundaries, both must hold. This is not authorization moving out of
 * the Broker: every tool call still goes through it unchanged, and the
 * runtime cannot allow anything the Broker would deny.
 *
 * ── WHAT THE RUNTIME MAY NOT DO ────────────────────────────────────────
 *
 * It holds no tool handlers and no credentials. It can only ask the Broker.
 *
 * Constitution: sections 13, 20, 21.
 */

import { taskSignature, MAX_DEPTH } from './limits.js';
import { DECISION } from './broker.js';

export const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

export const RUNTIME_REASON = Object.freeze({
  OK: 'OK',
  UNKNOWN_AGENT: 'UNKNOWN_AGENT',
  INVALID_AGENT: 'INVALID_AGENT',
  VERSION_NOT_APPROVED: 'VERSION_NOT_APPROVED',
  AGENT_NOT_ACTIVE: 'AGENT_NOT_ACTIVE',
  AGENT_FROZEN: 'AGENT_FROZEN',
  NO_HANDLER: 'NO_HANDLER',
  INPUT_CONTRACT_VIOLATION: 'INPUT_CONTRACT_VIOLATION',
  OUTPUT_CONTRACT_VIOLATION: 'OUTPUT_CONTRACT_VIOLATION',
  BUDGET_MISSING: 'BUDGET_MISSING',
  DEPTH_EXCEEDED: 'DEPTH_EXCEEDED',
  HANDLER_ERROR: 'HANDLER_ERROR',
});

const TYPE_OF = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

/**
 * Deterministic contract check. Deliberately small: required keys and
 * declared types, nothing more. A schema language is not needed to prove a
 * runtime contract, and every feature added here is a feature that can be
 * wrong.
 */
function checkContract(contract, value) {
  if (!contract || typeof contract !== 'object') return null;
  if (!value || typeof value !== 'object') return 'value is not an object';

  for (const key of contract.required ?? []) {
    if (value[key] === undefined || value[key] === null) return `missing required field: ${key}`;
  }
  for (const [key, expected] of Object.entries(contract.types ?? {})) {
    if (value[key] === undefined) continue;
    const actual = TYPE_OF(value[key]);
    if (actual !== expected) return `field ${key} must be ${expected}, got ${actual}`;
  }
  return null;
}

/** The envelope every agent returns, checked before anything downstream sees it. */
function checkEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return 'envelope is not an object';
  if (!['ok', 'partial', 'failed'].includes(envelope.status)) return `unrecognised status: ${JSON.stringify(envelope.status)}`;
  if (envelope.result === undefined) return 'envelope has no result field';
  if (!Array.isArray(envelope.proposed_actions)) return 'proposed_actions must be an array';
  if (!Array.isArray(envelope.errors)) return 'errors must be an array';
  return null;
}

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} deps.broker
 * @param {object} deps.audit
 * @param {() => number} deps.clock
 * @param {Record<string, Function>} deps.handlers  deterministic agent handlers
 * @param {string} deps.registrySha  identity of the code that ran
 */
export function createRuntime({ store, broker, audit, clock, handlers, registrySha }) {
  /**
   * Runs one task to completion.
   * @returns {object} the final task record
   */
  function runTask({ agent_slug, input, task_id, tree_id, depth = 0, required_capability = null }) {
    const now = clock();
    const agent = store.getAgent(agent_slug);

    const signature = taskSignature({
      agent_slug,
      action_type: 'agent.run',
      input,
    });

    let task = store.createTask({
      id: task_id,
      parent_task_id: null,
      tree_id,
      depth,
      signature,
      agent_slug,
      agent_id: agent?.agent_id ?? null,
      agent_version_id: agent?.version_id ?? null,
      required_capability,          // recorded. Routing does not exist yet
      input,
      output: null,
      status: TASK_STATUS.PENDING,
      created_at: now,
      started_at: null,
      completed_at: null,
      registry_sha: registrySha,
    });

    const fail = (reason, detail) => {
      const updated = store.updateTask(task.id, {
        status: TASK_STATUS.FAILED,
        completed_at: clock(),
        error: detail ?? reason,
      });
      audit.write({
        event: 'runtime.task',
        at: clock(),
        task_id: task.id,
        tree_id,
        agent_slug,
        agent_id: agent?.agent_id ?? null,
        agent_version_id: agent?.version_id ?? null,
        registry_sha: registrySha,
        signature,
        status: TASK_STATUS.FAILED,
        reason,
        detail: detail ?? null,
      });
      return updated;
    };

    // ── PRE-FLIGHT. Nothing runs until all of this holds. ───────────────
    if (!agent) return fail(RUNTIME_REASON.UNKNOWN_AGENT);
    if (typeof agent.clearance !== 'string' || !Array.isArray(agent.allowed_tools)) {
      return fail(RUNTIME_REASON.INVALID_AGENT, 'agent has no resolvable active version');
    }
    if (agent.version_state !== 'approved') {
      return fail(RUNTIME_REASON.VERSION_NOT_APPROVED, `active version is ${agent.version_state ?? 'unresolved'}`);
    }
    if (store.activeFreeze('agent', agent_slug, now)) return fail(RUNTIME_REASON.AGENT_FROZEN);
    if (store.activeFreeze('global', null, now)) return fail(RUNTIME_REASON.AGENT_FROZEN, 'global freeze');
    if (agent.state !== 'active') return fail(RUNTIME_REASON.AGENT_NOT_ACTIVE, `state is ${agent.state}`);
    if (depth > MAX_DEPTH) return fail(RUNTIME_REASON.DEPTH_EXCEEDED, `depth ${depth} exceeds ${MAX_DEPTH}`);

    const handler = Object.hasOwn(handlers, agent_slug) ? handlers[agent_slug] : null;
    if (!handler) return fail(RUNTIME_REASON.NO_HANDLER);

    const inputError = checkContract(agent.input_contract, input);
    if (inputError) return fail(RUNTIME_REASON.INPUT_CONTRACT_VIOLATION, inputError);

    // A task with no budget is not authorised to spend. The Broker would
    // deny anyway; failing here means the handler never runs at all.
    if (store.budgetsFor({ task_id, tree_id, agent_slug }).length === 0) {
      return fail(RUNTIME_REASON.BUDGET_MISSING);
    }

    task = store.updateTask(task.id, { status: TASK_STATUS.RUNNING, started_at: now });

    // ── EXECUTION ───────────────────────────────────────────────────────
    // The handler's only route to a tool. It cannot reach a handler
    // directly, and the Broker's answer is final.
    const callTool = (tool_id, payload, idempotency_key = null) =>
      broker.execute({ agent_slug, tool_id, payload, task_id, tree_id, idempotency_key });

    let envelope;
    try {
      envelope = handler({ input, callTool, DECISION });
    } catch (err) {
      return fail(RUNTIME_REASON.HANDLER_ERROR, String(err.message));
    }

    const envelopeError = checkEnvelope(envelope);
    if (envelopeError) return fail(RUNTIME_REASON.OUTPUT_CONTRACT_VIOLATION, envelopeError);

    const resultError = checkContract(agent.output_contract, envelope.result);
    if (resultError) return fail(RUNTIME_REASON.OUTPUT_CONTRACT_VIOLATION, resultError);

    const completed = store.updateTask(task.id, {
      status: TASK_STATUS.COMPLETED,
      output: envelope,
      completed_at: clock(),
    });

    audit.write({
      event: 'runtime.task',
      at: clock(),
      task_id: task.id,
      tree_id,
      agent_slug,
      agent_id: agent.agent_id,
      agent_version_id: agent.version_id,
      registry_sha: registrySha,
      signature,
      status: TASK_STATUS.COMPLETED,
      reason: RUNTIME_REASON.OK,
      detail: null,
    });

    return completed;
  }

  return { runTask };
}

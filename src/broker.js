/**
 * THE TOOL BROKER
 *
 * The primary security boundary of AI-HQ. Every other layer can be wrong
 * without a breach; if this is wrong, the rest is decoration.
 *
 * TWO INVARIANTS THIS FILE EXISTS TO UPHOLD:
 *
 *   1. Only ALLOW may reach a handler. No DENY or NEEDS_APPROVAL path
 *      invokes a tool. Ever.
 *   2. The agent's prompt is consulted at no point in this file.
 *
 * Constitution: sections 8, 9, 10, 12, 13, 14.
 */

import { lookupAction, tierRank, TIER, SIDE_EFFECT } from './actions.js';

/** Three outcomes, deliberately distinct (DECISIONS D-c). */
export const DECISION = Object.freeze({
  /** Authorized and executable. */
  ALLOW: 'ALLOW',
  /** Cannot execute under current authority or configuration. */
  DENY: 'DENY',
  /** Potentially executable, but requires human authorization. */
  NEEDS_APPROVAL: 'NEEDS_APPROVAL',
});

/** Machine-readable reasons. Every decision carries exactly one. */
export const REASON = Object.freeze({
  OK: 'OK',
  INVALID_REQUEST: 'INVALID_REQUEST',
  GLOBAL_FREEZE: 'GLOBAL_FREEZE',
  UNKNOWN_AGENT: 'UNKNOWN_AGENT',
  INVALID_AGENT: 'INVALID_AGENT',
  AGENT_FROZEN: 'AGENT_FROZEN',
  AGENT_NOT_ACTIVE: 'AGENT_NOT_ACTIVE',
  WORKFLOW_FROZEN: 'WORKFLOW_FROZEN',
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  TOOL_NOT_ALLOWED: 'TOOL_NOT_ALLOWED',
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
  RED_REQUIRES_HUMAN: 'RED_REQUIRES_HUMAN',
  CLEARANCE_INSUFFICIENT: 'CLEARANCE_INSUFFICIENT',
  SCOPE_VIOLATION: 'SCOPE_VIOLATION',
  BUDGET_MISSING: 'BUDGET_MISSING',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  APPROVAL_MISSING: 'APPROVAL_MISSING',
  APPROVAL_NOT_GRANTED: 'APPROVAL_NOT_GRANTED',
  APPROVAL_MISMATCH: 'APPROVAL_MISMATCH',
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  INVALID_APPROVAL: 'INVALID_APPROVAL',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_IN_FLIGHT: 'IDEMPOTENCY_IN_FLIGHT',
  HANDLER_ERROR: 'HANDLER_ERROR',
});

/** Agents may hold GREEN or YELLOW. RED is human-only by definition. */
const AGENT_CLEARANCES = Object.freeze([TIER.GREEN, TIER.YELLOW]);
const AGENT_STATES = Object.freeze([
  'draft', 'testing', 'active', 'degraded', 'paused', 'frozen', 'retired',
]);
const APPROVAL_STATUSES = Object.freeze(['pending', 'approved', 'rejected']);

/** Deterministic serialization so payload comparison is order-independent. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/** Fails closed: anything not provably well-formed is rejected. */
function validateAgent(agent) {
  if (!agent || typeof agent !== 'object') return 'not an object';
  if (typeof agent.slug !== 'string' || agent.slug === '') return 'missing slug';
  if (!AGENT_CLEARANCES.includes(agent.clearance)) {
    return `clearance must be GREEN or YELLOW (got ${JSON.stringify(agent.clearance)})`;
  }
  if (!AGENT_STATES.includes(agent.state)) return 'unrecognised lifecycle state';
  if (!Array.isArray(agent.allowed_tools)) return 'allowed_tools must be an array';
  if (!agent.allowed_tools.every((t) => typeof t === 'string')) return 'allowed_tools must be strings';
  return null;
}

/** Fails closed: a malformed approval authorizes nothing. */
function validateApproval(approval) {
  if (!approval || typeof approval !== 'object') return 'not an object';
  if (!APPROVAL_STATUSES.includes(approval.status)) return 'unrecognised status';
  if (typeof approval.action_type !== 'string') return 'missing action_type';
  if (!approval.payload || typeof approval.payload !== 'object') return 'missing payload';
  if (approval.status === 'approved') {
    if (typeof approval.decided_by !== 'string' || approval.decided_by === '') return 'approved without decided_by';
    if (!Number.isFinite(approval.decided_at)) return 'approved without decided_at';
  }
  if (approval.expires_at != null && !Number.isFinite(approval.expires_at)) return 'unparseable expires_at';
  if (approval.approved_payload != null && typeof approval.approved_payload !== 'object') {
    return 'approved_payload must be an object';
  }
  return null;
}

/** Tool-declared required keys and value allowlists, then agent narrowing. */
function checkScope(tool, agent, payload) {
  const schema = tool.scope_schema;
  if (!schema) return null;
  if (!payload || typeof payload !== 'object') return 'payload missing';

  for (const key of schema.required ?? []) {
    if (payload[key] === undefined || payload[key] === null || payload[key] === '') {
      return `required scope key missing: ${key}`;
    }
  }
  for (const [key, permitted] of Object.entries(schema.allow ?? {})) {
    if (payload[key] !== undefined && !permitted.includes(payload[key])) {
      return `value not permitted for ${key}: ${String(payload[key])}`;
    }
  }
  // Agents may narrow a tool's scope further, never widen it.
  const agentScope = agent.scopes?.[tool.tool_id];
  if (agentScope) {
    for (const [key, permitted] of Object.entries(agentScope)) {
      if (payload[key] !== undefined && !permitted.includes(payload[key])) {
        return `value outside agent scope for ${key}: ${String(payload[key])}`;
      }
    }
  }
  return null;
}

/**
 * Per-item approval resolution.
 *
 * This is the ONLY step that changes when batch and standing-policy approvals
 * arrive (DECISIONS D7). Those become additional resolvers behind this same
 * signature; no calling code changes.
 */
function resolvePerItemApproval({ store, taskId, actionType, payload, now }) {
  const candidates = store.approvalsForTask(taskId);
  if (candidates.length === 0) return { state: 'MISSING' };

  for (const approval of candidates) {
    const invalid = validateApproval(approval);
    if (invalid) return { state: 'INVALID', detail: invalid };
  }

  const sameAction = candidates.filter((a) => a.action_type === actionType);
  if (sameAction.length === 0) return { state: 'MISMATCH', detail: 'no approval for this action type' };

  const wanted = stableStringify(payload);
  const matching = sameAction.filter((a) => stableStringify(a.payload) === wanted);
  if (matching.length === 0) return { state: 'MISMATCH', detail: 'payload does not match any approval' };

  const granted = matching.find((a) => a.status === 'approved');
  if (!granted) return { state: 'NOT_GRANTED', detail: 'approval is pending or rejected' };

  if (granted.expires_at != null && granted.expires_at <= now) {
    return { state: 'EXPIRED', detail: 'approval expired' };
  }

  // An edited approval executes what the HUMAN authorized, never the
  // agent's original proposal.
  return { state: 'GRANTED', approval: granted, effective_payload: granted.approved_payload ?? granted.payload };
}

/**
 * @param {object} deps
 * @param {Record<string,object>} deps.tools
 * @param {object} deps.store
 * @param {object} deps.audit
 * @param {() => number} deps.clock  epoch ms, injected so expiry is testable
 */
export function createBroker({ tools, store, audit, clock }) {
  /**
   * Decide. Never executes anything.
   * @returns {{decision:string, reason:string, ...}}
   */
  function authorize(request) {
    const now = clock();

    const base = {
      at: now,
      agent_slug: request?.agent_slug ?? null,
      tool_id: request?.tool_id ?? null,
      task_id: request?.task_id ?? null,
      action_type: null,
      tier: null,
      idempotency_key: request?.idempotency_key ?? null,
    };

    const settle = (decision, reason, detail) => {
      const record = { ...base, decision, reason, detail: detail ?? null };
      audit.write({ event: 'broker.decision', ...record });
      return record;
    };

    // 0 — request shape
    if (!request || typeof request !== 'object') return settle(DECISION.DENY, REASON.INVALID_REQUEST, 'no request');
    if (typeof request.agent_slug !== 'string' || typeof request.tool_id !== 'string') {
      return settle(DECISION.DENY, REASON.INVALID_REQUEST, 'agent_slug and tool_id are required');
    }

    // 1 — global emergency stop, before any other work.
    //
    // ANY active freeze in scope blocks, soft or hard. Soft freezes are meant
    // to throttle rather than stop, but throttling belongs to the Guardian,
    // which does not exist yet. Until it does, a soft freeze blocks like a
    // hard one — the conservative reading, and consistent with how agent and
    // workflow freezes are treated below. A soft freeze still auto-lifts when
    // its expires_at passes; a hard freeze carries no expiry.
    const globalFreeze = store.activeFreeze('global', null, now);
    if (globalFreeze) {
      return settle(DECISION.DENY, REASON.GLOBAL_FREEZE, globalFreeze.reason);
    }

    // 2 — agent exists and is well-formed
    const agent = store.getAgent(request.agent_slug);
    if (!agent) return settle(DECISION.DENY, REASON.UNKNOWN_AGENT);
    const agentInvalid = validateAgent(agent);
    if (agentInvalid) return settle(DECISION.DENY, REASON.INVALID_AGENT, agentInvalid);

    // 3 — agent freeze and lifecycle state
    if (store.activeFreeze('agent', agent.slug, now)) {
      return settle(DECISION.DENY, REASON.AGENT_FROZEN);
    }
    if (agent.state !== 'active') {
      return settle(DECISION.DENY, REASON.AGENT_NOT_ACTIVE, `state is ${agent.state}`);
    }

    // 4 — workflow freeze
    if (request.tree_id && store.activeFreeze('workflow', request.tree_id, now)) {
      return settle(DECISION.DENY, REASON.WORKFLOW_FROZEN);
    }

    // 5 — tool must be registered
    const tool = Object.hasOwn(tools, request.tool_id) ? tools[request.tool_id] : null;
    if (!tool) return settle(DECISION.DENY, REASON.UNKNOWN_TOOL);

    // 6 — tool must be on this agent's allowlist (deny by default)
    if (!agent.allowed_tools.includes(tool.tool_id)) {
      return settle(DECISION.DENY, REASON.TOOL_NOT_ALLOWED);
    }

    // 7 — action classification. Unknown resolves to RED.
    const action = lookupAction(tool.action_type);
    base.action_type = tool.action_type;
    base.tier = action.tier;
    if (!action.known) {
      return settle(DECISION.DENY, REASON.UNKNOWN_ACTION, 'unclassified action resolved to RED');
    }

    // 8 — RED is human-only, regardless of the agent's clearance.
    //     Checked BEFORE clearance because it is the stronger fact: no agent
    //     may execute RED, so no clearance value can make it possible.
    if (action.tier === TIER.RED) {
      return settle(DECISION.DENY, REASON.RED_REQUIRES_HUMAN);
    }

    // 9 — clearance
    if (tierRank(action.tier) > tierRank(agent.clearance)) {
      return settle(DECISION.DENY, REASON.CLEARANCE_INSUFFICIENT, `${action.tier} > ${agent.clearance}`);
    }

    // 10 — scope
    const scopeError = checkScope(tool, agent, request.payload);
    if (scopeError) return settle(DECISION.DENY, REASON.SCOPE_VIOLATION, scopeError);

    // 11 — budgets must exist at every applicable level
    const applicable = store.budgetsFor(request);
    if (applicable.length === 0) return settle(DECISION.DENY, REASON.BUDGET_MISSING);

    // 12 — and be sufficient at every one of them
    const overspent = applicable.find((b) => b.spent + tool.cost > b.limit);
    if (overspent) {
      return settle(DECISION.DENY, REASON.BUDGET_EXCEEDED, `${overspent.level}: ${overspent.spent}+${tool.cost} > ${overspent.limit}`);
    }

    // 13 — YELLOW requires a human decision
    let effectivePayload = request.payload;
    if (action.tier === TIER.YELLOW) {
      const resolution = resolvePerItemApproval({
        store,
        taskId: request.task_id,
        actionType: action.action_type,
        payload: request.payload,
        now,
      });
      switch (resolution.state) {
        case 'MISSING':
          return settle(DECISION.NEEDS_APPROVAL, REASON.APPROVAL_MISSING);
        case 'INVALID':
          return settle(DECISION.DENY, REASON.INVALID_APPROVAL, resolution.detail);
        case 'MISMATCH':
          return settle(DECISION.DENY, REASON.APPROVAL_MISMATCH, resolution.detail);
        case 'NOT_GRANTED':
          return settle(DECISION.DENY, REASON.APPROVAL_NOT_GRANTED, resolution.detail);
        case 'EXPIRED':
          return settle(DECISION.DENY, REASON.APPROVAL_EXPIRED, resolution.detail);
        case 'GRANTED': {
          effectivePayload = resolution.effective_payload;
          // Re-check scope against what will ACTUALLY execute. A human edit
          // that moves the payload outside the tool's declared bounds is
          // almost certainly a mistake, and this is the last place to catch
          // it before a side effect happens.
          const editedScopeError = checkScope(tool, agent, effectivePayload);
          if (editedScopeError) {
            return settle(DECISION.DENY, REASON.SCOPE_VIOLATION, `approved payload: ${editedScopeError}`);
          }
          break;
        }
        default:
          // Unreachable by construction; fail closed if it ever is reached.
          return settle(DECISION.DENY, REASON.INVALID_APPROVAL, 'unrecognised resolution');
      }
    }

    const allowed = settle(DECISION.ALLOW, REASON.OK);
    return { ...allowed, effective_payload: effectivePayload };
  }

  /**
   * Authorize, then act. A handler is reachable from exactly one place in
   * this function, guarded by a single ALLOW check.
   *
   * Order, per Constitution section 14:
   *   security checks -> idempotency lookup/claim -> execute -> record result
   */
  function execute(request) {
    const decision = authorize(request);
    if (decision.decision !== DECISION.ALLOW) {
      return { ...decision, executed: false, replayed: false, result: null };
    }

    const tool = tools[request.tool_id];
    const action = lookupAction(tool.action_type);
    const key = request.idempotency_key ?? null;

    const finish = (patch, reason) => {
      const record = { ...decision, reason: reason ?? decision.reason, ...patch };
      audit.write({ event: 'broker.execution', ...record });
      return record;
    };

    // Externally side-effecting actions may not run without a key. Fail closed.
    if (action.idempotency_required && !key) {
      return finish({ executed: false, replayed: false, result: null, decision: DECISION.DENY },
        REASON.IDEMPOTENCY_KEY_REQUIRED);
    }

    // Idempotency lookup — only ever reached AFTER authorization passed.
    if (key) {
      const existing = store.getIdempotency(key);
      if (existing) {
        if (existing.state === 'in_flight') {
          return finish({ executed: false, replayed: false, result: null, decision: DECISION.DENY },
            REASON.IDEMPOTENCY_IN_FLIGHT);
        }
        // Replay. The handler is NOT invoked and no budget is charged.
        return finish({
          executed: false,
          replayed: true,
          result: existing.state === 'completed' ? existing.result : null,
          error: existing.error ?? null,
        });
      }
      store.claimIdempotency(key);
    }

    // The single point in this file where a handler is invoked.
    try {
      const result = tool.handler(decision.effective_payload);
      store.chargeBudgets(store.budgetsFor(request), tool.cost);
      if (key) store.recordIdempotency(key, { state: 'completed', result });
      return finish({ executed: true, replayed: false, result });
    } catch (err) {
      // A failed key stays failed. Retrying requires a NEW key, because a
      // retry is a new attempt and the caller must decide it is safe.
      if (key) store.recordIdempotency(key, { state: 'failed', error: String(err.message) });
      return finish({ executed: false, replayed: false, result: null, error: String(err.message) },
        REASON.HANDLER_ERROR);
    }
  }

  return { authorize, execute };
}

export { SIDE_EFFECT };

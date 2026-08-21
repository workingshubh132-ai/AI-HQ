/**
 * ROUTER — MULTI-AGENT CONTROL PLANE (Milestone 9)
 *
 * Answers exactly one question: "which eligible agent should handle this?"
 * It never answers "is this agent allowed to do it?" — that is, and
 * remains, the Broker's job for tool execution and the runtime's job for
 * agent execution. This file has no reference to the Broker, cannot call
 * a tool, cannot mutate clearance/scopes/budgets' authorization semantics,
 * cannot approve a version, and cannot lift a freeze.
 *
 * ── THE ARCHITECTURE THIS FILE SITS INSIDE ─────────────────────────────
 *
 *   Router          →  selects an already-authorized-in-principle agent
 *         │
 *         ▼
 *   Workflow Engine  →  Task           →  Agent Runtime  →  Handler
 *   (unchanged)                                                  │
 *                                                                 ▼
 *                                                              Broker  →  Tool
 *
 * A routing decision is advice, not a capability. A caller still calls
 * `engine.addTask({ agent_slug: decision.selected_agent_slug, ... })`
 * exactly as before M9 — addTask() and runtime.js re-derive and re-check
 * agent/version validity from scratch regardless of what the router said.
 * If the router were deleted entirely, or a caller bypassed it and typed
 * an agent_slug by hand, nothing downstream would notice: the same
 * addTask() gauntlet and the same runtime.js pre-flight apply either way.
 *
 * ── CAPABILITIES ARE ADVISORY, NEVER AUTHORIZATION ─────────────────────
 *
 * `agent.capabilities` (declared on the immutable version, since M5) is a
 * label an agent's author attached for matching purposes. The router uses
 * it to narrow candidates. It grants nothing: an agent claiming "research"
 * still only has whatever `allowed_tools` its approved version lists, and
 * the Broker still decides every tool call exactly as it always has. See
 * the adversarial test in router.test.js proving a capability claim with
 * no matching tool authorization is still denied at execution.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────
 *
 * No randomness, no LLM, no hidden heuristic. Given the same task request,
 * the same store contents, and the same ROUTING_POLICY_VERSION, `route()`
 * always returns the same decision: eligible candidates are filtered by
 * the fixed rule list below, then the first by ascending agent_slug wins.
 *
 * ── CONCURRENCY IS RESERVATION ACCOUNTING, NOT REAL CONCURRENCY ─────────
 *
 * Nothing in this codebase is asynchronous yet — runtime.runTask() runs a
 * task to completion synchronously within one call, so two tasks for one
 * agent can never actually overlap in wall-clock time today. What this
 * file provides instead is honest bookkeeping: `route()` reserves a slot
 * for the task it selects an agent for, and a caller releases that slot
 * via `release()` once the task reaches a terminal state (COMPLETED,
 * FAILED, or CANCELLED). This is accounting a future asynchronous runtime
 * could rely on for real, not a claim that concurrent execution exists
 * today. See DECISIONS.md D26.
 *
 * ── HEALTH REUSES RUNTIME_STATE — IT IS NOT A NEW FIELD ─────────────────
 *
 * `RUNTIME_STATE` (agents.js) already has ACTIVE / PAUSED / DEGRADED /
 * FROZEN / RETIRED, and the Broker and runtime.js already refuse to run
 * anything for a non-'active' agent. Inventing a parallel `health_state`
 * field would be exactly the "second competing representation" the
 * project has repeatedly rejected (see D23, D25). `setAgentHealth()` below
 * is a thin, audited wrapper over the existing `store.setLifecycleState`
 * — it does not add new state, only a recorded reason and timestamp for
 * a transition that was previously silent.
 *
 * Constitution: sections 6, 7, 13, 18, 20, 25.
 */

/** Bumped only if the routing policy itself (the rule list, the
 * tie-break) changes shape — recorded on every decision so a future
 * change in behavior is distinguishable in the audit log from a change
 * in the agents being routed over. */
export const ROUTING_POLICY_VERSION = 'router-v1';

/** Ceiling on per-agent concurrency, mirroring validator.js's POLICY
 * ceiling pattern — a configured `concurrency_limit` above this is
 * clamped, never trusted as-is. */
export const MAX_AGENT_CONCURRENCY = 4;

export const ROUTING_REASON = Object.freeze({
  OK: 'OK',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  NO_ELIGIBLE_AGENT: 'NO_ELIGIBLE_AGENT',
  GLOBAL_FREEZE: 'GLOBAL_FREEZE',
  WORKFLOW_FROZEN: 'WORKFLOW_FROZEN',
  INVALID_AGENT: 'INVALID_AGENT',
  AGENT_NOT_ACTIVE: 'AGENT_NOT_ACTIVE',
  AGENT_FROZEN: 'AGENT_FROZEN',
  VERSION_NOT_APPROVED: 'VERSION_NOT_APPROVED',
  CAPABILITY_NOT_DECLARED: 'CAPABILITY_NOT_DECLARED',
  WORKFLOW_TYPE_NOT_SUPPORTED: 'WORKFLOW_TYPE_NOT_SUPPORTED',
  AGENT_CONCURRENCY_LIMIT: 'AGENT_CONCURRENCY_LIMIT',
  BUDGET_INSUFFICIENT: 'BUDGET_INSUFFICIENT',
  UNKNOWN_AGENT: 'UNKNOWN_AGENT',
});

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} deps.audit
 * @param {() => number} deps.clock
 */
export function createRouter({ store, audit, clock }) {
  /** @type {Map<string, Set<string>>} agent_slug -> Set<task_id> currently reserved */
  const reservations = new Map();

  function writeAudit(event, fields) {
    audit.write({ event, at: clock(), ...fields });
  }

  function reservedCount(agentSlug) {
    return reservations.get(agentSlug)?.size ?? 0;
  }

  function concurrencyLimitFor(agent) {
    const configured = Number.isFinite(agent.concurrency_limit) ? agent.concurrency_limit : MAX_AGENT_CONCURRENCY;
    return Math.max(0, Math.min(configured, MAX_AGENT_CONCURRENCY));
  }

  /**
   * Eligibility for ONE candidate. Every check here is advisory selection
   * criteria, not authorization — the Broker/runtime re-derive and
   * re-check the security-relevant subset of this independently the
   * moment the task actually executes.
   *
   * @returns {{eligible:boolean, reason?:string, detail?:string, matched_capabilities?:string[]}}
   */
  function evaluateCandidate(agent, { required_capability, required_workflow_type, workflow_id, now }) {
    // 2/3/4 — active, version present, version approved. A single
    // structural check first: an agent with no resolvable version has
    // no clearance/allowed_tools shape to speak of, mirroring the exact
    // INVALID_AGENT check runtime.js and workflow.js already use.
    if (typeof agent.clearance !== 'string' || !Array.isArray(agent.allowed_tools)) {
      return { eligible: false, reason: ROUTING_REASON.INVALID_AGENT, detail: 'agent has no resolvable active version' };
    }
    if (agent.version_state !== 'approved') {
      return { eligible: false, reason: ROUTING_REASON.VERSION_NOT_APPROVED, detail: `active version is ${agent.version_state ?? 'unresolved'}` };
    }
    // Lifecycle: RUNTIME_STATE already has PAUSED/DEGRADED/FROZEN/RETIRED
    // alongside ACTIVE. Requiring exactly 'active' here is what makes the
    // router refuse a paused OR degraded agent — no separate health field
    // needed; see the file header and DECISIONS.md D26.
    if (agent.state !== 'active') {
      return { eligible: false, reason: ROUTING_REASON.AGENT_NOT_ACTIVE, detail: `state is ${agent.state}` };
    }
    // 5 — freeze is a SEPARATE axis from lifecycle state (human/Guardian
    // imposed, not authored on the agent record).
    if (store.activeFreeze('agent', agent.slug, now)) {
      return { eligible: false, reason: ROUTING_REASON.AGENT_FROZEN };
    }

    // 6 — required capability must be declared. Advisory metadata used
    // only for matching — see the file header.
    const capabilities = Array.isArray(agent.capabilities) ? agent.capabilities : [];
    if (required_capability && !capabilities.includes(required_capability)) {
      return { eligible: false, reason: ROUTING_REASON.CAPABILITY_NOT_DECLARED };
    }

    // 7 — required workflow type, if the caller cares. An agent that
    // declares no restriction (empty array) is read as general-purpose,
    // not as supporting nothing — see the file header.
    const allowedTypes = Array.isArray(agent.allowed_workflow_types) ? agent.allowed_workflow_types : [];
    if (required_workflow_type && allowedTypes.length > 0 && !allowedTypes.includes(required_workflow_type)) {
      return { eligible: false, reason: ROUTING_REASON.WORKFLOW_TYPE_NOT_SUPPORTED };
    }

    // 8 — concurrency. Reservation accounting, not real concurrency — see
    // the file header.
    const limit = concurrencyLimitFor(agent);
    if (reservedCount(agent.slug) >= limit) {
      return { eligible: false, reason: ROUTING_REASON.AGENT_CONCURRENCY_LIMIT, detail: `${reservedCount(agent.slug)} >= ${limit}` };
    }

    // 9 — budget. Coarse "not fully exhausted" check, exactly the pattern
    // workflow.js's addTask() already uses for the tree-level budget —
    // not a re-implementation of the Broker's per-call cost arithmetic,
    // which still runs at actual execution time regardless of this.
    const applicable = store.budgetsFor({ tree_id: workflow_id ?? undefined, agent_slug: agent.slug });
    const exhausted = applicable.find((b) => (b.level === 'agent_day' || b.level === 'tree') && b.spent >= b.limit);
    if (exhausted) {
      return { eligible: false, reason: ROUTING_REASON.BUDGET_INSUFFICIENT, detail: `${exhausted.level} exhausted` };
    }

    return { eligible: true, matched_capabilities: required_capability ? [required_capability] : [] };
  }

  /**
   * @param {{task_id:string, required_capability:string, workflow_id?:string, required_workflow_type?:string}} request
   * @returns {object} a routing decision — advice, never authorization
   */
  function route(request) {
    const now = clock();
    const settle = (decision, reason, extra = {}) => {
      const record = {
        decision, reason,
        task_id: request?.task_id ?? null,
        workflow_id: request?.workflow_id ?? null,
        required_capability: request?.required_capability ?? null,
        routing_policy_version: ROUTING_POLICY_VERSION,
        selected_agent_id: null,
        selected_agent_slug: null,
        selected_agent_version_id: null,
        matched_capabilities: [],
        candidate_agent_slugs: [],
        rejected_candidates: [],
        ...extra,
      };
      writeAudit('router.decision', record);
      return record;
    };

    // 0 — request shape. Fails closed on anything not provably well-formed.
    if (!request || typeof request !== 'object') return settle('malformed_request', ROUTING_REASON.MALFORMED_REQUEST, { detail: 'no request' });
    if (typeof request.task_id !== 'string' || request.task_id === '') {
      return settle('malformed_request', ROUTING_REASON.MALFORMED_REQUEST, { detail: 'task_id required' });
    }
    if (typeof request.required_capability !== 'string' || request.required_capability === '') {
      return settle('malformed_request', ROUTING_REASON.MALFORMED_REQUEST, { detail: 'required_capability required' });
    }
    if (request.workflow_id !== undefined && typeof request.workflow_id !== 'string') {
      return settle('malformed_request', ROUTING_REASON.MALFORMED_REQUEST, { detail: 'workflow_id must be a string when present' });
    }

    // 1 — freezes that would make ANY routing pointless, checked before
    // candidate evaluation — the same "cheapest, most global check first"
    // ordering the Broker and runtime.js already use.
    if (store.activeFreeze('global', null, now)) {
      return settle('no_eligible_agent', ROUTING_REASON.GLOBAL_FREEZE);
    }
    if (request.workflow_id && store.activeFreeze('workflow', request.workflow_id, now)) {
      return settle('no_eligible_agent', ROUTING_REASON.WORKFLOW_FROZEN);
    }

    const allAgents = store.listAgents();
    const candidateSlugs = allAgents.map((a) => a.slug).sort();
    const rejected = [];
    const eligible = [];

    for (const slug of candidateSlugs) {
      const agent = allAgents.find((a) => a.slug === slug);
      const verdict = evaluateCandidate(agent, {
        required_capability: request.required_capability,
        required_workflow_type: request.required_workflow_type ?? null,
        workflow_id: request.workflow_id ?? null,
        now,
      });
      if (verdict.eligible) {
        eligible.push(agent);
      } else {
        rejected.push({ agent_slug: slug, reason: verdict.reason, detail: verdict.detail ?? null });
      }
    }

    if (eligible.length === 0) {
      return settle('no_eligible_agent', ROUTING_REASON.NO_ELIGIBLE_AGENT, {
        candidate_agent_slugs: candidateSlugs,
        rejected_candidates: rejected,
      });
    }

    // Deterministic tie-break: first eligible candidate by ascending
    // agent_slug. No randomness, no scoring heuristic.
    const selected = eligible[0];

    // The reservation IS what "selected" means for concurrency purposes.
    if (!reservations.has(selected.slug)) reservations.set(selected.slug, new Set());
    reservations.get(selected.slug).add(request.task_id);

    return settle('routed', ROUTING_REASON.OK, {
      selected_agent_id: selected.agent_id,
      selected_agent_slug: selected.slug,
      selected_agent_version_id: selected.version_id,
      matched_capabilities: [request.required_capability],
      candidate_agent_slugs: candidateSlugs,
      rejected_candidates: rejected,
    });
  }

  /**
   * Releases a concurrency reservation. Call once a routed task reaches a
   * terminal state (COMPLETED, FAILED, or CANCELLED). Idempotent and
   * fails closed quietly — releasing a reservation that was never held
   * (unknown agent, unknown task, already released) is a no-op, not a
   * throw, because a caller reconciling state after a crash should never
   * be punished for calling this defensively.
   */
  function release({ agent_slug, task_id }) {
    const set = reservations.get(agent_slug);
    const held = set ? set.has(task_id) : false;
    if (set) set.delete(task_id);
    writeAudit('router.release', { agent_slug, task_id, released: held });
    return { released: held };
  }

  /** Current reservation count for one agent. Introspection only. */
  function getConcurrency(agent_slug) {
    return reservedCount(agent_slug);
  }

  /**
   * The explicit, controlled, audited path for a health-relevant lifecycle
   * transition. Thin wrapper over the EXISTING store.setLifecycleState —
   * adds nothing to the security model, only a recorded reason and
   * timestamp for a transition that was previously silent. Fails closed
   * on an unknown agent rather than creating phantom state.
   */
  function setAgentHealth({ agent_slug, state, reason }) {
    const agent = store.getAgentRecord(agent_slug);
    if (!agent) {
      writeAudit('router.health_change', { agent_slug, state, reason: reason ?? null, applied: false, detail: 'unknown agent' });
      return { applied: false, reason: ROUTING_REASON.UNKNOWN_AGENT };
    }
    const updated = store.setLifecycleState(agent_slug, state);
    writeAudit('router.health_change', { agent_slug, state, reason: reason ?? null, applied: true });
    return { applied: true, agent: updated };
  }

  return { route, release, getConcurrency, setAgentHealth };
}

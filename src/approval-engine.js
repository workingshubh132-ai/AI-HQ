/**
 * POLICY / APPROVAL ENGINE (Milestone 18)
 *
 * "Approval is permission to perform an otherwise-authorized action when
 * policy requires human confirmation. It never grants authority."
 *
 * This file has exactly two responsibilities, and no others:
 *
 *   1. POLICY — does this action need no approval (GREEN), require one
 *      (YELLOW), or remain impossible for any agent (RED)? `decidePolicy`
 *      answers this by reusing `actions.js`'s existing TIER classification
 *      — the same static, agent-unreachable table `lookupAction()` has
 *      used since M4. No new tier system, no AI policy judge.
 *
 *   2. APPROVAL LIFECYCLE — `requestApproval` creates an immutable PENDING
 *      record through the same governed gauntlet the Broker itself
 *      re-checks (agent exists, version approved, lifecycle active, tool
 *      allowed); `decide` records an explicit human decision as a NEW
 *      record, never mutating the original; `revoke` does the same for
 *      withdrawing an already-approved one.
 *
 * ── THIS FILE HAS NO AUTHORIZATION LOGIC OF ITS OWN ─────────────────────
 *
 * It never decides whether a tool call executes. Every approval record it
 * creates is inert data until `broker.authorize()`/`broker.execute()` —
 * completely unmodified in its decision-making except for the small,
 * additive, backward-compatible binding checks M18 added to
 * `resolvePerItemApproval` (see broker.js and DECISIONS.md D35) — reaches
 * its own, independent, unconditional conclusion from that record: payload
 * hash, rendered description, tool, action, clearance, scope, budget,
 * freeze, lifecycle, and (new) agent/version/registry binding, all
 * re-derived by the Broker itself, every time. Deleting this file removes
 * the ability to create or decide approvals; it removes no authorization
 * check anywhere else. A model's output, a handler's return value, or an
 * agent's own request can never reach any function in this file — none of
 * them are passed a reference to it (see runtime.js's fixed handler
 * signature, unchanged since M14).
 *
 * ── ONE-TIME USE: DELIBERATELY NOT IMPLEMENTED, DOCUMENTED HONESTLY ──────
 *
 * An approved record stays usable for any request matching its task_id +
 * action_type + payload until it expires or is revoked — it is not
 * consumed after one execution. The actual "this exact attempt happens
 * once" guarantee already exists, proven concurrency-safe against a real
 * database (M11, test 227): the Broker's own `idempotency_key` mechanism.
 * Making an approval single-use as well would mean mutating an otherwise-
 * immutable record on every use (in direct tension with "never mutate the
 * historical record") or inventing a second atomic-claim primitive
 * alongside idempotency's — a materially larger change with no concrete
 * evidence yet that reusable-within-validity approvals are actually being
 * exploited. See DECISIONS.md D35.
 *
 * Constitution: sections 9, 10, 11.
 */

import { randomUUID } from 'node:crypto';
import { lookupAction, TIER } from './actions.js';
import { hashPayload, renderPayload } from './payload.js';

export const POLICY_DECISION = Object.freeze({
  ALLOWED: 'ALLOWED', // GREEN — no approval needed
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED', // YELLOW
  DENIED: 'DENIED', // RED, or the tool/action itself is invalid
});

/** Reuses the Broker's own status vocabulary exactly (broker.js's
 * APPROVAL_STATUSES, now including 'revoked' — see DECISIONS.md D35) —
 * not a parallel enum that could drift from what the Broker accepts. */
export const APPROVAL_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  REVOKED: 'revoked',
});

export const APPROVAL_REASON = Object.freeze({
  OK: 'OK',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  UNKNOWN_AGENT: 'UNKNOWN_AGENT',
  INVALID_AGENT: 'INVALID_AGENT',
  VERSION_NOT_APPROVED: 'VERSION_NOT_APPROVED',
  AGENT_NOT_ACTIVE: 'AGENT_NOT_ACTIVE',
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  TOOL_NOT_ALLOWED: 'TOOL_NOT_ALLOWED',
  RED_REQUIRES_HUMAN: 'RED_REQUIRES_HUMAN',
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
  EXPIRY_INVALID: 'EXPIRY_INVALID',
  APPROVAL_NOT_FOUND: 'APPROVAL_NOT_FOUND',
  APPROVAL_NOT_PENDING: 'APPROVAL_NOT_PENDING',
  APPROVAL_NOT_APPROVED: 'APPROVAL_NOT_APPROVED',
  APPROVAL_ACTOR_INVALID: 'APPROVAL_ACTOR_INVALID',
});

/** A bounded ceiling, not an arbitrary/infinite one — the M18 directive's
 * own explicit requirement. 30 days: long enough for a real human review
 * cycle, short enough that a forgotten pending request cannot become a
 * standing, unreviewed grant of authority. */
export const MAX_APPROVAL_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {Record<string,object>} deps.tools
 * @param {object} deps.audit
 * @param {() => number} deps.clock
 * @param {string|null} [deps.registrySha]  recorded on every approval this
 *   engine creates — the same identity runtime.js already records on
 *   every task, extended here to approvals. Optional; null means "not
 *   tracked," same default `createBroker` now uses (D35).
 */
export function createApprovalEngine({ store, tools, audit, clock, registrySha = null }) {
  /** The clock prefix keeps IDs roughly time-ordered for a human scanning
   * logs; `randomUUID()` (node:crypto — already an existing dependency via
   * payload.js's `createHash`, no new package) is what actually guarantees
   * uniqueness. A per-instance counter alone is not enough: two engine
   * instances sharing one clock tick (a real possibility — a fixed test
   * clock, or two processes racing the same millisecond in production)
   * would otherwise generate identical IDs and collide on the store's
   * unique approval_id constraint, exactly as happened against a real,
   * shared Postgres database during M18's own test development. */
  function generateApprovalId() {
    return `approval-${clock()}-${randomUUID()}`;
  }

  function writeAudit(event, fields) {
    audit.write({ event, at: clock(), registry_sha: registrySha, ...fields });
  }

  /**
   * Pure lookup: does this tool's action need no approval, one, or is it
   * impossible for any agent? Reuses actions.js's TIER classification —
   * the single source of truth broker.js itself defers to. No agent, no
   * payload, no judgment call: same tool_id, same answer, always.
   */
  function decidePolicy({ tool_id }) {
    const tool = Object.hasOwn(tools, tool_id) ? tools[tool_id] : null;
    if (!tool) return { decision: POLICY_DECISION.DENIED, reason: APPROVAL_REASON.UNKNOWN_TOOL, tier: null, action_type: null };

    const action = lookupAction(tool.action_type);
    if (!action.known) {
      return { decision: POLICY_DECISION.DENIED, reason: APPROVAL_REASON.UNKNOWN_ACTION, tier: TIER.RED, action_type: tool.action_type };
    }
    if (action.tier === TIER.RED) {
      return { decision: POLICY_DECISION.DENIED, reason: APPROVAL_REASON.RED_REQUIRES_HUMAN, tier: TIER.RED, action_type: action.action_type };
    }
    if (action.tier === TIER.YELLOW) {
      return { decision: POLICY_DECISION.APPROVAL_REQUIRED, reason: APPROVAL_REASON.OK, tier: TIER.YELLOW, action_type: action.action_type };
    }
    return { decision: POLICY_DECISION.ALLOWED, reason: APPROVAL_REASON.OK, tier: TIER.GREEN, action_type: action.action_type };
  }

  /**
   * The governed 8-step creation path. Never auto-approves — the returned
   * record's status is always 'pending'. Fails closed, WITHOUT creating
   * any record, on anything that would make the request impossible for
   * the Broker to ever honor regardless of a human's decision — the same
   * "fail fast, re-verify authoritatively later" pattern workflow.js's
   * addTask() already established (D20): this is advisory pre-flight, not
   * a second authorization boundary, and the Broker re-derives every one
   * of these facts from scratch at execution time regardless.
   *
   * @param {{agent_slug:string, tool_id:string, payload:unknown, task_id:string,
   *   expires_in_ms:number, actor:string, actor_type?:string, reason?:string}} request
   */
  async function requestApproval(request = {}) {
    const settle = (outcome, code, extra = {}) => {
      const record = {
        outcome, code,
        agent_slug: request.agent_slug ?? null,
        tool_id: request.tool_id ?? null,
        task_id: request.task_id ?? null,
        detail: extra.detail ?? null,
      };
      writeAudit('approval.requested', record);
      return { ...record, ...extra };
    };

    if (typeof request.agent_slug !== 'string' || request.agent_slug === '') {
      return settle('rejected', APPROVAL_REASON.MALFORMED_REQUEST, { detail: 'agent_slug required' });
    }
    if (typeof request.tool_id !== 'string' || request.tool_id === '') {
      return settle('rejected', APPROVAL_REASON.MALFORMED_REQUEST, { detail: 'tool_id required' });
    }
    if (request.payload === undefined) {
      return settle('rejected', APPROVAL_REASON.MALFORMED_REQUEST, { detail: 'payload required' });
    }
    if (typeof request.task_id !== 'string' || request.task_id === '') {
      return settle('rejected', APPROVAL_REASON.MALFORMED_REQUEST, { detail: 'task_id required' });
    }
    if (!isNonEmptyString(request.actor)) {
      return settle('rejected', APPROVAL_REASON.APPROVAL_ACTOR_INVALID, { detail: 'a non-empty actor is required to request an approval' });
    }
    if (!Number.isFinite(request.expires_in_ms) || request.expires_in_ms <= 0 || request.expires_in_ms > MAX_APPROVAL_EXPIRY_MS) {
      return settle('rejected', APPROVAL_REASON.EXPIRY_INVALID, {
        detail: `expires_in_ms must be a finite number in (0, ${MAX_APPROVAL_EXPIRY_MS}]`,
      });
    }

    // 1–2 — resolve agent and its active version (one flat, resolved read
    // — the same shape the Broker itself consumes).
    const agent = await store.getAgent(request.agent_slug);
    if (!agent) return settle('rejected', APPROVAL_REASON.UNKNOWN_AGENT);
    if (typeof agent.clearance !== 'string' || !Array.isArray(agent.allowed_tools)) {
      return settle('rejected', APPROVAL_REASON.INVALID_AGENT, { detail: 'agent has no resolvable active version' });
    }
    // 3 — version must be approved
    if (agent.version_state !== 'approved') {
      return settle('rejected', APPROVAL_REASON.VERSION_NOT_APPROVED, { detail: `active version is ${agent.version_state ?? 'unresolved'}` });
    }
    // 4 — lifecycle must permit the request
    if (agent.state !== 'active') {
      return settle('rejected', APPROVAL_REASON.AGENT_NOT_ACTIVE, { detail: `state is ${agent.state}` });
    }
    // 5 — the proposed tool/action must be valid and allowed for this agent
    const tool = Object.hasOwn(tools, request.tool_id) ? tools[request.tool_id] : null;
    if (!tool) return settle('rejected', APPROVAL_REASON.UNKNOWN_TOOL);
    if (!agent.allowed_tools.includes(tool.tool_id)) {
      return settle('rejected', APPROVAL_REASON.TOOL_NOT_ALLOWED);
    }
    const policy = decidePolicy({ tool_id: request.tool_id });
    if (policy.decision === POLICY_DECISION.DENIED) {
      return settle('rejected', policy.reason, { detail: 'this action can never be approved for an agent' });
    }
    if (policy.decision === POLICY_DECISION.ALLOWED) {
      // GREEN: no approval is needed at all — creating one would be
      // exactly the "approval as a second Broker" this file must not
      // become. Nothing is recorded as pending; there is nothing pending.
      return { outcome: 'not_required', code: APPROVAL_REASON.OK, policy: policy.decision };
    }

    // 6–8 — hash, render, and bind the description to the payload/tool,
    // reusing M4.5/M4.6's exact functions — never re-implemented here.
    const payload_hash = hashPayload(request.payload);
    const rendered_description = renderPayload(tool.tool_id, policy.action_type, request.payload);

    // 9 — create the immutable PENDING request. Never auto-approved.
    const now = clock();
    const approval = Object.freeze({
      approval_id: generateApprovalId(),
      task_id: request.task_id,
      agent_id: agent.agent_id,
      version_id: agent.version_id,
      registry_sha: registrySha,
      tool_id: tool.tool_id,
      action_type: policy.action_type,
      payload: request.payload,
      payload_hash,
      rendered_description,
      status: APPROVAL_STATUS.PENDING,
      reason: request.reason ?? null,
      requested_by: request.actor,
      requested_at: now,
      expires_at: now + request.expires_in_ms,
      decided_by: null,
      decided_at: null,
      approved_payload: null,
      approved_payload_hash: null,
      approval_reference: null,
    });
    await store.addApproval(approval);
    writeAudit('approval.requested', {
      outcome: 'created', code: APPROVAL_REASON.OK,
      approval_id: approval.approval_id, agent_slug: request.agent_slug, agent_id: agent.agent_id,
      version_id: agent.version_id, tool_id: tool.tool_id, task_id: request.task_id, actor: request.actor,
    });
    return { outcome: 'created', code: APPROVAL_REASON.OK, policy: POLICY_DECISION.APPROVAL_REQUIRED, approval };
  }

  /**
   * 10 — the explicit HUMAN decision. Never called by a model, an agent,
   * or a handler — none of them hold a reference to this function (see
   * the file header). `actor_type` must be exactly 'human': the smallest
   * explicit actor representation this codebase's existing conventions
   * support (freezes' imposed_by, versions' approved_by — plain, required
   * strings, no identity system). This is NOT authentication — there is
   * no verification that the caller genuinely is who `actor` claims.
   * Authentication is an explicitly deferred future boundary; do not read
   * this function as providing it.
   *
   * Creates a NEW record rather than mutating the pending one — the
   * original PENDING request remains in the audit trail forever, exactly
   * as requested, regardless of what was later decided.
   */
  async function decide({ approval_id, task_id, decision, actor, actor_type = 'human', edited_payload } = {}) {
    const settle = (outcome, code, extra = {}) => {
      const record = { outcome, code, approval_id: approval_id ?? null, task_id: task_id ?? null, detail: extra.detail ?? null };
      writeAudit('approval.decided', record);
      return { ...record, ...extra };
    };

    if (actor_type !== 'human') {
      return settle('rejected', APPROVAL_REASON.APPROVAL_ACTOR_INVALID, { detail: `actor_type must be 'human'; got ${JSON.stringify(actor_type)}` });
    }
    if (!isNonEmptyString(actor)) {
      return settle('rejected', APPROVAL_REASON.APPROVAL_ACTOR_INVALID, { detail: 'a non-empty actor is required' });
    }
    if (!['approve', 'reject'].includes(decision)) {
      return settle('rejected', APPROVAL_REASON.MALFORMED_REQUEST, { detail: `decision must be 'approve' or 'reject'; got ${JSON.stringify(decision)}` });
    }
    if (typeof task_id !== 'string' || task_id === '') {
      return settle('rejected', APPROVAL_REASON.MALFORMED_REQUEST, { detail: 'task_id required' });
    }

    const candidates = await store.approvalsForTask(task_id);
    const pending = candidates.find((a) => a.approval_id === approval_id);
    if (!pending) return settle('rejected', APPROVAL_REASON.APPROVAL_NOT_FOUND);
    // The PENDING record's own `status` field is never mutated (records
    // are append-only — see the file header); whether it has ALREADY been
    // decided is determined by whether any later record references it,
    // not by re-reading a field that would still say 'pending' forever.
    const alreadyDecided = pending.status !== APPROVAL_STATUS.PENDING
      || candidates.some((a) => a.approval_reference === pending.approval_id);
    if (alreadyDecided) {
      // A decision is a one-time event: an already-decided request cannot
      // be decided again. This is what keeps "duplicate approval
      // references" unambiguous — prevented at the source, not resolved
      // by picking one of several conflicting records later.
      const supersededBy = candidates.find((a) => a.approval_reference === pending.approval_id);
      return settle('rejected', APPROVAL_REASON.APPROVAL_NOT_PENDING, { detail: `already ${supersededBy?.status ?? pending.status}` });
    }

    const now = clock();
    const effectivePayload = decision === 'approve' ? (edited_payload ?? pending.payload) : null;
    const approved_payload = decision === 'approve' ? effectivePayload : null;
    const decided = Object.freeze({
      approval_id: generateApprovalId(),
      task_id: pending.task_id,
      agent_id: pending.agent_id,
      version_id: pending.version_id,
      registry_sha: pending.registry_sha,
      tool_id: pending.tool_id,
      action_type: pending.action_type,
      payload: pending.payload,
      payload_hash: pending.payload_hash,
      // Re-rendered from what will actually be checked at execution
      // time — an edited approval's description must match the edit,
      // exactly the M4.6 "human edit executes when its hash matches the
      // edit" principle, now applied at the moment of decision too.
      rendered_description: decision === 'approve' ? renderPayload(pending.tool_id, pending.action_type, effectivePayload) : pending.rendered_description,
      status: decision === 'approve' ? APPROVAL_STATUS.APPROVED : APPROVAL_STATUS.REJECTED,
      reason: pending.reason,
      requested_by: pending.requested_by,
      requested_at: pending.requested_at,
      expires_at: pending.expires_at,
      decided_by: actor,
      decided_at: now,
      approved_payload,
      approved_payload_hash: decision === 'approve' ? hashPayload(approved_payload) : null,
      approval_reference: pending.approval_id,
    });
    await store.addApproval(decided);
    writeAudit('approval.decided', {
      outcome: 'decided', code: APPROVAL_REASON.OK, approval_id: decided.approval_id,
      approval_reference: pending.approval_id, status: decided.status, actor,
      agent_id: pending.agent_id, version_id: pending.version_id, task_id: pending.task_id,
    });
    return { outcome: 'decided', code: APPROVAL_REASON.OK, approval: decided };
  }

  /**
   * Withdraws a previously-granted approval — a NEW 'revoked' record
   * referencing the approved one, never a mutation of it. broker.js's
   * `resolvePerItemApproval` (M18) looks for exactly this shape and
   * treats the original as no longer usable the instant this exists —
   * see that file and DECISIONS.md D35 for why revocation could not be
   * made fail-closed without that small, additive Broker change.
   */
  async function revoke({ approval_id, task_id, actor, actor_type = 'human', reason } = {}) {
    const settle = (outcome, code, extra = {}) => {
      const record = { outcome, code, approval_id: approval_id ?? null, task_id: task_id ?? null, detail: extra.detail ?? null };
      writeAudit('approval.revoked', record);
      return { ...record, ...extra };
    };

    if (actor_type !== 'human') {
      return settle('rejected', APPROVAL_REASON.APPROVAL_ACTOR_INVALID, { detail: `actor_type must be 'human'; got ${JSON.stringify(actor_type)}` });
    }
    if (!isNonEmptyString(actor)) {
      return settle('rejected', APPROVAL_REASON.APPROVAL_ACTOR_INVALID, { detail: 'a non-empty actor is required' });
    }
    if (typeof task_id !== 'string' || task_id === '') {
      return settle('rejected', APPROVAL_REASON.MALFORMED_REQUEST, { detail: 'task_id required' });
    }

    const revocationCandidates = await store.approvalsForTask(task_id);
    const target = revocationCandidates.find((a) => a.approval_id === approval_id);
    if (!target) return settle('rejected', APPROVAL_REASON.APPROVAL_NOT_FOUND);
    // Same reasoning as decide(): `target.status` never changes once set,
    // so an already-revoked approval still reads 'approved' on its own
    // record — check for a superseding record instead of trusting it.
    const alreadyRevoked = revocationCandidates.some((a) => a.status === APPROVAL_STATUS.REVOKED && a.approval_reference === target.approval_id);
    if (target.status !== APPROVAL_STATUS.APPROVED || alreadyRevoked) {
      const detail = alreadyRevoked ? 'already revoked' : `cannot revoke a ${target.status} approval`;
      return settle('rejected', APPROVAL_REASON.APPROVAL_NOT_APPROVED, { detail });
    }

    const revocation = Object.freeze({
      approval_id: generateApprovalId(),
      task_id: target.task_id,
      agent_id: target.agent_id,
      version_id: target.version_id,
      registry_sha: target.registry_sha,
      tool_id: target.tool_id,
      action_type: target.action_type,
      payload: target.payload,
      payload_hash: target.payload_hash,
      rendered_description: target.rendered_description,
      status: APPROVAL_STATUS.REVOKED,
      reason: reason ?? null,
      requested_by: target.requested_by,
      requested_at: target.requested_at,
      expires_at: target.expires_at,
      decided_by: actor,
      decided_at: clock(),
      approved_payload: null,
      approved_payload_hash: null,
      approval_reference: target.approval_id,
    });
    await store.addApproval(revocation);
    writeAudit('approval.revoked', {
      outcome: 'revoked', code: APPROVAL_REASON.OK, approval_id: revocation.approval_id,
      approval_reference: target.approval_id, actor, agent_id: target.agent_id,
      version_id: target.version_id, task_id: target.task_id, reason: reason ?? null,
    });
    return { outcome: 'revoked', code: APPROVAL_REASON.OK, approval: revocation };
  }

  return { decidePolicy, requestApproval, decide, revoke };
}

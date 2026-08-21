/**
 * AGENTS AND AGENT VERSIONS
 *
 * Two records, deliberately separate:
 *
 *   agents          mutable runtime state. One row per agent, forever.
 *   agent_versions  IMMUTABLE configuration. One row per version.
 *
 * Mixing them is the mistake this file exists to prevent. If lifecycle state
 * lived on the version, pausing an agent would create a new version and
 * version history would fill with operational noise.
 *
 * `approved` is a property of a version. `active` is a pointer on the agent.
 * They are different facts and neither implies the other.
 *
 * THE RESOLVER is the reason broker.js needed almost no changes: it flattens
 * an agent plus its active version into exactly the shape the Broker already
 * expected, so the enforcement boundary never learns that versions exist.
 *
 * Constitution: sections 6, 7, 25.
 */

/** Version lifecycle. Only a human moves a version to `approved`. */
export const VERSION_STATE = Object.freeze({
  DRAFT: 'draft',
  HUMAN_REVIEW: 'human_review',
  APPROVED: 'approved',
  SUPERSEDED: 'superseded',
});

/** Runtime lifecycle. Never versioned. */
export const RUNTIME_STATE = Object.freeze({
  ACTIVE: 'active',
  PAUSED: 'paused',
  DEGRADED: 'degraded',
  FROZEN: 'frozen',
  RETIRED: 'retired',
});

/** Deterministic, readable version identity. No uuid needed. */
export function versionId(agentId, version) {
  return `${agentId}@${version}`;
}

/**
 * @param {object} o
 * @param {number} [o.concurrency_limit] how many tasks this agent may have
 *   in flight at once, per the M9 router's own reservation accounting (see
 *   router.js). NOT security-authoritative — the Broker does not consult
 *   it, and a value here can never grant a tool call. Optional: absent
 *   means "use the router's default ceiling." Deliberately kept off the
 *   immutable version and off validator.js's POLICY-checked `limits`,
 *   because concurrency is an operational scheduling concern, not a
 *   security one — see DECISIONS.md D26.
 * @returns {object} a frozen agent runtime record
 */
export function makeAgent({
  id, slug, name, lifecycle_state = RUNTIME_STATE.ACTIVE, active_version_id = null,
  concurrency_limit = null, now = 0,
}) {
  return Object.freeze({
    id, slug, name,
    lifecycle_state,
    active_version_id,
    concurrency_limit,
    created_at: now,
    updated_at: now,
  });
}

/**
 * @returns {object} a frozen, immutable version record
 */
export function makeAgentVersion(v) {
  return Object.freeze({
    version_id: versionId(v.agent_id, v.version),
    agent_id: v.agent_id,
    version: v.version,
    purpose: v.purpose,
    department: v.department,
    state: v.state ?? VERSION_STATE.DRAFT,
    // ── security-authoritative ──
    clearance: v.clearance,
    allowed_tools: Object.freeze([...(v.allowed_tools ?? [])]),
    limits: Object.freeze({ ...(v.limits ?? {}) }),
    scopes: v.scopes ? Object.freeze({ ...v.scopes }) : null,
    // ── advisory / descriptive ──
    capabilities: Object.freeze([...(v.capabilities ?? [])]),
    // Which workflow "types" this agent is meant to be routed into — router
    // metadata only (M9), exactly as advisory as capabilities above: the
    // Broker never reads it and it grants nothing. Empty means "no stated
    // restriction," not "supports nothing" — an unrestricted, general
    // agent is a legitimate declaration, not a fail-closed omission,
    // because nothing here is a security decision. See DECISIONS.md D26.
    allowed_workflow_types: Object.freeze([...(v.allowed_workflow_types ?? [])]),
    input_contract: Object.freeze({ ...(v.input_contract ?? {}) }),
    output_contract: Object.freeze({ ...(v.output_contract ?? {}) }),
    quality_criteria: v.quality_criteria ?? null,
    model_config: Object.freeze({ ...(v.model_config ?? {}) }),
    metadata: Object.freeze({ ...(v.metadata ?? {}) }),
    // ── provenance ──
    created_at: v.created_at ?? 0,
    approved_by: v.approved_by ?? null,
    approved_at: v.approved_at ?? null,
  });
}

/**
 * Flattens an agent + its active version into the shape broker.js consumes.
 *
 * The Broker reads: slug, state, clearance, allowed_tools, scopes.
 * It additionally reads version_state, for the one check added in this
 * milestone. Everything else here is for audit and for the runtime.
 *
 * A missing or unresolvable version yields an object with no clearance and
 * `version_state: null`, which the Broker's own validator rejects as
 * INVALID_AGENT. Fail closed: an agent with no resolvable version is not a
 * usable agent.
 *
 * @param {object|null} agent
 * @param {object|null} version
 * @returns {object|null}
 */
export function resolveAgent(agent, version) {
  if (!agent || typeof agent !== 'object') return null;

  const base = {
    slug: agent.slug,
    agent_id: agent.id,
    state: agent.lifecycle_state,
    version_id: agent.active_version_id ?? null,
    version_state: null,
    // advisory, M9 — the router reads this; the Broker never does
    concurrency_limit: agent.concurrency_limit ?? null,
  };

  if (!version) return base;

  return {
    ...base,
    version_id: version.version_id,
    version_state: version.state,
    department: version.department,
    // security-authoritative, read by the Broker
    clearance: version.clearance,
    allowed_tools: version.allowed_tools,
    scopes: version.scopes ?? undefined,
    // advisory — the Broker ignores these, and must continue to
    capabilities: version.capabilities,
    allowed_workflow_types: version.allowed_workflow_types,
    limits: version.limits,
    input_contract: version.input_contract,
    output_contract: version.output_contract,
  };
}

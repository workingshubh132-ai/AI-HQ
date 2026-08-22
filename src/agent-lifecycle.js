/**
 * AGENT LIFECYCLE (Milestone 17)
 *
 * The validated, audited path for changing an agent's RUNTIME lifecycle
 * state — the missing piece between "RUNTIME_STATE is a defined set of
 * strings" (agents.js, since M5) and "the store's own lifecycle-state
 * setter accepts any string with zero validation" (store.js, since M6). Before
 * this file, nothing in src/ validated that a transition was even
 * sensible: `setLifecycleState('demo', 'retired')` followed immediately by
 * `setLifecycleState('demo', 'active')` was, and remains, mechanically
 * possible at the storage layer. This file is the caller that says no.
 *
 * ── VERSION APPROVAL AND AGENT LIFECYCLE ARE DIFFERENT CONTROLS ─────────
 *
 * This file NEVER reads or writes an agent_version record. It has no
 * reference to addAgentVersion, setActiveVersion, or anything that could
 * approve, supersede, or otherwise touch the immutable version an agent
 * currently points at. Transitioning `lifecycle_state` changes nothing
 * about `version_state` — an agent moved to ACTIVE with an unapproved
 * version is still denied by the Broker's own, separate,
 * VERSION_NOT_APPROVED check (broker.js, unchanged), exactly as it always
 * was. Test 9 in the M17 test suite proves this composition directly.
 *
 * ── THIS IS NOT A NEW AUTHORIZATION PATH ─────────────────────────────────
 *
 * Setting lifecycle_state to ACTIVE is not, and can never become,
 * permission to execute. Every existing gate — approved version,
 * clearance, allowed_tools, scopes, router eligibility, budget, workflow
 * state, Guardian/freeze state, Broker authorization — still runs,
 * unchanged, the moment a task is actually attempted. This file holds no
 * reference to the Broker, cannot call a tool, cannot invoke a handler,
 * and cannot touch `store.addFreeze`/`store.activeFreeze` — a Guardian
 * freeze is a completely separate mechanism (the `freezes` table, checked
 * independently by the Broker, runtime.js, and router.js) that no
 * lifecycle transition, however it is invoked, can see or clear. See
 * DECISIONS.md D34.
 *
 * ── WHO MAY CALL THIS, HONESTLY ──────────────────────────────────────────
 *
 * There is no actor-identity system in this codebase to plug into — the
 * established pattern (freezes' `imposed_by`, approvals' `decided_by`,
 * versions' `approved_by`) is a plain, required string naming who or what
 * acted, nothing more. `transition()` follows that pattern: `actor` is a
 * required string, not a default, not an inferred identity. A handler
 * cannot call this file at all — runtime.js invokes a handler with
 * exactly `{input, callTool, callModel, DECISION}` (test 306, M14) and
 * never a reference to this module, so "an agent activates itself" or "a
 * model output disables another agent" is not a check this file performs;
 * it is a structural impossibility, the same way a handler cannot reach
 * the router or the execution coordinator.
 *
 * ── PORTABLE ACROSS STORAGE IMPLEMENTATIONS BY CONSTRUCTION ─────────────
 *
 * Only two storage calls are ever made: the formal-contract `getAgent()`
 * (to read the CURRENT lifecycle state as `.state`, exactly what the
 * Broker itself reads) and `setLifecycleState()` (already implemented,
 * identically, by both store.js and postgres-store.js since M9/M11).
 * Deliberately not `getAgentRecord()` — router.js's own setAgentHealth()
 * uses that introspection-only method, which postgres-store.js does not
 * implement; this file avoids that gap rather than inheriting it.
 *
 * `transition()` and `getLifecycleState()` are `async` and `await` both
 * calls — unlike the live synchronous core (broker.js, runtime.js,
 * workflow.js, router.js, guardian.js), this module is not on any
 * existing hot path nothing else calls unawaited, so there is no D28-
 * style sync/async boundary to preserve here. `await` on the in-memory
 * store's plain synchronous return values is a harmless no-op (resolves
 * on the next microtask tick, the same reasoning storage-contract.test.js
 * already documents); against the real Postgres adapter it is required
 * for correctness — an un-awaited `store.getAgent(...)` there returns a
 * pending Promise, which is always truthy, silently defeating the
 * UNKNOWN_AGENT check. Making this module async is what makes it
 * genuinely portable to both stores, not just to the one this codebase's
 * live path happens to use today.
 *
 * Constitution: sections 6, 7, 12, 25.
 */

import { RUNTIME_STATE } from './agents.js';

export const LIFECYCLE_REASON = Object.freeze({
  OK: 'OK',
  UNKNOWN_AGENT: 'UNKNOWN_AGENT',
  INVALID_STATE: 'INVALID_STATE',
  ACTOR_REQUIRED: 'ACTOR_REQUIRED',
  REASON_REQUIRED: 'REASON_REQUIRED',
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
});

/**
 * The permitted transition graph. Every key is a FROM state; its value is
 * the set of TO states reachable in one governed transition() call.
 *
 *   ACTIVE    -> PAUSED, DEGRADED, DISABLED, RETIRED
 *   PAUSED    -> ACTIVE, DISABLED, RETIRED
 *   DEGRADED  -> ACTIVE, PAUSED, DISABLED, RETIRED
 *   DISABLED  -> ACTIVE, RETIRED
 *   RETIRED   -> (nothing — terminal, by design)
 *   FROZEN    -> (nothing — see note below)
 *
 * RETIRED has no outgoing edges: once retired, an agent cannot become
 * active again "through a normal transition" (the M17 directive's own
 * wording) — a genuinely new agent record, or a deliberate, separate,
 * out-of-band administrative action outside this file's scope, would be
 * required, not a bug this file needs to route around.
 *
 * FROZEN (a RUNTIME_STATE value since M5) is likewise given no outgoing
 * edges here, on purpose: no code path in this codebase has ever set
 * lifecycle_state to 'frozen' — the operative freeze mechanism, used by
 * every existing Broker/runtime.js/router.js check and by Guardian, is
 * the separate `freezes` table (`store.addFreeze`/`store.activeFreeze`),
 * not this field. Leaving FROZEN a dead end here, rather than guessing at
 * transition rules for a state nothing produces, is the fail-closed
 * choice — see DECISIONS.md D34.
 */
const TRANSITIONS = Object.freeze({
  [RUNTIME_STATE.ACTIVE]: new Set([RUNTIME_STATE.PAUSED, RUNTIME_STATE.DEGRADED, RUNTIME_STATE.DISABLED, RUNTIME_STATE.RETIRED]),
  [RUNTIME_STATE.PAUSED]: new Set([RUNTIME_STATE.ACTIVE, RUNTIME_STATE.DISABLED, RUNTIME_STATE.RETIRED]),
  [RUNTIME_STATE.DEGRADED]: new Set([RUNTIME_STATE.ACTIVE, RUNTIME_STATE.PAUSED, RUNTIME_STATE.DISABLED, RUNTIME_STATE.RETIRED]),
  [RUNTIME_STATE.DISABLED]: new Set([RUNTIME_STATE.ACTIVE, RUNTIME_STATE.RETIRED]),
  [RUNTIME_STATE.RETIRED]: new Set(),
  [RUNTIME_STATE.FROZEN]: new Set(),
});

/**
 * @param {object} deps
 * @param {object} deps.store  any store satisfying storage.js's STORAGE_CONTRACT
 * @param {object} deps.audit
 * @param {() => number} deps.clock
 * @param {string|null} [deps.registrySha]  identity of the code that ran,
 *   recorded on every transition audit record — the same field runtime.js
 *   records on every task, for the same reason.
 */
export function createAgentLifecycle({ store, audit, clock, registrySha = null }) {
  function writeAudit(fields) {
    audit.write({ event: 'agent.lifecycle_transition', at: clock(), registry_sha: registrySha, ...fields });
  }

  /**
   * @param {{agent_slug:string, to_state:string, reason:string, actor:string}} request
   *   `reason` is the human-supplied justification for this transition
   *   (e.g. "found a bug in v2, pausing until fixed") — required, never
   *   defaulted, matching this project's existing `imposed_by`/
   *   `decided_by`/`approved_by` convention of a plain, mandatory string.
   *   `actor` names who or what is acting, same convention, also required.
   * @returns {object} a settled decision record — also what gets audited
   */
  async function transition({ agent_slug, to_state, reason, actor } = {}) {
    const settle = (outcome, code, extra = {}) => {
      const record = {
        agent_slug: agent_slug ?? null,
        agent_id: extra.agent_id ?? null,
        version_id: extra.version_id ?? null,
        previous_state: extra.previous_state ?? null,
        new_state: to_state ?? null,
        reason: reason ?? null,
        actor: actor ?? null,
        outcome,
        code,
        detail: extra.detail ?? null,
      };
      writeAudit(record);
      return record;
    };

    if (typeof agent_slug !== 'string' || agent_slug === '') {
      return settle('rejected', LIFECYCLE_REASON.UNKNOWN_AGENT, { detail: 'agent_slug required' });
    }
    if (typeof actor !== 'string' || actor.trim() === '') {
      return settle('rejected', LIFECYCLE_REASON.ACTOR_REQUIRED);
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      return settle('rejected', LIFECYCLE_REASON.REASON_REQUIRED);
    }
    if (!Object.values(RUNTIME_STATE).includes(to_state)) {
      return settle('rejected', LIFECYCLE_REASON.INVALID_STATE, { detail: `unrecognised state: ${JSON.stringify(to_state)}` });
    }

    const agent = await store.getAgent(agent_slug);
    if (!agent) return settle('rejected', LIFECYCLE_REASON.UNKNOWN_AGENT);

    const previous_state = agent.state;
    const known = { agent_id: agent.agent_id ?? null, version_id: agent.version_id ?? null, previous_state };

    // Fail closed on ANY from-state this graph does not explicitly
    // recognise (including a corrupted/pre-migration value that is not a
    // current RUNTIME_STATE member at all) — an empty set denies every
    // target, by construction, not by a special-cased check.
    const allowed = TRANSITIONS[previous_state] ?? new Set();
    if (!allowed.has(to_state)) {
      return settle('rejected', LIFECYCLE_REASON.ILLEGAL_TRANSITION, {
        ...known, detail: `${previous_state} -> ${to_state} is not a permitted transition`,
      });
    }

    await store.setLifecycleState(agent_slug, to_state);
    return settle('accepted', LIFECYCLE_REASON.OK, known);
  }

  /** Read-only. Returns null for an unknown agent. */
  async function getLifecycleState(agent_slug) {
    const agent = await store.getAgent(agent_slug);
    return agent ? agent.state : null;
  }

  return { transition, getLifecycleState };
}

/** Exposed for tests that need to assert on the graph shape itself,
 * without duplicating it — never mutated at runtime (frozen at every level). */
export const AGENT_LIFECYCLE_TRANSITIONS = TRANSITIONS;

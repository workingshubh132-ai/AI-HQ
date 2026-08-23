/**
 * LIVE PROVIDER GUARDIAN GATE (Milestone 26)
 *
 * Refuses a real, paid provider invocation when a Guardian freeze, an
 * agent lifecycle state, or an unapproved version says it must not
 * happen — BEFORE the resource governor reserves anything and therefore
 * before a single byte reaches the network.
 *
 * ── WHY THIS FILE HAD TO EXIST ───────────────────────────────────────────
 *
 * A real finding from M26's Phase 5 verification, not a hypothetical.
 * Deterministic providers are only ever reachable through
 * `runtime.js`, whose pre-flight has checked agent/workflow/global
 * freezes since M4/M8 — so for them, "a freeze stops the call" was
 * already true, for free.
 *
 * The LIVE provider is different: it is invoked directly through
 * `resource-governor.js` → `invoke-async.js` → `groq.js`, a path that
 * never passes through `runtime.js` at all. Grepping the whole live
 * chain for `activeFreeze` returns ZERO occurrences — the governor does
 * not even receive a store. A Guardian freeze therefore could not stop a
 * paid Groq call, which is precisely the guarantee M26 requires.
 *
 * ── WHY IT IS A NEW FILE RATHER THAN AN EDIT ─────────────────────────────
 *
 * `resource-governor.js` and `guardian.js` are both authoritative,
 * protected boundaries. Adding a freeze check inside the governor would
 * have given a budget component a second, unrelated job and changed a
 * file M26 explicitly protects. Composing a thin gate IN FRONT of it
 * instead adds the missing check without modifying either — the same
 * "compose, don't modify" discipline `execution-coordinator.js` (M14)
 * used to add routing and Guardian evaluation around an unmodified
 * workflow engine.
 *
 * ── THIS FILE HOLDS NO AUTHORITY ─────────────────────────────────────────
 *
 * It receives a READ-ONLY view of the store (built here, so no mutation
 * method is reachable from its logic) and can only ever ANSWER "no." It
 * cannot impose a freeze, lift one, change a lifecycle state, approve
 * anything, alter a budget, or reach the Broker. It never reads a
 * credential and never touches the network — it decides whether to call
 * the governor at all, and nothing more.
 *
 * Constitution: sections 13, 18, 20, 22, 23.
 */

export const LIVE_GATE_REASON = Object.freeze({
  OK: 'OK',
  INVALID_REQUEST: 'INVALID_REQUEST',
  GLOBAL_FREEZE: 'GLOBAL_FREEZE',
  WORKFLOW_FROZEN: 'WORKFLOW_FROZEN',
  AGENT_FROZEN: 'AGENT_FROZEN',
  UNKNOWN_AGENT: 'UNKNOWN_AGENT',
  INVALID_AGENT: 'INVALID_AGENT',
  VERSION_NOT_APPROVED: 'VERSION_NOT_APPROVED',
  AGENT_NOT_ACTIVE: 'AGENT_NOT_ACTIVE',
});

/** Reasons that mean "a real call must not be attempted." Exported so a
 * caller classifies with the same set this file defines rather than
 * re-listing codes and drifting. */
export const LIVE_GATE_DENIALS = Object.freeze(new Set(
  Object.values(LIVE_GATE_REASON).filter((r) => r !== LIVE_GATE_REASON.OK),
));

/** A read-only view over the real store — the CEO orchestrator's own
 * pattern (M24). The gate's logic holds only this, so no mutation
 * method is reachable from any decision it makes. */
function readOnlyStore(store) {
  return Object.freeze({
    getAgent: (slug) => store.getAgent(slug),
    activeFreeze: (scope, targetId, now) => store.activeFreeze(scope, targetId, now),
  });
}

/**
 * @param {object} deps
 * @param {object} deps.store  the real store (wrapped read-only here)
 * @param {{invoke: Function}} deps.governor  an EXISTING, unmodified
 *   `createResourceGovernor()` instance. This gate decides whether to
 *   call it; it never reimplements any part of it.
 * @param {object} deps.audit
 * @param {() => number} deps.clock
 */
export function createLiveProviderGate({ store, governor, audit, clock }) {
  const reads = readOnlyStore(store);

  /**
   * The freeze/lifecycle pre-flight, mirroring the checks
   * `runtime.js` already performs before agent execution — applied here
   * to the direct live-invocation path that never reaches runtime.js.
   *
   * Exported behavior: returns `{ok:true}` or `{ok:false, reason, detail}`.
   * Never throws, never mutates.
   */
  function check({ agent_slug, tree_id }) {
    const now = clock();

    // Cheapest, most global check first — the same ordering broker.js,
    // runtime.js, and router.js already use.
    if (reads.activeFreeze('global', null, now)) {
      return { ok: false, reason: LIVE_GATE_REASON.GLOBAL_FREEZE };
    }
    if (tree_id && reads.activeFreeze('workflow', tree_id, now)) {
      return { ok: false, reason: LIVE_GATE_REASON.WORKFLOW_FROZEN };
    }

    // An agent-scoped call must name a real, healthy agent. A call with
    // no agent_slug is a system-level invocation (the smoke script's own
    // case is agent-scoped, but a future caller may not be) — global and
    // workflow freezes above still bind it.
    if (agent_slug === undefined || agent_slug === null) return { ok: true, reason: LIVE_GATE_REASON.OK };
    if (typeof agent_slug !== 'string' || agent_slug === '') {
      return { ok: false, reason: LIVE_GATE_REASON.INVALID_REQUEST, detail: 'agent_slug must be a non-empty string when present' };
    }

    if (reads.activeFreeze('agent', agent_slug, now)) {
      return { ok: false, reason: LIVE_GATE_REASON.AGENT_FROZEN };
    }

    const agent = reads.getAgent(agent_slug);
    if (!agent) return { ok: false, reason: LIVE_GATE_REASON.UNKNOWN_AGENT };
    if (typeof agent.clearance !== 'string' || !Array.isArray(agent.allowed_tools)) {
      return { ok: false, reason: LIVE_GATE_REASON.INVALID_AGENT, detail: 'agent has no resolvable active version' };
    }
    if (agent.version_state !== 'approved') {
      return { ok: false, reason: LIVE_GATE_REASON.VERSION_NOT_APPROVED, detail: `active version is ${agent.version_state ?? 'unresolved'}` };
    }
    if (agent.state !== 'active') {
      return { ok: false, reason: LIVE_GATE_REASON.AGENT_NOT_ACTIVE, detail: `state is ${agent.state}` };
    }

    return { ok: true, reason: LIVE_GATE_REASON.OK };
  }

  /**
   * Gate, then delegate. On denial the governor is NEVER called, so no
   * reservation is made and no request is ever built — the denial costs
   * nothing and reaches no network.
   */
  async function invoke(request) {
    const verdict = check({ agent_slug: request?.agent_slug, tree_id: request?.tree_id });

    if (!verdict.ok) {
      const record = {
        event: 'provider.live_gate',
        at: clock(),
        agent_slug: request?.agent_slug ?? null,
        task_id: request?.task_id ?? null,
        tree_id: request?.tree_id ?? null,
        provider_id: request?.provider_id ?? null,
        model_id: request?.model_id ?? null,
        status: 'failed',
        reason: verdict.reason,
        detail: verdict.detail ?? null,
        output: null,
        network_attempted: false,
      };
      audit.write(record);
      return record;
    }

    return governor.invoke(request);
  }

  return Object.freeze({ invoke, check });
}

/**
 * ── WHY THIS COMPOSER EXISTS: A REAL BUG M26 FOUND ───────────────────────
 *
 * `resource-governor.js` builds its OWN success envelope
 * (`{output, usage, usage_status, estimated_cost, actual_cost,
 * attempts}`) and does not pass through the inner provider result's
 * `provider_type`, `provider_version`, `provider_usage`, `cost`, or
 * `cost_status`.
 *
 * For deterministic providers that never mattered — nothing downstream
 * of the governor built an artifact. For the LIVE provider it matters a
 * great deal: `artifact-bridge.js` requires `provider_type` and refuses
 * outright without it, so a governed live call could not become an
 * artifact at all, and the provider-reported token usage and the honest
 * `UNPRICED_REAL_SPEND` status were both silently lost. M25 did not
 * catch this because its artifact test invoked the provider DIRECTLY,
 * bypassing the governor; the moment a real caller went through the
 * governor — as the M26 smoke script does — artifact creation failed.
 *
 * `resource-governor.js` is a protected, authoritative boundary, so it
 * was not modified. Instead this composer wraps the invoker it hands to
 * the governor, captures that call's inner result on a PER-CALL carrier
 * object (never shared mutable state, so concurrent calls cannot race),
 * and merges the missing provenance back onto the governor's envelope
 * afterwards. Reservation, settlement, and every ceiling remain entirely
 * the governor's own, unchanged.
 *
 * @param {object} deps
 * @param {object} deps.store
 * @param {{invoke:Function}} deps.invoker  a `createAsyncProviderInvoker()` instance
 * @param {Function} deps.createGovernor  `createResourceGovernor`, injected so
 *   this file never imports the governor module itself
 * @param {object} deps.registry
 * @param {object} deps.audit
 * @param {() => number} deps.clock
 * @returns {{invoke:Function, check:Function, governor:object}}
 */
export function createLiveProviderChain({ store, invoker, createGovernor, registry, audit, clock }) {
  const CARRIER_KEY = '__inner_provider_result';

  const capturing = {
    async invokeModel(request) {
      const inner = await invoker.invoke(request);
      // The governor passes the SAME request object through by
      // reference, so attaching here makes the inner result readable by
      // the one caller that owns this request — and by no one else.
      if (request && typeof request === 'object') request[CARRIER_KEY] = inner;
      return inner;
    },
  };

  const governor = createGovernor({ modelRuntime: capturing, registry, audit, clock });
  const gate = createLiveProviderGate({ store, governor, audit, clock });

  async function invoke(request) {
    const verdict = gate.check({ agent_slug: request?.agent_slug, tree_id: request?.tree_id });
    if (!verdict.ok) return gate.invoke(request); // audited denial, no governor call

    // A per-call copy: the caller's own object is never mutated, and no
    // two concurrent calls can observe each other's inner result.
    const carrier = { ...request };
    const result = await governor.invoke(carrier);
    if (result.status !== 'ok') return result;

    const inner = carrier[CARRIER_KEY] ?? null;
    return {
      ...result,
      provider_id: request.provider_id ?? result.provider_id ?? null,
      model_id: request.model_id ?? result.model_id ?? null,
      provider_type: inner?.provider_type ?? null,
      provider_version: inner?.provider_version ?? null,
      provider_usage: inner?.provider_usage ?? null,
      // The provider's own honest cost reporting, preserved rather than
      // replaced by the governor's reservation arithmetic.
      cost: inner?.cost ?? null,
      cost_status: inner?.cost_status ?? null,
    };
  }

  return Object.freeze({ invoke, check: gate.check, governor });
}

/**
 * CONTENT FACTORY — CONTROLLED SINGLE-STAGE LIVE PROVIDER BOUNDARY (M28)
 *
 * Connects EXACTLY ONE Content Factory stage to the governed Groq
 * boundary built in M25–M27, and nothing else. Every other specialist
 * stays deterministic, byte-for-byte as before.
 *
 * ── THE PROBLEM THIS FILE EXISTS TO SOLVE ────────────────────────────────
 *
 * Two facts about the existing system collide.
 *
 * FIRST: `runtime.js`'s `generateContent` takes `provider_id` and
 * `model_id` STRAIGHT FROM THE HANDLER'S REQUEST. Read it — the request
 * fields are passed through to `providerInvoker.invoke()` verbatim. The
 * only thing stopping any handler from writing `provider_id: 'groq'`
 * today is that the registry handed to the runtime does not contain
 * Groq. Provider selection is controlled by WHICH REGISTRY IS INJECTED,
 * not by any per-agent rule. Hand the Content Factory a registry
 * containing Groq and every one of its twelve specialists — plus the
 * adversarial rogue fixture — could spend money.
 *
 * SECOND: the live provider is asynchronous (it ends in `fetch`) and
 * `runtime.js` is synchronous, deliberately, since D28. A live stage
 * therefore CANNOT make its network call inside a handler at all.
 *
 * ── WHY NOT AN ASYNC RUNTIME TWIN ────────────────────────────────────────
 *
 * The established pattern for the sync/async boundary is a twin file
 * (`model-runtime` → `async-model-runtime`, `invoke` → `invoke-async`).
 * A twin of `runtime.js` would be different in kind: it would duplicate
 * the entire pre-flight — freeze checks, lifecycle, version resolution,
 * Broker calls, task-record construction — and every one of those is a
 * security boundary that would then exist in two places and be free to
 * drift apart. That is a worse outcome than the problem it solves, and
 * far more than "the smallest secure implementation."
 *
 * ── THE DESIGN: GOVERN, THEN HAND OFF A SEALED TICKET ────────────────────
 *
 * The network call is moved OUT of the synchronous handler and in front
 * of it, where async is allowed and where all the governance already
 * lives:
 *
 *   PHASE 1 (async, before the task runs)
 *     capability admission  → is this agent the configured live stage?
 *     live-guard (M26)      → global/workflow/agent freeze, lifecycle,
 *                             version approved
 *     resource governor     → call-count ceiling, budget reservation at
 *                             global → agent → workflow → task
 *     invoke-async          → timeout, retry clamp (0 here)
 *     groq adapter          → the one and only network egress
 *   ─────────────────────────────────────────────────────────────────────
 *   PHASE 2 (sync, inside the unmodified runtime.js)
 *     the handler calls generateContent() exactly as every other stage
 *     does; a facade returns the already-governed result, and runtime.js
 *     builds the artifact through its own artifact-bridge and
 *     artifact-service path — so PROVENANCE IS DERIVED BY TRUSTED CODE
 *     THIS FILE NEVER TOUCHES.
 *
 * The ticket handed across is sealed in two ways. It is bound to the
 * admitted agent, and it carries a fingerprint of the exact request
 * governance approved. A handler that asks for anything else — a
 * different prompt, a different model, a different provider — gets a
 * refusal, not content. And it is SINGLE-USE: a second generateContent
 * call within one task cannot produce a second paid result, because
 * there is no second result to hand out. "At most one provider call per
 * task" is therefore structural, not a limit someone has to remember to
 * check.
 *
 * ── THIS FILE GRANTS NOTHING ─────────────────────────────────────────────
 *
 * It cannot enable Groq (the M25 configuration gates decide that), read
 * a credential, register a provider, mutate a registry, change a budget,
 * lift a freeze, approve anything, or reach the Broker. It can only ever
 * narrow: decide that ONE agent may reach a provider boundary that is
 * already independently gated, and refuse everyone else.
 *
 * Constitution: sections 13, 18, 20, 22, 23.
 */

import { PROVIDER_REASON } from './providers/contracts.js';

/**
 * The sentinel a live-capable handler names instead of a real provider.
 *
 * It is deliberately NOT a registered provider id. A handler cannot
 * write `provider_id: 'groq'` and reach Groq — no registry the Content
 * Factory is given contains Groq, so that request fails
 * PROVIDER_NOT_FOUND. It names an INTENT ("the trusted live text
 * capability"), and what that intent resolves to — which provider, which
 * model — comes from operator configuration this side of the boundary,
 * never from the request.
 */
export const LIVE_TEXT_CAPABILITY_ID = 'cf-live-text';

/**
 * Refusals that belong to THIS boundary. Everything the existing layers
 * already express — freezes, lifecycle, budgets, call limits, provider
 * and model failures, configuration gates — is passed through with the
 * reason those layers produced, never re-coded here. See DECISIONS.md
 * D45 for why each of these four is genuinely new.
 */
export const LIVE_STAGE_REASON = Object.freeze({
  /** No live stage is configured at all — the ordinary, safe default. */
  LIVE_STAGE_NOT_CONFIGURED: 'LIVE_STAGE_NOT_CONFIGURED',
  /** The calling agent is not the configured live-capable stage. */
  LIVE_STAGE_NOT_ADMITTED: 'LIVE_STAGE_NOT_ADMITTED',
  /** The handler asked for content governance did not approve. */
  LIVE_REQUEST_MISMATCH: 'LIVE_REQUEST_MISMATCH',
  /** A second generateContent call inside one task. */
  LIVE_TICKET_ALREADY_USED: 'LIVE_TICKET_ALREADY_USED',
});

/**
 * Operator configuration for the single live-capable stage. Frozen, and
 * built from explicit arguments only — there is no default that could
 * quietly turn a stage live.
 *
 * The admission rule is CAPABILITY-based: the agent's approved active
 * version must declare `capability`. The slug binding is an ADDITIONAL
 * narrowing, not the rule itself — so that if a second agent is later
 * approved carrying the same capability it does not silently inherit the
 * ability to spend money.
 *
 * @param {object} cfg
 * @param {string} cfg.capability       e.g. CONTENT_FACTORY_CAPABILITY.SCRIPT
 * @param {string} cfg.agent_slug       the one agent bound to it
 * @param {string} cfg.provider_id      trusted; never read from a request
 * @param {string} cfg.model_id         trusted; exactly one
 * @param {string} cfg.artifact_type    the artifact this stage may produce
 */
export function createLiveStageConfig({ capability, agent_slug, provider_id, model_id, artifact_type }) {
  for (const [name, value] of Object.entries({ capability, agent_slug, provider_id, model_id, artifact_type })) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`createLiveStageConfig: ${name} must be a non-empty string — a live stage is never configured by default`);
    }
  }
  return Object.freeze({ capability, agent_slug, provider_id, model_id, artifact_type });
}

/**
 * Is this agent the configured live-capable stage?
 *
 * Reads the agent from the store — the RESOLVED record, whose
 * `capabilities` come from the immutable, approved version, not from
 * anything a caller supplied. Holding the capability is NECESSARY, never
 * SUFFICIENT: live-guard, the resource governor, and the provider's own
 * configuration gates all still run afterwards and can each refuse.
 *
 * Capabilities are advisory to the ROUTER, and this does not change
 * that. Routing advice decides who is asked to do work; this decides
 * whether an already-routed, already-approved agent may reach a boundary
 * that is independently gated four more times.
 *
 * @returns {{ok:true} | {ok:false, reason:string, detail:string}}
 */
export function checkLiveStageAdmission({ store, config, agent_slug }) {
  if (!config) {
    return {
      ok: false,
      reason: LIVE_STAGE_REASON.LIVE_STAGE_NOT_CONFIGURED,
      detail: 'no live-capable stage is configured — the Content Factory is fully deterministic',
    };
  }
  if (typeof agent_slug !== 'string' || agent_slug === '') {
    return { ok: false, reason: PROVIDER_REASON.INVALID_REQUEST, detail: 'agent_slug must be a non-empty string' };
  }
  if (agent_slug !== config.agent_slug) {
    return {
      ok: false,
      reason: LIVE_STAGE_REASON.LIVE_STAGE_NOT_ADMITTED,
      detail: `${agent_slug} is not the configured live-capable stage`,
    };
  }

  const agent = store.getAgent(agent_slug);
  if (!agent) {
    return { ok: false, reason: LIVE_STAGE_REASON.LIVE_STAGE_NOT_ADMITTED, detail: `unknown agent: ${agent_slug}` };
  }
  // The capability must come from a RESOLVED version. An agent with no
  // active version resolves without `capabilities` at all, and fails here.
  const declared = Array.isArray(agent.capabilities) ? agent.capabilities : [];
  if (!declared.includes(config.capability)) {
    return {
      ok: false,
      reason: LIVE_STAGE_REASON.LIVE_STAGE_NOT_ADMITTED,
      detail: `${agent_slug} does not declare the live-capable capability ${config.capability}`,
    };
  }
  return { ok: true };
}

/**
 * A stable fingerprint of the request governance actually approved.
 *
 * Covers the prompt and the live sentinel: the things a handler decides
 * that determine what was actually paid for. A handler that later asks
 * for a different prompt is asking for content nobody authorised, and
 * gets a refusal rather than someone else's paid result.
 *
 * TWO FIELDS ARE DELIBERATELY ABSENT, for different reasons.
 *
 * `model_id`, because the model is trusted configuration and a request
 * has no say in it. Comparing it against a request field would compare
 * config to noise: a handler would have to guess the configured model to
 * be believed, and an attacker supplying one would look no different
 * from a correct call. It is ignored outright instead — phase 1 already
 * called the configured model (test 830).
 *
 * `artifact_type`, because it never arrives. `runtime.js` forwards only
 * `provider_id`, `model_id`, `required_capability`, `input`, and
 * `max_retries` to the invoker — the artifact type stays behind in
 * runtime.js, which uses it to build the artifact itself. Fingerprinting
 * a field that is always `undefined` on this side would compare nothing
 * to nothing and quietly weaken the check. The artifact type is governed
 * where it actually lives: the stage config declares it, the handler
 * names it as a constant, and `artifact-bridge.js` refuses a type its
 * provider category cannot produce.
 */
export function fingerprintLiveRequest({ provider_id, input }) {
  return JSON.stringify({
    provider_id: provider_id ?? null,
    input: input ?? null,
  });
}

/**
 * PHASE 1 — run the whole governed chain and seal the result in a ticket.
 *
 * Async, and called BEFORE `runtime.runTask()`, so the network happens
 * outside the synchronous security core rather than inside it.
 *
 * `provider_id` and `model_id` are taken from TRUSTED CONFIG. The
 * caller's `input` decides only the prompt; nothing a handler, an agent,
 * a task payload, or a model output can say chooses a provider, a model,
 * a budget, or a credential.
 *
 * @param {object} args
 * @param {object} args.store
 * @param {{invoke:Function}} args.chain  a `createLiveProviderChain()` instance (M26)
 * @param {object} args.config           `createLiveStageConfig()` output
 * @param {string} args.agent_slug       TRUSTED execution context
 * @param {string} args.task_id          TRUSTED execution context
 * @param {string} args.workflow_id      TRUSTED execution context
 * @param {object} args.input            the prompt, and only the prompt
 * @returns {Promise<object>} a ticket, always — `admitted:false` when the
 *   boundary refused, and in that case NO network call was made.
 */
export async function resolveLiveStageContent({ store, chain, config, agent_slug, task_id, workflow_id, input }) {
  const admission = checkLiveStageAdmission({ store, config, agent_slug });
  if (!admission.ok) {
    return Object.freeze({
      admitted: false, reason: admission.reason, detail: admission.detail,
      network_attempted: false, providerResult: null, fingerprint: null, config: config ?? null,
    });
  }

  // Trusted values only. Note what is NOT here: nothing from a request.
  const providerResult = await chain.invoke({
    provider_id: config.provider_id,
    model_id: config.model_id,
    input,
    // The live Content Factory stage never retries. A second attempt is a
    // second payment, and M27's call budget exists to make that visible.
    max_retries: 0,
    agent_slug, task_id, tree_id: workflow_id,
  });

  return Object.freeze({
    admitted: true,
    reason: providerResult.status === 'ok' ? PROVIDER_REASON.OK : providerResult.reason,
    detail: providerResult.detail ?? null,
    network_attempted: true,
    providerResult,
    fingerprint: fingerprintLiveRequest({ provider_id: LIVE_TEXT_CAPABILITY_ID, input }),
    config,
  });
}

/**
 * PHASE 2 — the synchronous facade `runtime.js` is given as its
 * `providerInvoker`.
 *
 * Every request that is not the live sentinel is delegated, unchanged,
 * to the ordinary deterministic invoker — so the other eleven
 * specialists behave exactly as they always have, and a normal Content
 * Factory run is unaffected.
 *
 * A request that IS the live sentinel is answered from the sealed ticket
 * and only if all of these hold:
 *   - a ticket exists (a live stage was configured and prefetched)
 *   - the CALLER is the admitted agent — `agent_slug` here is injected by
 *     runtime.js from the task record, not written by the handler
 *   - the request fingerprint matches what governance approved
 *   - the ticket has not already been used
 *
 * There is no path from here to the network, the registry, a credential,
 * or a budget. Phase 2 can only hand back something phase 1 already paid
 * for, or refuse.
 *
 * @param {object} deps
 * @param {{invoke:Function}} deps.deterministicInvoker  `createProviderInvoker()`
 * @param {object|null} [deps.ticket]  a `resolveLiveStageContent()` result
 */
export function createLiveCapableInvoker({ deterministicInvoker, ticket = null }) {
  let consumed = false;

  function refuse(reason, detail) {
    return { status: 'failed', reason, detail, output: null, network_attempted: false };
  }

  function invoke(request) {
    if (request?.provider_id !== LIVE_TEXT_CAPABILITY_ID) {
      // Not a live request. Nothing about the deterministic path changes.
      return deterministicInvoker.invoke(request);
    }

    if (!ticket) {
      return refuse(
        LIVE_STAGE_REASON.LIVE_STAGE_NOT_CONFIGURED,
        'no live-capable stage is configured for this run',
      );
    }
    if (!ticket.admitted) {
      return refuse(ticket.reason, ticket.detail);
    }
    // `agent_slug` is runtime.js's, derived from the task record. A
    // handler cannot forge it: runtime.js overwrites whatever the
    // request carried before calling this.
    if (request?.agent_slug !== ticket.config.agent_slug) {
      return refuse(
        LIVE_STAGE_REASON.LIVE_STAGE_NOT_ADMITTED,
        `${request?.agent_slug ?? 'unknown'} is not the configured live-capable stage`,
      );
    }
    if (consumed) {
      return refuse(
        LIVE_STAGE_REASON.LIVE_TICKET_ALREADY_USED,
        'one live provider call per task — this task already made its call',
      );
    }
    const asked = fingerprintLiveRequest({ provider_id: request?.provider_id, input: request?.input });
    if (asked !== ticket.fingerprint) {
      return refuse(
        LIVE_STAGE_REASON.LIVE_REQUEST_MISMATCH,
        'the request does not match the one governance approved for this task',
      );
    }

    // Single-use: mark BEFORE returning, so even a re-entrant caller
    // cannot obtain the paid result twice.
    consumed = true;
    return ticket.providerResult;
  }

  return Object.freeze({ invoke, get consumed() { return consumed; } });
}

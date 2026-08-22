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
import { checkContract } from './contracts.js';
import { buildArtifactRequestFromProviderResult } from './providers/artifact-bridge.js';

export const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled', // added in M8 — a task in a cancelled or
  // dependency-failed workflow never reaches runTask, so this value is
  // set by the workflow engine (workflow.js), never by this file.
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
 * @param {{invokeModel: Function}} [deps.modelRuntime]  optional. Omitted by
 *   every handler that doesn't call a model — which, before M7, was all of
 *   them. Handlers that never reference `callModel` are unaffected by its
 *   presence or absence.
 * @param {{createArtifactSync: Function}} [deps.artifactService]  optional,
 *   M20. Omitted by every handler that doesn't produce an artifact —
 *   which, before M20, was all of them. Handlers that never reference
 *   `createArtifact` are unaffected by its presence or absence. Must be a
 *   `createArtifactService()` instance constructed over the SAME
 *   synchronous, in-memory store/artifactStore this runtime already
 *   runs against (D28) — `createArtifactSync` throws loudly rather than
 *   misbehave if handed an async (Postgres) one. See DECISIONS.md D37.
 * @param {{invoke: Function}} [deps.providerInvoker]  optional, M22.
 *   Omitted by every handler that doesn't generate provider content —
 *   which, before M22, was all of them. Handlers that never reference
 *   `generateContent` are unaffected by its presence or absence. Must be
 *   a `createProviderInvoker()` instance (src/providers/invoke.js, M21) —
 *   already synchronous, already governed (provider/model lookup,
 *   capability check, input/output size ceilings, bounded retry, output
 *   shape validation). `generateContent` needs BOTH this and
 *   `artifactService` to do its job (invoke, then create the resulting
 *   artifact) — if either is missing, calling it throws, the same way
 *   `callModel`/`createArtifact` already do when their own dependency is
 *   missing. This runtime holds no reference to the provider REGISTRY —
 *   only to the already-governed invoker built over it — so a handler
 *   can never reach provider registration, provider limits, or anything
 *   the invoker itself does not expose. See DECISIONS.md D39.
 */
export function createRuntime({
  store, broker, audit, clock, handlers, registrySha, modelRuntime, artifactService, providerInvoker,
}) {
  /**
   * Runs one task to completion.
   * @returns {object} the final task record
   */
  function runTask({ agent_slug, input, task_id, tree_id, depth = 0, required_capability = null }) {
    const now = clock();
    const agent = store.getAgent(agent_slug);

    // M8: an orchestrator (workflow.js) may have already created this task
    // record at admission time, carrying tree structure this function
    // knows nothing about — parent_task_id, depends_on, workflow_id,
    // attempt_number, retry_of_task_id. Re-creating it from scratch here,
    // as this function always did through M7, would silently discard all
    // of that. Reuse it instead; only re-derive the facts that are this
    // function's own job to establish fresh — agent_id and
    // agent_version_id, on the same "authorization is evaluated at
    // execution time, not trusted from an earlier snapshot" principle the
    // pre-flight checks below already apply. A caller that never
    // pre-creates a task (every M5–M7 caller) is unaffected: this branch
    // is simply never taken, and the else branch is byte-for-byte what
    // this function always did.
    const preExisting = store.getTask(task_id);
    const signature = preExisting
      ? preExisting.signature
      : taskSignature({ agent_slug, action_type: 'agent.run', input });

    let task = preExisting
      ? store.updateTask(task_id, {
          agent_id: agent?.agent_id ?? null,
          agent_version_id: agent?.version_id ?? null,
          registry_sha: registrySha,
        })
      : store.createTask({
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

    // The depth actually admitted (workflow.js validated it against
    // MAX_DEPTH already) is authoritative once a task record exists;
    // falls back to the parameter for the pre-M8, no-pre-creation path.
    const effectiveDepth = task.depth ?? depth;

    const fail = (reason, detail) => {
      const updated = store.updateTask(task.id, {
        status: TASK_STATUS.FAILED,
        completed_at: clock(),
        error: detail ?? reason,
        // `error` above is prose (a detail string when one exists, else the
        // bare reason) — good for a human, useless for a policy decision.
        // failure_reason_code is always the exact RUNTIME_REASON, added in
        // M8 so retry policy (workflow.js) can classify a failure without
        // parsing free text. Additive: no existing test reads this field.
        failure_reason_code: reason,
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
    // The Broker has checked workflow-scoped freeze for tool calls since
    // Milestone 4 (WORKFLOW_FROZEN). This runtime pre-flight never checked
    // it for AGENT execution — a gap invisible while every tree was one
    // task, real now that M8 makes trees real: a frozen workflow could
    // still run agent logic and spend model budget on tasks that could
    // never call a tool. Found during M8's inspection; fixed here.
    if (tree_id && store.activeFreeze('workflow', tree_id, now)) return fail(RUNTIME_REASON.AGENT_FROZEN, 'workflow freeze');
    if (agent.state !== 'active') return fail(RUNTIME_REASON.AGENT_NOT_ACTIVE, `state is ${agent.state}`);
    if (effectiveDepth > MAX_DEPTH) return fail(RUNTIME_REASON.DEPTH_EXCEEDED, `depth ${effectiveDepth} exceeds ${MAX_DEPTH}`);

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

    // The handler's only route to a model. It receives a RESULT, never a
    // capability — invokeModel() has no reference to the Broker, to store's
    // mutation methods, or to anything that could authorize an action.
    // Whatever a model's output contains is exactly as untrusted as any
    // other input a handler chooses to pass to callTool(): the Broker still
    // decides, independent of what the model said. See DECISIONS.md D24.
    const callModel = modelRuntime
      ? (request) => modelRuntime.invokeModel({ ...request, agent_slug, task_id, tree_id })
      : () => { throw new Error('no model runtime configured for this agent'); };

    // The handler's only route to producing a content artifact (M20).
    // Trusted execution context (agent_slug, workflow_id, task_id) is
    // supplied by THIS closure, spread in AFTER the handler's own
    // request — identical to callModel's pattern above — so a handler
    // cannot make an artifact appear to belong to a different agent,
    // workflow, or task by including those fields in its own request.
    // createArtifactSync independently re-derives and validates
    // everything regardless; this is defense in depth, not the only
    // guard. See the artifact service module's own header and
    // DECISIONS.md D37.
    const createArtifact = artifactService
      ? (request) => artifactService.createArtifactSync({ ...request, agent_slug, workflow_id: tree_id, task_id })
      : () => { throw new Error('no artifact service configured for this agent'); };

    // The handler's only route to provider-backed content generation
    // (M22). This is a COMPOSITION of two already-governed, already-
    // trusted pieces — not a third implementation of either: `invoke.js`
    // (M21 — provider/model lookup, capability check, input/output size
    // ceilings, bounded retry, output shape validation, all before this
    // ever sees a result) and the `createArtifact` closure defined just
    // above (M20 — trusted provenance, checksum, lineage). Exactly the
    // order the M22 directive's own diagram names: PROVIDER INVOCATION ->
    // CONTENT RESULT -> ARTIFACT SERVICE.
    //
    // A handler's request may name provider_id/model_id/required_capability/
    // input/max_retries/artifact_type/parent_artifact_ids/reason — never
    // agent identity, version, registry SHA, workflow, or task: those,
    // exactly as createArtifact already guarantees, come only from THIS
    // closure's trusted execution context (agent_slug/task_id/tree_id,
    // spread into the invoker call the same way callModel already does
    // above), never from the handler's own request object. The handler
    // receives this one narrow function — never the provider registry,
    // never the resource governor, never anything that could register a
    // provider or grant authority. See DECISIONS.md D39 and this
    // milestone's adversarial tests.
    const generateContent = (providerInvoker && artifactService)
      ? (request) => {
          const providerResult = providerInvoker.invoke({
            provider_id: request?.provider_id,
            model_id: request?.model_id,
            required_capability: request?.required_capability,
            input: request?.input,
            max_retries: request?.max_retries,
            agent_slug, task_id, tree_id,
          });
          if (providerResult.status !== 'ok') {
            return {
              outcome: 'rejected', code: providerResult.reason, detail: providerResult.detail ?? null,
              artifact: null, provider_result: providerResult,
            };
          }
          let artifactRequest;
          try {
            artifactRequest = buildArtifactRequestFromProviderResult({
              providerResult,
              artifact_type: request?.artifact_type,
              parent_artifact_ids: request?.parent_artifact_ids ?? [],
              reason: request?.reason ?? null,
            });
          } catch (err) {
            // buildArtifactRequestFromProviderResult throws on an unknown
            // artifact_type (see artifact-bridge.js) — reported here as
            // ordinary rejection DATA, exactly like every other fail-
            // closed reason above, not as a thrown HANDLER_ERROR: a
            // handler asking for an unsupported artifact_type is a
            // request-shape problem the handler can inspect and react to,
            // the same category of thing PROVIDER_CONTRACT_VIOLATION
            // already names for the request's `input` shape.
            return {
              outcome: 'rejected', code: 'PROVIDER_CONTRACT_VIOLATION', detail: String(err.message),
              artifact: null, provider_result: providerResult,
            };
          }
          // createArtifact independently re-derives and validates
          // everything regardless (defense in depth, not the only guard —
          // see createArtifact's own comment above and DECISIONS.md D37).
          return { ...createArtifact(artifactRequest), provider_result: providerResult };
        }
      : () => { throw new Error('no provider invoker/artifact service configured for this agent'); };

    let envelope;
    try {
      envelope = handler({ input, callTool, callModel, createArtifact, generateContent, DECISION });
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

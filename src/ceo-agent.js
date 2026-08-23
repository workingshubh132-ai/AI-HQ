/**
 * AI-HQ CEO / EXECUTIVE ORCHESTRATOR — AGENT DEFINITION (Milestone 24)
 *
 * The CEO is DATA, exactly like every other agent in this system: an
 * immutable `makeAgentVersion` record with declared capabilities, a
 * clearance, an empty tool allowlist, resource limits inside
 * `validator.js`'s POLICY ceilings, and a mutable lifecycle record
 * pointing at it. It is registered through the SAME
 * `store.addAgentVersion`/`store.registerAgent` path every specialist
 * uses, validated by the SAME `validateAgentVersion`, and subject to the
 * SAME lifecycle and freeze machinery.
 *
 * ── THE CEO HAS NO SPECIAL AUTHORIZATION. THIS IS THE WHOLE POINT. ───────
 *
 * `clearance: 'GREEN'` and `allowed_tools: []` — the LEAST authority any
 * agent in this codebase can hold. The CEO cannot execute a tool,
 * because it holds none and the Broker would deny it regardless. It
 * cannot approve anything, lift a freeze, alter a budget, or change any
 * agent's lifecycle state, because `src/ceo/orchestrator.js` (the code
 * that acts under this identity) holds no reference to anything that
 * could — a structural fact, checked by grep-based tests, not a promise
 * kept by comment.
 *
 * The CEO's power is exactly this: it may REQUEST. `router.js` decides
 * which specialist (or none) is eligible. `workflow.js` decides whether
 * a proposed task is admissible. `runtime.js` decides whether an agent
 * may execute at all. `guardian.js` may freeze the CEO itself. The
 * `broker.js` decides every tool call underneath all of it. None of them
 * knows or cares that the requester is "the CEO" — there is no
 * CEO-shaped branch anywhere in any of those files, and this milestone
 * added none.
 *
 * ── WHY THE CEO IS NOT EXECUTED AS A TASK HANDLER ────────────────────────
 *
 * A handler receives exactly `{input, callTool, callModel,
 * createArtifact, generateContent, DECISION}` (runtime.js, unchanged
 * since M22). It has no coordinator, no router, no workflow engine — by
 * design, because a handler that could propose arbitrary tasks would be
 * a general-purpose bypass of the admission gauntlet every task must
 * pass. Widening that closure set for the CEO would have been exactly
 * the "CEO requires special authorization" STOP condition the M24
 * directive names.
 *
 * So the CEO orchestrator is a component that acts UNDER this agent's
 * identity rather than a handler executed as a task — the same shape
 * `content-factory-orchestrator.js` (M23) already has. What makes that
 * governed rather than a loophole: the orchestrator re-reads THIS
 * agent's real record from the store before every decision cycle and
 * halts if it is not active, or if an agent/workflow/global freeze
 * covers it. A frozen CEO orchestrates nothing. See DECISIONS.md D41.
 *
 * Constitution: sections 6, 7, 13, 18, 20, 25.
 */

import { makeAgent, makeAgentVersion, VERSION_STATE, RUNTIME_STATE, versionId } from './agents.js';

export const CEO_AGENT_SLUG = 'ceo-orchestrator-agent';
const CEO_AGENT_ID = 'agent-ceo-orchestrator';
const CEO_VERSION = '1.0.0';

/**
 * The CEO's declared capabilities — advisory routing metadata, exactly
 * as advisory as every other agent's (`agents.js`: "the Broker never
 * reads it and it grants nothing"). Declaring `ceo-goal-planning` grants
 * the CEO no more authority than a specialist declaring `cf-script`
 * grants that specialist.
 */
export const CEO_CAPABILITY = Object.freeze({
  GOAL_PLANNING: 'ceo-goal-planning',
  WORKFLOW_PLANNING: 'ceo-workflow-planning',
  SPECIALIST_SELECTION: 'ceo-specialist-selection',
  EXECUTION_MONITORING: 'ceo-execution-monitoring',
  FAILURE_ANALYSIS: 'ceo-failure-analysis',
  ARTIFACT_REVIEW: 'ceo-artifact-review',
  COMPLETION_EVALUATION: 'ceo-completion-evaluation',
});

export const CEO_AGENT_VERSION = makeAgentVersion({
  agent_id: CEO_AGENT_ID,
  version: CEO_VERSION,
  purpose:
    'Executive orchestrator: converts a high-level goal into a structured plan, '
    + 'requests governed work through the existing router/workflow/coordinator path, '
    + 'monitors execution, performs bounded recovery, and evaluates structural completion. '
    + 'Holds no tools and no special authorization of any kind.',
  department: 'executive',
  state: VERSION_STATE.APPROVED,

  // ── security-authoritative fields — deliberately the WEAKEST possible ──
  clearance: 'GREEN',
  allowed_tools: [],
  limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 30_000 },

  // ── advisory / descriptive ──
  capabilities: Object.values(CEO_CAPABILITY),
  // The CEO orchestrates CONTENT_FACTORY workflows today. Declaring the
  // type restricts it (router.js's WORKFLOW_TYPE_NOT_SUPPORTED check)
  // rather than widening anything — an empty array would mean "no stated
  // restriction," which is strictly more permissive.
  allowed_workflow_types: ['CONTENT_FACTORY'],
  input_contract: { required: ['goal'] },
  output_contract: { required: ['completion_status', 'workflow_id'] },
  // Empty: the CEO makes no model call of any kind. Its planning is
  // deterministic string/structure work (see src/ceo/planner.js), never
  // an inference call — and `validator.js` would reject an unregistered
  // provider here regardless.
  model_config: {},
  metadata: { executive: true, orchestrator: true },

  created_at: 0,
  approved_by: 'founder',
  approved_at: 0,
});

export const CEO_AGENT_RECORD = makeAgent({
  id: CEO_AGENT_ID,
  slug: CEO_AGENT_SLUG,
  name: CEO_AGENT_SLUG,
  lifecycle_state: RUNTIME_STATE.ACTIVE,
  active_version_id: versionId(CEO_AGENT_ID, CEO_VERSION),
  concurrency_limit: 1,
});

/** Registers the CEO through the SAME path every specialist uses. */
export function registerCeoAgent(store) {
  store.addAgentVersion(CEO_AGENT_VERSION);
  store.registerAgent(CEO_AGENT_RECORD);
}

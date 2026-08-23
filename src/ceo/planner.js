/**
 * CEO PLANNER (Milestone 24)
 *
 * Converts a high-level goal into a STRUCTURED EXECUTION PLAN. It
 * executes nothing: no task is proposed, no agent runs, no artifact is
 * created, no store is written. A plan is inert data that
 * `src/ceo/orchestrator.js` then puts through the existing governed
 * execution path — the same separation `router.js` already draws
 * between "which agent should handle this?" (advice) and "may it?"
 * (authorization, elsewhere).
 *
 * ── GOAL PARSING IS DETERMINISTIC STRING WORK, NOT COMPREHENSION ─────────
 *
 * `parseGoal()` below is a regex/keyword classifier: it looks for
 * "about X" / "on X" to lift a topic, and for a small set of literal
 * keywords to choose a plan template. Same goal string, same plan,
 * forever — no model call, no inference, no network, no randomness.
 *
 * This is NOT semantic understanding of the goal, and nothing in this
 * codebase describes it as such. A goal it cannot parse produces a
 * structured failure (`MALFORMED_GOAL` / `NO_TEMPLATE_FOR_GOAL`), never
 * a guess. See DECISIONS.md D41.
 *
 * ── CAPABILITY, NEVER A HARDCODED SLUG ───────────────────────────────────
 *
 * Every stage names a `required_capability`. No plan anywhere in this
 * file names an `agent_slug`: which specialist actually runs a stage is
 * `router.js`'s decision, made fresh at proposal time against the real
 * store. `checkCapabilityAvailability()` below asks M23's read-only
 * `listAvailableSpecialists()` whether SOME active agent declares each
 * required capability, and returns a structured failure naming exactly
 * which are missing when one is not — it never substitutes a different
 * capability, never falls back to "closest match," and never picks an
 * agent itself.
 *
 * Note the deliberate division of labor: this check is an ADVISORY
 * pre-flight so the CEO can fail fast with a useful report. It is not
 * the security boundary — `router.js` re-evaluates eligibility
 * (freeze, lifecycle, version approval, workflow type, concurrency,
 * budget) from scratch at proposal time regardless of what this
 * function concluded a moment earlier.
 *
 * Constitution: sections 6, 7, 13, 18.
 */

import { ARTIFACT_TYPE } from '../artifacts.js';
import { CONTENT_FACTORY_CAPABILITY, WORKFLOW_TYPE_CONTENT_FACTORY } from '../content-factory-agents.js';
import { CEO_LIMITS, CEO_LIMIT_REASON } from './limits.js';

const CF = CONTENT_FACTORY_CAPABILITY;

export const PLANNING_REASON = Object.freeze({
  OK: 'OK',
  MALFORMED_GOAL: 'MALFORMED_GOAL',
  NO_TEMPLATE_FOR_GOAL: 'NO_TEMPLATE_FOR_GOAL',
  CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
  PLANNING_ITERATIONS_EXCEEDED: CEO_LIMIT_REASON.PLANNING_ITERATIONS_EXCEEDED,
});

/**
 * ── PLAN TEMPLATES ARE DATA ──────────────────────────────────────────────
 *
 * A template is a list of stages. Each stage declares:
 *
 *   stage_id                a stable name, also the key this stage
 *                           contributes to the `stage_summary` binding
 *   required_capability     what the router must find an agent for
 *   depends_on              stage_ids that must COMPLETE first — becomes
 *                           workflow.js's own `depends_on`, unchanged
 *   expected_artifact_type  what completion evaluation will look for
 *   output_artifact_field   which field of the task's real result
 *                           carries the produced artifact_id
 *   input_binding           DECLARATIVE: how to build this stage's task
 *                           input from the goal and from upstream
 *                           stages' REAL completed outputs. Resolved by
 *                           the orchestrator against actual task
 *                           records — never by copying a literal from
 *                           this file, and never from anything a
 *                           provider or handler returned as free text.
 *
 * Adding a pipeline is adding a template here (data), not writing a
 * second executor — exactly how `actions.js`'s ACTIONS registry and
 * `artifacts.js`'s ARTIFACT_TYPE have each grown.
 */

const fromGoal = (field) => Object.freeze({ from: 'goal', field });
const fromStage = (stage_id, output_field) => Object.freeze({ from_stage: stage_id, output_field });
const STAGE_SUMMARY = Object.freeze({ from: 'stage_summary' });

/** The CONTENT_FACTORY pipeline (M23's twelve specialists), expressed as
 * a plan rather than as hardcoded orchestration code. The dependency
 * graph — including the three-way parallel branch and the three-parent
 * join — is exactly the one `docs/CONTENT_FACTORY.md` §3 documents. */
export const CONTENT_FACTORY_PLAN_TEMPLATE = Object.freeze({
  template_id: 'content-factory-short-form-v1',
  workflow_type: WORKFLOW_TYPE_CONTENT_FACTORY,
  stages: Object.freeze([
    Object.freeze({
      stage_id: 'research', required_capability: CF.RESEARCH, depends_on: Object.freeze([]),
      expected_artifact_type: ARTIFACT_TYPE.RESEARCH, output_artifact_field: 'research_artifact_id',
      input_binding: Object.freeze({ topic: fromGoal('topic') }),
    }),
    Object.freeze({
      stage_id: 'fact_check', required_capability: CF.FACT_CHECK, depends_on: Object.freeze(['research']),
      expected_artifact_type: ARTIFACT_TYPE.TEXT, output_artifact_field: 'fact_check_artifact_id',
      input_binding: Object.freeze({
        topic: fromGoal('topic'),
        research_artifact_id: fromStage('research', 'research_artifact_id'),
      }),
    }),
    Object.freeze({
      stage_id: 'idea', required_capability: CF.IDEA, depends_on: Object.freeze(['research', 'fact_check']),
      expected_artifact_type: ARTIFACT_TYPE.TEXT, output_artifact_field: 'idea_artifact_id',
      input_binding: Object.freeze({
        topic: fromGoal('topic'),
        research_artifact_id: fromStage('research', 'research_artifact_id'),
        fact_check_artifact_id: fromStage('fact_check', 'fact_check_artifact_id'),
      }),
    }),
    Object.freeze({
      stage_id: 'script', required_capability: CF.SCRIPT, depends_on: Object.freeze(['idea']),
      expected_artifact_type: ARTIFACT_TYPE.SCRIPT, output_artifact_field: 'script_artifact_id',
      input_binding: Object.freeze({
        topic: fromGoal('topic'),
        idea_artifact_id: fromStage('idea', 'idea_artifact_id'),
      }),
    }),
    Object.freeze({
      stage_id: 'hook', required_capability: CF.HOOK, depends_on: Object.freeze(['script']),
      expected_artifact_type: ARTIFACT_TYPE.TEXT, output_artifact_field: 'hook_artifact_id',
      input_binding: Object.freeze({
        topic: fromGoal('topic'),
        script_artifact_id: fromStage('script', 'script_artifact_id'),
      }),
    }),
    // ── parallel branch: none of these three depends on the others ──
    Object.freeze({
      stage_id: 'audio', required_capability: CF.AUDIO, depends_on: Object.freeze(['script', 'hook']),
      expected_artifact_type: ARTIFACT_TYPE.AUDIO, output_artifact_field: 'audio_artifact_id',
      input_binding: Object.freeze({
        script_artifact_id: fromStage('script', 'script_artifact_id'),
        hook_artifact_id: fromStage('hook', 'hook_artifact_id'),
      }),
    }),
    Object.freeze({
      stage_id: 'visual', required_capability: CF.VISUAL, depends_on: Object.freeze(['script', 'hook']),
      expected_artifact_type: ARTIFACT_TYPE.IMAGE, output_artifact_field: 'visual_artifact_id',
      input_binding: Object.freeze({
        script_artifact_id: fromStage('script', 'script_artifact_id'),
        hook_artifact_id: fromStage('hook', 'hook_artifact_id'),
      }),
    }),
    Object.freeze({
      stage_id: 'social_package', required_capability: CF.SOCIAL_PACKAGE, depends_on: Object.freeze(['script', 'hook']),
      expected_artifact_type: ARTIFACT_TYPE.SOCIAL_PACKAGE, output_artifact_field: 'social_package_artifact_id',
      input_binding: Object.freeze({
        topic: fromGoal('topic'),
        script_artifact_id: fromStage('script', 'script_artifact_id'),
        hook_artifact_id: fromStage('hook', 'hook_artifact_id'),
      }),
    }),
    // ── join back: subtitle needs REAL audio; video needs all three ──
    Object.freeze({
      stage_id: 'subtitle', required_capability: CF.SUBTITLE, depends_on: Object.freeze(['audio']),
      expected_artifact_type: ARTIFACT_TYPE.SUBTITLE, output_artifact_field: 'subtitle_artifact_id',
      input_binding: Object.freeze({ audio_artifact_id: fromStage('audio', 'audio_artifact_id') }),
    }),
    Object.freeze({
      stage_id: 'video_plan', required_capability: CF.VIDEO_PLAN, depends_on: Object.freeze(['audio', 'visual', 'subtitle']),
      expected_artifact_type: ARTIFACT_TYPE.VIDEO, output_artifact_field: 'video_artifact_id',
      input_binding: Object.freeze({
        audio_artifact_id: fromStage('audio', 'audio_artifact_id'),
        visual_artifact_id: fromStage('visual', 'visual_artifact_id'),
        subtitle_artifact_id: fromStage('subtitle', 'subtitle_artifact_id'),
      }),
    }),
    Object.freeze({
      stage_id: 'quality_control', required_capability: CF.QUALITY_CONTROL,
      depends_on: Object.freeze(['research', 'fact_check', 'idea', 'script', 'hook', 'audio', 'visual', 'social_package', 'subtitle', 'video_plan']),
      expected_artifact_type: ARTIFACT_TYPE.TEXT, output_artifact_field: 'qc_report_artifact_id',
      input_binding: Object.freeze({ stages: STAGE_SUMMARY }),
    }),
    Object.freeze({
      stage_id: 'publishing_package', required_capability: CF.PUBLISH, depends_on: Object.freeze(['quality_control']),
      expected_artifact_type: ARTIFACT_TYPE.CONTENT_PACKAGE, output_artifact_field: 'content_package_artifact_id',
      input_binding: Object.freeze({
        topic: fromGoal('topic'),
        stages: STAGE_SUMMARY,
        qc_passed: fromStage('quality_control', 'qc_passed'),
        qc_report_artifact_id: fromStage('quality_control', 'qc_report_artifact_id'),
      }),
    }),
  ]),
  /** What "done" means, structurally. Consumed by
   * `src/ceo/completion.js` — deterministic checks over real records,
   * never a semantic judgment about content quality. */
  success_criteria: Object.freeze({
    required_stage_ids: Object.freeze([
      'research', 'fact_check', 'idea', 'script', 'hook', 'audio', 'visual',
      'social_package', 'subtitle', 'video_plan', 'quality_control', 'publishing_package',
    ]),
    required_artifact_types: Object.freeze([
      ARTIFACT_TYPE.RESEARCH, ARTIFACT_TYPE.SCRIPT, ARTIFACT_TYPE.AUDIO, ARTIFACT_TYPE.IMAGE,
      ARTIFACT_TYPE.SOCIAL_PACKAGE, ARTIFACT_TYPE.SUBTITLE, ARTIFACT_TYPE.VIDEO, ARTIFACT_TYPE.CONTENT_PACKAGE,
    ]),
    require_quality_control_passed: true,
    require_publishing_package: true,
  }),
});

const PLAN_TEMPLATES = Object.freeze([CONTENT_FACTORY_PLAN_TEMPLATE]);

/** Literal keywords that select the content-factory template. A goal
 * matching none of these produces NO_TEMPLATE_FOR_GOAL — never a
 * default template, never a guess. */
const CONTENT_FACTORY_GOAL_KEYWORDS = Object.freeze([
  'video package', 'content package', 'short-form', 'short form', 'video', 'content',
]);

/**
 * Deterministic goal parsing — see this file's header. Returns
 * `{topic, workflow_type}` or null.
 *
 * @param {string} goal
 */
export function parseGoal(goal) {
  if (typeof goal !== 'string' || goal.trim() === '') return null;
  const text = goal.trim();
  const lower = text.toLowerCase();

  if (!CONTENT_FACTORY_GOAL_KEYWORDS.some((k) => lower.includes(k))) return null;

  // "... about X" / "... on X", minus trailing punctuation. Deliberately
  // simple and total: if neither preposition appears, there is no topic
  // and the caller gets a MALFORMED_GOAL rather than a fabricated one.
  const match = text.match(/\babout\s+(.+)$/i) ?? text.match(/\bon\s+(.+)$/i);
  if (!match) return null;
  const topic = match[1].replace(/[.!?]+\s*$/, '').trim();
  if (topic === '') return null;

  return { topic, workflow_type: WORKFLOW_TYPE_CONTENT_FACTORY };
}

/**
 * Advisory pre-flight: does SOME active agent declare each capability
 * this plan needs? Uses M23's read-only `listAvailableSpecialists`
 * output — this function reads, never selects and never mutates.
 *
 * @param {object[]} specialists  from listAvailableSpecialists()
 * @param {string[]} requiredCapabilities
 * @param {string} workflowType
 * @returns {{available:boolean, missing:string[]}}
 */
export function checkCapabilityAvailability(specialists, requiredCapabilities, workflowType) {
  const missing = [];
  for (const capability of requiredCapabilities) {
    const found = (specialists ?? []).some((s) => {
      if (!Array.isArray(s.capabilities) || !s.capabilities.includes(capability)) return false;
      // An agent declaring NO workflow-type restriction is general-purpose
      // — the same reading router.js itself applies (agents.js: "Empty
      // means 'no stated restriction,' not 'supports nothing'").
      const types = Array.isArray(s.allowed_workflow_types) ? s.allowed_workflow_types : [];
      return types.length === 0 || types.includes(workflowType);
    });
    if (!found) missing.push(capability);
  }
  return { available: missing.length === 0, missing };
}

/**
 * Goal → plan. Executes nothing.
 *
 * @param {object} args
 * @param {string} args.goal
 * @param {object[]} args.specialists  from M23's listAvailableSpecialists()
 * @param {number} [args.iteration]  which planning attempt this is (0-based)
 * @returns {{ok:boolean, reason:string, plan?:object, detail?:string, missing_capabilities?:string[]}}
 */
export function planGoal({ goal, specialists, iteration = 0 }) {
  if (iteration >= CEO_LIMITS.MAX_PLANNING_ITERATIONS) {
    return {
      ok: false, reason: PLANNING_REASON.PLANNING_ITERATIONS_EXCEEDED,
      detail: `iteration ${iteration} >= ${CEO_LIMITS.MAX_PLANNING_ITERATIONS}`,
    };
  }

  const parsed = parseGoal(goal);
  if (!parsed) {
    const isString = typeof goal === 'string' && goal.trim() !== '';
    return {
      ok: false,
      reason: isString ? PLANNING_REASON.NO_TEMPLATE_FOR_GOAL : PLANNING_REASON.MALFORMED_GOAL,
      detail: isString
        ? 'no plan template matches this goal, and no template is ever substituted by default'
        : 'goal must be a non-empty string',
    };
  }

  const template = PLAN_TEMPLATES.find((t) => t.workflow_type === parsed.workflow_type);
  if (!template) {
    return { ok: false, reason: PLANNING_REASON.NO_TEMPLATE_FOR_GOAL, detail: `no template for ${parsed.workflow_type}` };
  }

  const requiredCapabilities = template.stages.map((s) => s.required_capability);
  const availability = checkCapabilityAvailability(specialists, requiredCapabilities, template.workflow_type);
  if (!availability.available) {
    // Structured planning failure. NOT a substitution: the CEO does not
    // pick "something close" for a capability nothing declares.
    return {
      ok: false, reason: PLANNING_REASON.CAPABILITY_UNAVAILABLE,
      detail: `no eligible specialist declares: ${availability.missing.join(', ')}`,
      missing_capabilities: availability.missing,
    };
  }

  return {
    ok: true, reason: PLANNING_REASON.OK,
    plan: Object.freeze({
      goal,
      topic: parsed.topic,
      template_id: template.template_id,
      workflow_type: template.workflow_type,
      required_capabilities: Object.freeze([...requiredCapabilities]),
      stages: template.stages,
      success_criteria: template.success_criteria,
      planning_iteration: iteration,
    }),
  };
}

/**
 * CEO COMPLETION EVALUATOR (Milestone 24)
 *
 * Decides whether a goal's deliverable is STRUCTURALLY complete: did
 * every required stage complete, does every required artifact type
 * actually exist in the store, did quality control pass, is there a
 * publishing package, did the workflow reach a valid terminal state.
 *
 * ── THESE ARE STRUCTURAL CHECKS. THEY ARE NOT INTELLIGENCE. ──────────────
 *
 * Every check below compares real, already-recorded facts (task
 * statuses, artifact types, a boolean QC result, a workflow state)
 * against the plan's declared `success_criteria`. Nothing here reads,
 * interprets, or judges the CONTENT of any artifact. A package whose
 * script is nonsense passes every check here, and that is the honest,
 * intended behavior — the report says `check_type:
 * 'DETERMINISTIC_STRUCTURAL_CHECK'` for exactly that reason, the same
 * label `content-factory-agents.js`'s own quality-control agent already
 * carries (M23).
 *
 * Pure: no store handle, no clock, no randomness. Callers pass in the
 * real records they already read. See DECISIONS.md D41.
 *
 * Constitution: sections 13, 22, 23.
 */

import { TASK_STATUS } from '../runtime.js';
import { WORKFLOW_STATE } from '../workflow.js';

export const COMPLETION_STATUS = Object.freeze({
  COMPLETE: 'COMPLETE',
  INCOMPLETE: 'INCOMPLETE',
});

/** Workflow states in which a deliverable may legitimately be called
 * complete. FAILED and CANCELLED are terminal but never "complete";
 * RUNNING/WAITING/CREATED are not terminal at all. */
const VALID_TERMINAL_STATES = Object.freeze(new Set([WORKFLOW_STATE.COMPLETED]));

/**
 * @param {object} args
 * @param {object} args.success_criteria  from the plan (planner.js)
 * @param {Record<string, {status:string, artifact_id?:string, artifact_type?:string, output?:object}>} args.stage_results
 *   one entry per stage the CEO actually attempted, carrying the REAL
 *   task status and the REAL produced artifact identity
 * @param {{artifact_id:string, artifact_type:string}[]} args.artifacts
 *   the REAL artifact records for this workflow, read from the store
 * @param {string|null} args.workflow_state
 * @returns {{check_type:string, status:string, passed:boolean, findings:object[]}}
 */
export function evaluateCompletion({ success_criteria, stage_results, artifacts, workflow_state }) {
  const findings = [];
  const results = stage_results ?? {};
  const artifactList = Array.isArray(artifacts) ? artifacts : [];
  const criteria = success_criteria ?? {};

  // 1 — every required stage completed
  for (const stage_id of criteria.required_stage_ids ?? []) {
    const stage = results[stage_id];
    if (!stage) {
      findings.push({ check: 'STAGE_COMPLETED', stage_id, pass: false, detail: 'stage was never attempted' });
      continue;
    }
    findings.push({
      check: 'STAGE_COMPLETED', stage_id,
      pass: stage.status === TASK_STATUS.COMPLETED,
      detail: stage.status === TASK_STATUS.COMPLETED ? null : `status is ${stage.status}`,
    });
  }

  // 2 — every required artifact type really exists among this
  // workflow's real artifact records
  const presentTypes = new Set(artifactList.map((a) => a.artifact_type));
  for (const artifact_type of criteria.required_artifact_types ?? []) {
    findings.push({
      check: 'ARTIFACT_TYPE_PRESENT', artifact_type,
      pass: presentTypes.has(artifact_type),
      detail: presentTypes.has(artifact_type) ? null : 'no artifact of this type exists in the workflow',
    });
  }

  // 3 — every artifact_id a completed stage claims to have produced
  // really resolves to a real artifact record. A stage's own output is
  // a handler's word; this checks it against the store's record.
  const presentIds = new Set(artifactList.map((a) => a.artifact_id));
  for (const [stage_id, stage] of Object.entries(results)) {
    if (stage.status !== TASK_STATUS.COMPLETED || !stage.artifact_id) continue;
    findings.push({
      check: 'CLAIMED_ARTIFACT_EXISTS', stage_id,
      pass: presentIds.has(stage.artifact_id),
      detail: presentIds.has(stage.artifact_id) ? null : `claimed artifact ${stage.artifact_id} is not in the store`,
    });
  }

  // 4 — quality control passed, when the plan requires it
  if (criteria.require_quality_control_passed) {
    const qc = results.quality_control;
    const qcPassed = qc?.status === TASK_STATUS.COMPLETED && qc?.output?.result?.qc_passed === true;
    findings.push({
      check: 'QUALITY_CONTROL_PASSED', pass: qcPassed,
      detail: qcPassed ? null : 'quality control did not complete with qc_passed: true',
    });
  }

  // 5 — a publishing package exists, when the plan requires it
  if (criteria.require_publishing_package) {
    const publish = results.publishing_package;
    const hasPackage = publish?.status === TASK_STATUS.COMPLETED
      && typeof publish?.output?.result?.content_package_artifact_id === 'string'
      && presentIds.has(publish.output.result.content_package_artifact_id);
    findings.push({
      check: 'PUBLISHING_PACKAGE_PRESENT', pass: hasPackage,
      detail: hasPackage ? null : 'no real CONTENT_PACKAGE artifact was produced',
    });
  }

  // 6 — no attempted stage ended FAILED or CANCELLED
  for (const [stage_id, stage] of Object.entries(results)) {
    if (stage.status === TASK_STATUS.FAILED || stage.status === TASK_STATUS.CANCELLED) {
      findings.push({ check: 'NO_STAGE_FAILED', stage_id, pass: false, detail: `stage ended ${stage.status}` });
    }
  }

  // 7 — the workflow itself reached a valid terminal state
  findings.push({
    check: 'WORKFLOW_TERMINAL_STATE', pass: VALID_TERMINAL_STATES.has(workflow_state),
    detail: VALID_TERMINAL_STATES.has(workflow_state) ? null : `workflow state is ${workflow_state ?? 'unknown'}`,
  });

  const passed = findings.every((f) => f.pass);
  return {
    check_type: 'DETERMINISTIC_STRUCTURAL_CHECK',
    status: passed ? COMPLETION_STATUS.COMPLETE : COMPLETION_STATUS.INCOMPLETE,
    passed,
    findings,
  };
}

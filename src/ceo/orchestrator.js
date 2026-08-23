/**
 * CEO ORCHESTRATOR (Milestone 24)
 *
 * Turns a goal into governed work: plan → discover specialists →
 * propose stages through the EXISTING router/workflow/coordinator path
 * → monitor real task records → bounded recovery → deterministic
 * completion evaluation → executive report.
 *
 * ── WHAT THIS FILE STRUCTURALLY CANNOT DO ────────────────────────────────
 *
 * It holds no reference to the Broker, so it cannot execute a tool or
 * authorize one. It holds no reference to Guardian's freeze-imposing
 * machinery, so it cannot lift or impose a freeze. It receives only a
 * bare `requestApproval` FUNCTION — never the Approval Engine — so
 * `decide()` and `revoke()` are not reachable from here at all: the CEO
 * can ask for an approval and can never grant one. And it never touches
 * the store directly: `readOnlyStore()` below wraps the real store and
 * exposes ONLY read methods, so `setLifecycleState`, `addFreeze`,
 * `chargeBudgets`, `addBudget`, `registerAgent`, and every other
 * mutation are absent from the object this file's logic actually holds
 * — a structural guarantee, checked directly by tests, not a rule kept
 * by comment.
 *
 * ── THE CEO IS GOVERNED BY THE SAME MACHINERY IT ORCHESTRATES ────────────
 *
 * `ceoGovernanceCheck()` re-reads the CEO's OWN agent record from the
 * store before every decision cycle: unregistered, unapproved version,
 * non-active lifecycle, or any agent/workflow/global freeze covering it
 * halts the run immediately. A frozen CEO orchestrates nothing. This is
 * what makes "the CEO has no special authorization" true in the
 * direction that matters most — the CEO is not merely unable to grant
 * itself authority, it is itself subject to Guardian exactly like any
 * specialist. See `src/ceo-agent.js` and DECISIONS.md D41.
 *
 * ── EVERY STAGE GOES THROUGH THE FULL, UNMODIFIED GAUNTLET ───────────────
 *
 * `coordinator.proposeTask()` (router selection by capability, then the
 * workflow engine's own complete admission gauntlet) then
 * `runtime.runTask()` — the same two calls, in the same order, that
 * `content-factory-orchestrator.js` (M23) already makes, for exactly
 * the reason documented in DECISIONS.md D40. No task is ever inserted
 * into storage directly; no router decision is ever bypassed; no
 * agent_slug is ever named by the CEO.
 *
 * Constitution: sections 6, 13, 18, 20, 22, 23, 25.
 */

import { TASK_STATUS } from '../runtime.js';
import { WORKFLOW_STATE } from '../workflow.js';
import { CEO_AGENT_SLUG } from '../ceo-agent.js';
import { listAvailableSpecialists } from '../content-factory-orchestrator.js';
import { planGoal, PLANNING_REASON } from './planner.js';
import { decideRecovery, RECOVERY_ACTION, TERMINAL_RECOVERY_ACTIONS } from './recovery.js';
import { evaluateCompletion, COMPLETION_STATUS } from './completion.js';
import { CEO_LIMITS, CEO_LIMIT_REASON, createDecisionBudget } from './limits.js';

export const CEO_REASON = Object.freeze({
  OK: 'OK',
  CEO_NOT_REGISTERED: 'CEO_NOT_REGISTERED',
  CEO_VERSION_NOT_APPROVED: 'CEO_VERSION_NOT_APPROVED',
  CEO_NOT_ACTIVE: 'CEO_NOT_ACTIVE',
  CEO_FROZEN: 'CEO_FROZEN',
  GLOBAL_FREEZE: 'GLOBAL_FREEZE',
  WORKFLOW_FROZEN: 'WORKFLOW_FROZEN',
  PLANNING_FAILED: 'PLANNING_FAILED',
  PLAN_CYCLE_DETECTED: 'PLAN_CYCLE_DETECTED',
  BINDING_UNRESOLVED: 'BINDING_UNRESOLVED',
  STAGE_BLOCKED: 'STAGE_BLOCKED',
  DECISION_BUDGET_EXCEEDED: CEO_LIMIT_REASON.DECISION_BUDGET_EXCEEDED,
  REPLAN_CYCLES_EXCEEDED: CEO_LIMIT_REASON.REPLAN_CYCLES_EXCEEDED,
});

/**
 * A read-only view over the real store. The CEO's own logic holds ONLY
 * this — never the store itself — so no mutation method is reachable
 * from any decision this file makes. Every method below is one the
 * storage contract already documents as read-only.
 */
function readOnlyStore(store) {
  return Object.freeze({
    getAgent: (slug) => store.getAgent(slug),
    listAgents: () => store.listAgents(),
    getTask: (id) => store.getTask(id),
    activeFreeze: (scope, targetId, now) => store.activeFreeze(scope, targetId, now),
    budgetsFor: (query) => store.budgetsFor(query),
  });
}

/** A read-only view over the real artifact store, same reasoning. */
function readOnlyArtifactStore(artifactStore) {
  return Object.freeze({
    getArtifact: (id) => artifactStore.getArtifact(id),
    artifactsForWorkflow: (workflowId) => artifactStore.artifactsForWorkflow(workflowId),
  });
}

/**
 * Dependency order for a plan's stages. Deterministic (ties broken by
 * the template's own declaration order) and cycle-detecting — a plan
 * whose dependencies cannot be linearised is refused rather than
 * partially executed.
 *
 * @returns {{ok:true, order:object[]}|{ok:false, detail:string}}
 */
export function topologicalStageOrder(stages) {
  const byId = new Map(stages.map((s) => [s.stage_id, s]));
  const done = new Set();
  const order = [];
  let progressed = true;

  while (progressed && order.length < stages.length) {
    progressed = false;
    for (const stage of stages) {
      if (done.has(stage.stage_id)) continue;
      const deps = stage.depends_on ?? [];
      if (deps.some((d) => !byId.has(d))) {
        return { ok: false, detail: `stage ${stage.stage_id} depends on unknown stage(s)` };
      }
      if (deps.every((d) => done.has(d))) {
        done.add(stage.stage_id);
        order.push(stage);
        progressed = true;
      }
    }
  }

  if (order.length !== stages.length) {
    const stuck = stages.filter((s) => !done.has(s.stage_id)).map((s) => s.stage_id);
    return { ok: false, detail: `dependency cycle among: ${stuck.join(', ')}` };
  }
  return { ok: true, order };
}

/**
 * Builds the `stages` summary object M23's quality-control and
 * publishing-package agents consume, from REAL completed stage results
 * only. A stage that did not complete contributes nothing — never a
 * placeholder, so a missing stage stays visibly missing to quality
 * control rather than being papered over here.
 */
function buildStageSummary(stageResults) {
  const summary = {};
  for (const [stage_id, stage] of Object.entries(stageResults)) {
    if (stage.status !== TASK_STATUS.COMPLETED || !stage.artifact_id) continue;
    summary[stage_id] = { artifact_id: stage.artifact_id, artifact_type: stage.artifact_type };
    const length = stage.output?.result?.content_length;
    if (Number.isFinite(length)) summary[stage_id].content_length = length;
  }
  return summary;
}

/**
 * Resolves one stage's declarative `input_binding` against the goal and
 * against REAL completed upstream task outputs. Never invents a value:
 * an unresolvable binding is a structured failure, not a default.
 */
export function resolveStageInput({ stage, plan, stageResults }) {
  const input = {};
  for (const [field, binding] of Object.entries(stage.input_binding ?? {})) {
    if (binding.from === 'goal') {
      const value = plan[binding.field];
      if (value === undefined) return { ok: false, detail: `goal has no field ${binding.field}` };
      input[field] = value;
    } else if (binding.from === 'stage_summary') {
      input[field] = buildStageSummary(stageResults);
    } else if (typeof binding.from_stage === 'string') {
      const upstream = stageResults[binding.from_stage];
      if (!upstream || upstream.status !== TASK_STATUS.COMPLETED) {
        return { ok: false, detail: `upstream stage ${binding.from_stage} has not completed` };
      }
      const value = upstream.output?.result?.[binding.output_field];
      if (value === undefined) {
        return { ok: false, detail: `upstream stage ${binding.from_stage} produced no ${binding.output_field}` };
      }
      input[field] = value;
    } else {
      return { ok: false, detail: `stage ${stage.stage_id} has an unrecognised binding for ${field}` };
    }
  }
  return { ok: true, input };
}

/**
 * @param {object} deps
 * @param {object} deps.store               the real store (wrapped read-only here)
 * @param {object} deps.artifactStore       the real artifact store (wrapped read-only here)
 * @param {object} deps.workflow            createWorkflowEngine() instance
 * @param {object} deps.coordinator         createExecutionCoordinator() instance
 * @param {object} deps.runtime             the SAME createRuntime() instance `coordinator`'s
 *                                          workflow was built over
 * @param {object} deps.router              the SAME router instance `coordinator` was built over
 * @param {object} deps.guardian            the SAME Guardian instance `coordinator` was built over.
 *                                          Its entire public surface is evaluate-shaped; it exposes
 *                                          no freeze-imposition method to a caller.
 * @param {object} deps.audit
 * @param {() => number} deps.clock
 * @param {Function} [deps.requestApproval] OPTIONAL, and deliberately a BARE FUNCTION rather than
 *                                          the Approval Engine: the CEO can request an approval and
 *                                          can never reach `decide`/`revoke`. Omitted entirely, an
 *                                          approval-requiring failure simply reports as blocked.
 */
export function createCeoOrchestrator({
  store, artifactStore, workflow, coordinator, runtime, router, guardian, audit, clock, requestApproval = null,
}) {
  const reads = readOnlyStore(store);
  const artifactReads = readOnlyArtifactStore(artifactStore);

  function writeAudit(event, fields) {
    audit.write({ event, at: clock(), agent_slug: CEO_AGENT_SLUG, ...fields });
  }

  /**
   * The CEO's own governance gate — see this file's header. Re-read from
   * the real store on EVERY call, never cached, so a freeze imposed
   * mid-run takes effect on the very next decision.
   */
  function ceoGovernanceCheck(workflow_id) {
    const now = clock();
    const ceo = reads.getAgent(CEO_AGENT_SLUG);
    if (!ceo) return { ok: false, reason: CEO_REASON.CEO_NOT_REGISTERED };
    if (ceo.version_state !== 'approved') return { ok: false, reason: CEO_REASON.CEO_VERSION_NOT_APPROVED };
    if (ceo.state !== 'active') return { ok: false, reason: CEO_REASON.CEO_NOT_ACTIVE, detail: `state is ${ceo.state}` };
    if (reads.activeFreeze('agent', CEO_AGENT_SLUG, now)) return { ok: false, reason: CEO_REASON.CEO_FROZEN };
    if (reads.activeFreeze('global', null, now)) return { ok: false, reason: CEO_REASON.GLOBAL_FREEZE };
    if (workflow_id && reads.activeFreeze('workflow', workflow_id, now)) return { ok: false, reason: CEO_REASON.WORKFLOW_FROZEN };
    return { ok: true, reason: CEO_REASON.OK };
  }

  /**
   * Executes ONE stage: propose through the real router/workflow
   * gauntlet, then run through the real runtime, then release the
   * router reservation and let Guardian evaluate — mirroring
   * `execution-coordinator.js`'s own `runStep()` cadence exactly, for
   * the reason DECISIONS.md D40 documents.
   */
  function executeStage({ workflow_id, stage, taskId, input, workflowType, guardianEvents }) {
    const proposal = coordinator.proposeTask({
      workflow_id,
      task_id: taskId,
      required_capability: stage.required_capability,
      // The plan's declared workflow type is passed through so router.js
      // applies its own WORKFLOW_TYPE_NOT_SUPPORTED check — strictly
      // narrowing eligibility, never widening it.
      required_workflow_type: workflowType,
      input,
      depends_on: [],
    });

    if (proposal.decision !== 'accepted') {
      // The routing reason (when routing itself refused) is the specific,
      // actionable cause; the admission reason otherwise.
      const failure_reason = proposal.routing_reason ?? proposal.reason;
      return { ok: false, failure_reason, proposal, task: null };
    }

    const result = runtime.runTask({
      agent_slug: proposal.selected_agent_slug,
      input,
      task_id: taskId,
      tree_id: workflow_id,
      depth: proposal.task?.depth ?? 0,
    });
    router.release({ agent_slug: proposal.selected_agent_slug, task_id: taskId });
    guardianEvents.push(guardian.evaluate());

    if (result.status !== TASK_STATUS.COMPLETED) {
      return { ok: false, failure_reason: result.failure_reason_code ?? 'UNKNOWN', proposal, task: result };
    }
    return { ok: true, proposal, task: result };
  }

  /**
   * The one entry point: a goal in, an executive report out.
   *
   * @param {object} args
   * @param {string} args.goal
   * @param {string} args.workflow_id
   * @param {number} [args.budget_limit]
   * @returns {object} the executive report
   */
  function pursueGoal({ goal, workflow_id, budget_limit = 5000 }) {
    const budgetCounter = createDecisionBudget();
    const guardianEvents = [];
    const stageResults = {};
    const decisions = [];
    const failures = [];
    const approvals = [];
    let retries = 0;
    let plan = null;

    const record = (kind, detail) => {
      decisions.push({ kind, ...detail });
      writeAudit('ceo.decision', { workflow_id, kind, ...detail });
    };

    /** Every halt goes through here, so no exit path can skip the
     * report or the audit trail. */
    const halt = (reason, detail = null) => {
      writeAudit('ceo.halted', { workflow_id, reason, detail });
      return buildReport({ reason, detail });
    };

    // ── 0 — the CEO's own governance, before anything at all ──────────
    let governance = ceoGovernanceCheck(null);
    if (!governance.ok) return halt(governance.reason, governance.detail ?? null);

    // ── 1 — plan. Executes nothing. ───────────────────────────────────
    if (!budgetCounter.spend('plan')) return halt(CEO_REASON.DECISION_BUDGET_EXCEEDED);
    const specialists = listAvailableSpecialists({ store: reads });
    const planning = planGoal({ goal, specialists, iteration: 0 });
    record('plan', { ok: planning.ok, reason: planning.reason });
    if (!planning.ok) {
      return halt(CEO_REASON.PLANNING_FAILED, planning.detail ?? planning.reason);
    }
    plan = planning.plan;

    const ordering = topologicalStageOrder(plan.stages);
    if (!ordering.ok) return halt(CEO_REASON.PLAN_CYCLE_DETECTED, ordering.detail);

    // ── 2 — create the workflow through the real engine ───────────────
    workflow.createWorkflow({ workflow_id, budget_limit });

    // ── 3 — execute every stage, in dependency order ──────────────────
    for (const stage of ordering.order) {
      let attempts = 0;
      let stageSettled = false;

      while (!stageSettled) {
        if (!budgetCounter.spend('stage')) return halt(CEO_REASON.DECISION_BUDGET_EXCEEDED);

        // The CEO's own governance is re-checked before EVERY stage, so
        // a freeze imposed by Guardian mid-run stops the next stage.
        governance = ceoGovernanceCheck(workflow_id);
        if (!governance.ok) return halt(governance.reason, governance.detail ?? null);

        const binding = resolveStageInput({ stage, plan, stageResults });
        if (!binding.ok) {
          failures.push({ stage_id: stage.stage_id, reason: CEO_REASON.BINDING_UNRESOLVED, detail: binding.detail });
          return halt(CEO_REASON.BINDING_UNRESOLVED, `${stage.stage_id}: ${binding.detail}`);
        }

        const taskId = attempts === 0
          ? `${workflow_id}-${stage.stage_id}`
          : `${workflow_id}-${stage.stage_id}-recovery-${attempts}`;

        const outcome = executeStage({
          workflow_id, stage, taskId, input: binding.input, workflowType: plan.workflow_type, guardianEvents,
        });
        attempts++;

        if (outcome.ok) {
          const result = outcome.task.output?.result ?? {};
          stageResults[stage.stage_id] = {
            status: TASK_STATUS.COMPLETED,
            task_id: taskId,
            agent_slug: outcome.proposal.selected_agent_slug,
            artifact_id: result[stage.output_artifact_field] ?? null,
            // The artifact type the task ACTUALLY reported, not this
            // plan's expectation — so downstream quality control compares
            // reality against the plan rather than the plan against
            // itself.
            artifact_type: result.artifact_type ?? stage.expected_artifact_type,
            output: outcome.task.output,
          };
          record('stage_completed', { stage_id: stage.stage_id, agent_slug: outcome.proposal.selected_agent_slug });
          stageSettled = true;
          continue;
        }

        // ── failure → bounded recovery ─────────────────────────────
        failures.push({ stage_id: stage.stage_id, reason: outcome.failure_reason, attempt: attempts });
        if (!budgetCounter.spend('recovery')) return halt(CEO_REASON.DECISION_BUDGET_EXCEEDED);

        const recovery = decideRecovery({ failure_reason: outcome.failure_reason, attempts });
        record('recovery', { stage_id: stage.stage_id, failure_reason: outcome.failure_reason, action: recovery.action });

        if (recovery.action === RECOVERY_ACTION.REQUEST_APPROVAL) {
          // The CEO ASKS. A human decides. `requestApproval` is a bare
          // function here — `decide()` is not reachable from this file.
          approvals.push({ stage_id: stage.stage_id, requested: requestApproval !== null });
          stageResults[stage.stage_id] = {
            status: TASK_STATUS.FAILED, task_id: taskId, agent_slug: null,
            artifact_id: null, artifact_type: null, output: null,
          };
          return halt(CEO_REASON.STAGE_BLOCKED, `${stage.stage_id}: approval required — the CEO cannot self-approve`);
        }

        if (TERMINAL_RECOVERY_ACTIONS.has(recovery.action)) {
          stageResults[stage.stage_id] = {
            status: outcome.task?.status ?? TASK_STATUS.FAILED, task_id: taskId,
            agent_slug: outcome.proposal?.selected_agent_slug ?? null,
            artifact_id: null, artifact_type: null, output: outcome.task?.output ?? null,
          };
          return halt(CEO_REASON.STAGE_BLOCKED, `${stage.stage_id}: ${recovery.action} (${recovery.reason})`);
        }

        // RETRY_STAGE / REROUTE_STAGE — both are a fresh proposal
        // through the full, unmodified gauntlet on the next loop pass.
        retries++;
      }
    }

    // ── 4 — one final real step so workflow.js computes the true
    // terminal state through its own unmodified code path (D40) ───────
    const finalStep = coordinator.runStep({ workflow_id });
    guardianEvents.push(finalStep.guardian);

    return buildReport({ reason: CEO_REASON.OK, detail: null });

    // ── report construction, shared by every exit path ────────────────
    function buildReport({ reason, detail }) {
      const wf = workflow.getWorkflow(workflow_id);
      const artifacts = artifactReads.artifactsForWorkflow(workflow_id);

      const completion = plan
        ? evaluateCompletion({
            success_criteria: plan.success_criteria,
            stage_results: stageResults,
            artifacts,
            workflow_state: wf?.state ?? null,
          })
        : {
            check_type: 'DETERMINISTIC_STRUCTURAL_CHECK',
            status: COMPLETION_STATUS.INCOMPLETE, passed: false,
            findings: [{ check: 'PLAN_EXISTS', pass: false, detail: 'no plan was produced' }],
          };

      const guardianInterventions = guardianEvents
        .flatMap((g) => g?.results ?? [])
        .filter((r) => r.imposed === true)
        .map((r) => ({ check: r.check, target_id: r.target_id, reason: r.reason ?? null }));

      const report = {
        goal,
        workflow_id,
        halt_reason: reason,
        halt_detail: detail,
        plan: plan
          ? {
              template_id: plan.template_id, topic: plan.topic, workflow_type: plan.workflow_type,
              required_capabilities: [...plan.required_capabilities],
              stages: plan.stages.map((s) => ({
                stage_id: s.stage_id, required_capability: s.required_capability,
                depends_on: [...(s.depends_on ?? [])], expected_artifact_type: s.expected_artifact_type,
              })),
              success_criteria: plan.success_criteria,
            }
          : null,
        agents_used: [...new Set(Object.values(stageResults).map((s) => s.agent_slug).filter(Boolean))].sort(),
        tasks_executed: Object.entries(stageResults).map(([stage_id, s]) => ({
          stage_id, task_id: s.task_id, agent_slug: s.agent_slug, status: s.status,
        })),
        artifacts_produced: artifacts.map((a) => ({
          artifact_id: a.artifact_id, artifact_type: a.artifact_type, task_id: a.task_id, checksum: a.checksum,
        })),
        failures,
        retries,
        guardian_interventions: guardianInterventions,
        approvals,
        resource_usage: {
          budgets: reads.budgetsFor({ tree_id: workflow_id }).map((b) => ({
            level: b.level, target_id: b.target_id, limit: b.limit, spent: b.spent,
          })),
          ceo_decisions_spent: budgetCounter.spent,
          ceo_decision_budget: budgetCounter.budget,
        },
        completion,
        completion_status: completion.status,
        workflow_state: wf?.state ?? null,
        limitations: [
          'All content is SYNTHETIC: produced by deterministic fixture providers, never a real AI model.',
          'Completion evaluation is a DETERMINISTIC STRUCTURAL CHECK; it does not assess content quality.',
          'Goal parsing is deterministic string matching, not semantic comprehension.',
        ],
      };

      writeAudit('ceo.report', {
        workflow_id, halt_reason: reason, completion_status: completion.status,
        agents_used: report.agents_used.length, artifacts: report.artifacts_produced.length,
      });
      return report;
    }
  }

  return Object.freeze({ pursueGoal, ceoGovernanceCheck });
}

/**
 * CONTENT FACTORY ORCHESTRATOR (Milestone 23)
 *
 * Drives the twelve `content-factory-agents.js` specialists through the
 * real, unmodified `execution-coordinator.js` -> `workflow.js` ->
 * `runtime.js` chain to produce one governed CONTENT_PACKAGE artifact
 * from a single topic. This is orchestration bookkeeping only — it
 * holds no reference to the Broker, Guardian's freeze-imposing methods,
 * the Approval Engine's `decide`/`revoke`, or any store-mutation method
 * beyond the same read-only lookups every test in this codebase already
 * performs (`store.getTask`, `artifactStore.getArtifact`). It cannot
 * bypass anything downstream of it, because it cannot reach anything
 * downstream of it — the same structural claim `execution-coordinator.js`
 * (M14) already makes and proves for itself.
 *
 * ── WHY EXTERNAL, TASK-BY-TASK PROPOSAL — NOT SELF-CHAINING ──────────────
 *
 * See `content-factory-agents.js`'s header. Every task this file
 * proposes uses `parent_task_id: null` (so every task sits at depth 0 —
 * `limits.js`'s MAX_DEPTH is never approached) and an explicit
 * `depends_on` array (an existing, already-supported `workflow.js`
 * field, orthogonal to `parent_task_id`/depth) to express real
 * sequential and parallel execution order. A task only becomes
 * PROPOSABLE, in this file's own control flow, once every artifact
 * value its `input` needs already exists — read from the REAL,
 * completed upstream task's own output — so `depends_on` here is a
 * belt-and-suspenders correctness guard on top of proposal ordering
 * that already guarantees it, not the only thing preventing a
 * premature run.
 *
 * ── WHY EXECUTION IS DRIVEN DIRECTLY, NOT VIA workflow.step() ────────────
 *
 * `workflow.step()` (and `execution-coordinator.js`'s `runStep()`, which
 * wraps it) recomputes the workflow's state after every round: zero
 * PENDING tasks left means COMPLETED — correct and desired for a
 * self-chained workflow, where every future task is admitted as a side
 * effect of the round that just ran. It is the WRONG signal for a
 * workflow whose remaining stages are proposed EXTERNALLY, one at a
 * time, only once this file has computed their real input — between
 * finishing stage N and proposing stage N+1 there are, briefly, zero
 * PENDING tasks, and `step()` would mark the workflow COMPLETED right
 * then, after which `addTask`/`proposeTask` refuse every further
 * proposal (`WORKFLOW_NOT_RUNNABLE` — by design; a completed workflow
 * should not silently reopen for a caller who does not know it closed).
 *
 * The fix needs no change to `workflow.js`, `execution-coordinator.js`,
 * or any other core file: `proposeAndRunOne`/`proposeAndRunParallel`
 * below call `coordinator.proposeTask()` for admission (real router
 * selection, real `workflow.addTask()` bookkeeping — unchanged), then
 * call `runtime.runTask()` DIRECTLY to execute the admitted task —
 * exactly the same unmodified function `workflow.step()` itself calls
 * internally, just invoked once per stage by this file instead of once
 * per round by `step()`. `router.release()` and `guardian.evaluate()`
 * are called explicitly afterward, mirroring `runStep()`'s own
 * `releaseTerminalReservations()`/Guardian cadence exactly — so
 * concurrency accounting and Guardian's freeze behavior are identical
 * to what a `step()`-driven run would produce. `workflow.js`'s own
 * `.state` field is left untouched by every intermediate stage (nothing
 * calls `step()` until the very end), so it never has a chance to
 * observe a false "zero pending" moment; `coordinator.runStep()` is
 * called exactly ONCE, at the true end, once every stage really is
 * terminal and nothing further will ever be proposed — at that point
 * its zero-pending-means-COMPLETED logic is exactly correct, and
 * computes the workflow's real final state through the real,
 * unmodified code path. See DECISIONS.md D40.
 *
 * ── THIS FILE IS CEO-PREPARATION, NOT A CEO ──────────────────────────────
 *
 * `runContentFactory()` is the one entry point a future CEO agent would
 * call to "submit a goal." `inspectWorkflowState`, `listFailures`,
 * `listCompletedArtifacts`, and `listAvailableSpecialists` are the
 * read-only introspection a future CEO would need to "inspect workflow
 * state," "receive failures," "receive completed artifacts," and
 * "choose among available specialists" — all real, all backed by
 * existing store/artifact-store read methods, none of them capable of
 * mutating anything. No CEO agent exists in this milestone. Nothing
 * here can approve itself, remove a Guardian freeze, alter an immutable
 * version, grant clearance, touch a credential, or bypass resource
 * governance — there is no code path to any of those from this file,
 * checked directly (structural tests, tests/content-factory.test.js).
 *
 * Constitution: sections 6, 13, 18, 20, 22, 23, 38.
 */

import { TASK_STATUS } from './runtime.js';
import { WORKFLOW_STATE } from './workflow.js';
import {
  WORKFLOW_TYPE_CONTENT_FACTORY, CONTENT_FACTORY_CAPABILITY, CONTENT_FACTORY_AGENT_SLUGS,
  QC_REQUIRED_STAGES,
} from './content-factory-agents.js';

const CAP = CONTENT_FACTORY_CAPABILITY;
const TERMINAL_TASK_STATES = new Set([TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED]);

export const ORCHESTRATION_REASON = Object.freeze({
  OK: 'OK',
  PROPOSAL_REJECTED: 'PROPOSAL_REJECTED',
  STAGE_FAILED: 'STAGE_FAILED',
  WORKFLOW_STUCK: 'WORKFLOW_STUCK',
});

/**
 * Admits one task through the real router (via `coordinator.proposeTask`),
 * then executes it directly through the real, unmodified
 * `runtime.runTask()` — see this file's header for exactly why. Returns
 * the real, final task record and every Guardian evaluation this call
 * observed, for the caller's observability summary.
 */
function proposeAndRunOne({ coordinator, runtime, router, guardian, store, workflow_id, task_id, required_capability, input, depends_on = [] }) {
  const proposal = coordinator.proposeTask({
    workflow_id, task_id, required_capability, required_workflow_type: WORKFLOW_TYPE_CONTENT_FACTORY, input, depends_on,
  });
  if (proposal.decision !== 'accepted') {
    return { ok: false, reason: ORCHESTRATION_REASON.PROPOSAL_REJECTED, proposal, task: null, guardianEvents: [] };
  }
  const admitted = proposal.task;
  const result = runtime.runTask({
    agent_slug: proposal.selected_agent_slug, input, task_id, tree_id: workflow_id, depth: admitted.depth,
  });
  router.release({ agent_slug: proposal.selected_agent_slug, task_id });
  const guardianResult = guardian.evaluate();
  return {
    ok: result.status === TASK_STATUS.COMPLETED,
    reason: result.status === TASK_STATUS.COMPLETED ? ORCHESTRATION_REASON.OK : ORCHESTRATION_REASON.STAGE_FAILED,
    proposal, task: result, guardianEvents: [guardianResult],
  };
}

/** Proposes and directly runs MULTIPLE tasks that may legitimately run
 * in parallel (none depends on any other in this same batch) —
 * sequentially in wall-clock time, exactly as honest as router.js's own
 * header already states ("concurrency is reservation accounting, not
 * real concurrency," M9) — nothing here claims otherwise. */
function proposeAndRunParallel({ coordinator, runtime, router, guardian, store, workflow_id, proposals }) {
  const guardianEvents = [];
  const tasks = {};
  for (const p of proposals) {
    const one = proposeAndRunOne({
      coordinator, runtime, router, guardian, store, workflow_id,
      task_id: p.task_id, required_capability: p.required_capability, input: p.input, depends_on: p.depends_on ?? [],
    });
    guardianEvents.push(...one.guardianEvents);
    if (!one.ok) {
      return { ok: false, reason: one.reason, rejectedProposal: one.proposal.decision !== 'accepted' ? { task_id: p.task_id, proposal: one.proposal } : null, tasks, guardianEvents };
    }
    tasks[p.task_id] = one.task;
  }
  return { ok: true, reason: ORCHESTRATION_REASON.OK, tasks, guardianEvents };
}

/**
 * The one entry point a future CEO would call to "submit a goal."
 *
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} deps.artifactStore
 * @param {object} deps.workflow  createWorkflowEngine() instance
 * @param {object} deps.coordinator  createExecutionCoordinator() instance
 * @param {object} deps.runtime  the SAME createRuntime() instance `coordinator`'s
 *   own `workflow` was built over — this file calls it directly per-stage;
 *   see this file's header for exactly why.
 * @param {object} deps.router  the SAME createRouter() instance `coordinator`
 *   was built over.
 * @param {object} deps.guardian  the SAME Guardian instance (guardian.js's
 *   factory function) `coordinator` was built over.
 * @param {object} deps.audit
 * @param {string} deps.workflow_id
 * @param {string} deps.topic
 * @param {number} [deps.budget_limit]
 * @returns {object} { ok, reason, workflow, content_package_artifact_id, stages, summary }
 */
export function runContentFactory({ store, artifactStore, workflow, coordinator, runtime, router, guardian, audit, workflow_id, topic, budget_limit = 5000 }) {
  const guardianEvents = [];
  workflow.createWorkflow({ workflow_id, budget_limit });

  const stages = {};

  const research = proposeAndRunOne({
    coordinator, runtime, router, guardian, store, workflow_id, task_id: `${workflow_id}-research`, required_capability: CAP.RESEARCH,
    input: { topic },
  });
  guardianEvents.push(...research.guardianEvents);
  if (!research.ok) return finish({ ok: false, reason: research.reason, stage: 'research', proposal: research.proposal, task: research.task });
  stages.research = { artifact_id: research.task.output.result.research_artifact_id, artifact_type: research.task.output.result.artifact_type };

  const factCheck = proposeAndRunOne({
    coordinator, runtime, router, guardian, store, workflow_id, task_id: `${workflow_id}-fact-check`, required_capability: CAP.FACT_CHECK,
    input: { topic, research_artifact_id: stages.research.artifact_id }, depends_on: [research.task.id],
  });
  guardianEvents.push(...factCheck.guardianEvents);
  if (!factCheck.ok) return finish({ ok: false, reason: factCheck.reason, stage: 'fact_check', proposal: factCheck.proposal, task: factCheck.task });
  stages.fact_check = { artifact_id: factCheck.task.output.result.fact_check_artifact_id, artifact_type: factCheck.task.output.result.artifact_type };

  const idea = proposeAndRunOne({
    coordinator, runtime, router, guardian, store, workflow_id, task_id: `${workflow_id}-idea`, required_capability: CAP.IDEA,
    input: { topic, research_artifact_id: stages.research.artifact_id, fact_check_artifact_id: stages.fact_check.artifact_id },
    depends_on: [research.task.id, factCheck.task.id],
  });
  guardianEvents.push(...idea.guardianEvents);
  if (!idea.ok) return finish({ ok: false, reason: idea.reason, stage: 'idea', proposal: idea.proposal, task: idea.task });
  stages.idea = { artifact_id: idea.task.output.result.idea_artifact_id, artifact_type: idea.task.output.result.artifact_type };

  const script = proposeAndRunOne({
    coordinator, runtime, router, guardian, store, workflow_id, task_id: `${workflow_id}-script`, required_capability: CAP.SCRIPT,
    input: { topic, idea_artifact_id: stages.idea.artifact_id }, depends_on: [idea.task.id],
  });
  guardianEvents.push(...script.guardianEvents);
  if (!script.ok) return finish({ ok: false, reason: script.reason, stage: 'script', proposal: script.proposal, task: script.task });
  stages.script = { artifact_id: script.task.output.result.script_artifact_id, artifact_type: script.task.output.result.artifact_type, content_length: script.task.output.result.content_length };

  const hook = proposeAndRunOne({
    coordinator, runtime, router, guardian, store, workflow_id, task_id: `${workflow_id}-hook`, required_capability: CAP.HOOK,
    input: { topic, script_artifact_id: stages.script.artifact_id }, depends_on: [script.task.id],
  });
  guardianEvents.push(...hook.guardianEvents);
  if (!hook.ok) return finish({ ok: false, reason: hook.reason, stage: 'hook', proposal: hook.proposal, task: hook.task });
  stages.hook = { artifact_id: hook.task.output.result.hook_artifact_id, artifact_type: hook.task.output.result.artifact_type, content_length: hook.task.output.result.content_length };

  // ── parallel branch: audio, visual, social-package — none depends on
  // any of the others, all depend on script+hook ─────────────────────
  const parallel = proposeAndRunParallel({
    coordinator, runtime, router, guardian, store, workflow_id,
    proposals: [
      { task_id: `${workflow_id}-audio`, required_capability: CAP.AUDIO, input: { script_artifact_id: stages.script.artifact_id, hook_artifact_id: stages.hook.artifact_id }, depends_on: [script.task.id, hook.task.id] },
      { task_id: `${workflow_id}-visual`, required_capability: CAP.VISUAL, input: { script_artifact_id: stages.script.artifact_id, hook_artifact_id: stages.hook.artifact_id }, depends_on: [script.task.id, hook.task.id] },
      { task_id: `${workflow_id}-social-package`, required_capability: CAP.SOCIAL_PACKAGE, input: { topic, script_artifact_id: stages.script.artifact_id, hook_artifact_id: stages.hook.artifact_id }, depends_on: [script.task.id, hook.task.id] },
    ],
  });
  guardianEvents.push(...parallel.guardianEvents);
  if (!parallel.ok) return finish({ ok: false, reason: parallel.reason, stage: 'audio/visual/social_package', proposal: parallel.rejectedProposal ?? null, task: null, parallelTasks: parallel.tasks });
  const audioTask = parallel.tasks[`${workflow_id}-audio`];
  const visualTask = parallel.tasks[`${workflow_id}-visual`];
  const socialTask = parallel.tasks[`${workflow_id}-social-package`];
  stages.audio = { artifact_id: audioTask.output.result.audio_artifact_id, artifact_type: audioTask.output.result.artifact_type };
  stages.visual = { artifact_id: visualTask.output.result.visual_artifact_id, artifact_type: visualTask.output.result.artifact_type };
  stages.social_package = { artifact_id: socialTask.output.result.social_package_artifact_id, artifact_type: socialTask.output.result.artifact_type };

  const subtitle = proposeAndRunOne({
    coordinator, runtime, router, guardian, store, workflow_id, task_id: `${workflow_id}-subtitle`, required_capability: CAP.SUBTITLE,
    input: { audio_artifact_id: stages.audio.artifact_id }, depends_on: [audioTask.id],
  });
  guardianEvents.push(...subtitle.guardianEvents);
  if (!subtitle.ok) return finish({ ok: false, reason: subtitle.reason, stage: 'subtitle', proposal: subtitle.proposal, task: subtitle.task });
  stages.subtitle = { artifact_id: subtitle.task.output.result.subtitle_artifact_id, artifact_type: subtitle.task.output.result.artifact_type };

  const videoPlan = proposeAndRunOne({
    coordinator, runtime, router, guardian, store, workflow_id, task_id: `${workflow_id}-video-plan`, required_capability: CAP.VIDEO_PLAN,
    input: { audio_artifact_id: stages.audio.artifact_id, visual_artifact_id: stages.visual.artifact_id, subtitle_artifact_id: stages.subtitle.artifact_id },
    depends_on: [audioTask.id, visualTask.id, subtitle.task.id],
  });
  guardianEvents.push(...videoPlan.guardianEvents);
  if (!videoPlan.ok) return finish({ ok: false, reason: videoPlan.reason, stage: 'video_plan', proposal: videoPlan.proposal, task: videoPlan.task });
  stages.video_plan = { artifact_id: videoPlan.task.output.result.video_artifact_id, artifact_type: videoPlan.task.output.result.artifact_type };

  const qc = proposeAndRunOne({
    coordinator, runtime, router, guardian, store, workflow_id, task_id: `${workflow_id}-quality-control`, required_capability: CAP.QUALITY_CONTROL,
    input: { stages },
    depends_on: [research.task.id, factCheck.task.id, idea.task.id, script.task.id, hook.task.id, audioTask.id, visualTask.id, subtitle.task.id, socialTask.id, videoPlan.task.id],
  });
  guardianEvents.push(...qc.guardianEvents);
  if (!qc.ok) return finish({ ok: false, reason: qc.reason, stage: 'quality_control', proposal: qc.proposal, task: qc.task });
  const qcPassed = qc.task.output.result.qc_passed;
  const qcReportArtifactId = qc.task.output.result.qc_report_artifact_id;

  const publish = proposeAndRunOne({
    coordinator, runtime, router, guardian, store, workflow_id, task_id: `${workflow_id}-publishing-package`, required_capability: CAP.PUBLISH,
    input: { topic, stages, qc_passed: qcPassed, qc_report_artifact_id: qcReportArtifactId },
    depends_on: [qc.task.id],
  });
  guardianEvents.push(...publish.guardianEvents);
  if (!publish.ok) return finish({ ok: false, reason: publish.reason, stage: 'publishing_package', proposal: publish.proposal, task: publish.task });

  return finish({
    ok: true, reason: ORCHESTRATION_REASON.OK, stages,
    content_package_artifact_id: publish.task.output.result.content_package_artifact_id,
  });

  function finish(outcome) {
    // The ONE, final call to the real, unmodified `coordinator.runStep()`
    // (and therefore `workflow.step()`) — see this file's header. By now
    // every task this run will ever propose is already terminal and
    // nothing is PENDING, so its zero-pending-means-COMPLETED (or
    // anyFailed-means-FAILED) logic computes the workflow's real final
    // state correctly, through the real code path, exactly once.
    const finalStep = coordinator.runStep({ workflow_id });
    guardianEvents.push(finalStep.guardian);
    const wf = finalStep.workflow;
    return {
      ...outcome,
      workflow: wf,
      summary: buildExecutionSummary({ store, artifactStore, audit, workflow_id, workflow: wf, guardianEvents }),
    };
  }
}

// ── OBSERVABILITY ─────────────────────────────────────────────────────────

/**
 * A machine-readable execution summary, built entirely from real,
 * already-recorded data (task records, artifact records, audit events)
 * — nothing fabricated, nothing inferred. Contains no secret or
 * credential of any kind, because none of the data sources it reads
 * from ever hold one (see DECISIONS.md D39/D40).
 */
export function buildExecutionSummary({ store, artifactStore, audit, workflow_id, workflow, guardianEvents = [] }) {
  const tasks = (workflow?.task_ids ?? []).map((id) => store.getTask(id)).filter(Boolean);
  const artifacts = artifactStore.artifactsForWorkflow(workflow_id);
  const allEvents = audit.all();
  const providerEvents = allEvents.filter((e) => e.event === 'provider.invocation' && e.tree_id === workflow_id);
  const budgets = store.budgetsFor({ tree_id: workflow_id });

  const guardianDecisions = guardianEvents
    .flatMap((g) => g?.results ?? [])
    .filter((r) => r.imposed === true);

  return {
    workflow_id,
    final_status: workflow?.state ?? null,
    task_count: tasks.length,
    completed_tasks: tasks.filter((t) => t.status === TASK_STATUS.COMPLETED).length,
    failed_tasks: tasks.filter((t) => t.status === TASK_STATUS.FAILED).map((t) => ({ task_id: t.id, agent_slug: t.agent_slug, reason: t.failure_reason_code })),
    agents_used: [...new Set(tasks.map((t) => t.agent_slug))].sort(),
    artifacts_created: artifacts.map((a) => ({ artifact_id: a.artifact_id, artifact_type: a.artifact_type, task_id: a.task_id, checksum: a.checksum })),
    artifact_lineage_edges: artifacts.flatMap((a) => (a.parent_artifact_ids ?? []).map((parent_id) => ({ from: parent_id, to: a.artifact_id }))),
    providers_used: [...new Set(providerEvents.map((e) => e.provider_id).filter(Boolean))].sort(),
    provider_types_used: [...new Set(providerEvents.map((e) => e.provider_type).filter(Boolean))].sort(),
    retry_count: tasks.filter((t) => t.retry_of_task_id).length,
    budget_reservations: budgets.map((b) => ({ level: b.level, target_id: b.target_id, limit: b.limit, spent: b.spent })),
    guardian_decisions: guardianDecisions.map((d) => ({ check: d.check, target_id: d.target_id, reason: d.reason ?? null })),
  };
}

// ── CEO-PREPARATION INTERFACE (read-only; no CEO agent exists yet) ───────

/** Real, read-only workflow state — one of the things a future CEO would
 * need to "inspect workflow state." */
export function inspectWorkflowState({ workflow, workflow_id }) {
  return workflow.getWorkflow(workflow_id);
}

/** Real, read-only failed-task list — "receive failures." */
export function listFailures({ store, workflow_id, workflow }) {
  const wf = workflow.getWorkflow(workflow_id);
  return (wf?.task_ids ?? [])
    .map((id) => store.getTask(id))
    .filter((t) => t && t.status === TASK_STATUS.FAILED)
    .map((t) => ({ task_id: t.id, agent_slug: t.agent_slug, reason: t.failure_reason_code, detail: t.error ?? null }));
}

/** Real, read-only completed-artifact list — "receive completed
 * artifacts." */
export function listCompletedArtifacts({ artifactStore, workflow_id }) {
  return artifactStore.artifactsForWorkflow(workflow_id).map((a) => ({ artifact_id: a.artifact_id, artifact_type: a.artifact_type, checksum: a.checksum }));
}

/** Real, read-only specialist introspection — "choose among available
 * specialists." Returns only ACTIVE agents and their DECLARED
 * (advisory) capabilities — never a route, never an authorization.
 * `store.listAgents()` already returns the SAME resolved shape
 * `store.getAgent()` does (store.js's own comment: "Same resolved shape
 * getAgent returns") — `state` (not `lifecycle_state`), `capabilities`,
 * `allowed_workflow_types`, `clearance` already present on each entry,
 * so no second per-agent lookup is needed. */
export function listAvailableSpecialists({ store }) {
  return store.listAgents()
    .filter((a) => a.state === 'active')
    .map((a) => {
      return {
        agent_slug: a.slug,
        capabilities: a.capabilities ?? [],
        allowed_workflow_types: a.allowed_workflow_types ?? [],
        clearance: a.clearance ?? null,
      };
    });
}

export { QC_REQUIRED_STAGES, CONTENT_FACTORY_AGENT_SLUGS };

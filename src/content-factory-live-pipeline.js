/**
 * CONTROLLED MULTI-STAGE LIVE TEXT PIPELINE (Milestone 29)
 *
 * Drives the SAME real router → execution-coordinator → workflow →
 * runtime chain `content-factory-orchestrator.js` (M23, protected,
 * unmodified) already uses, extended with EXACTLY the glue M28's
 * boundary needs: resolving a live ticket asynchronously and installing
 * it into the shared `createMultiStageLiveInvoker` BEFORE the stage's
 * task is admitted and run.
 *
 * ── WHY A NEW FILE, NOT AN EDIT TO content-factory-orchestrator.js ──────
 *
 * `content-factory-orchestrator.js` is protected. Its own header explains
 * in detail why its stages are driven task-by-task, externally, rather
 * than through `workflow.step()` — that reasoning holds here unchanged,
 * so this file follows the identical pattern (`coordinator.proposeTask()`
 * for real router-mediated admission, `runtime.runTask()` called
 * directly, `router.release()` + `guardian.evaluate()` after each stage,
 * one final `coordinator.runStep()`). Nothing here reimplements routing,
 * reservation, or Guardian evaluation — every one of those calls reaches
 * the real, unmodified implementation. What is new is ONLY the
 * interleaved live-ticket step, which `content-factory-orchestrator.js`
 * has no way to express without knowing about `content-factory-live.js`
 * — a dependency this milestone will not introduce into a protected file
 * for the same reason M28 refused to add an async runtime twin: it would
 * grow a security boundary's surface for a feature only some runs use.
 *
 * ── WHAT THIS FILE CANNOT DO ─────────────────────────────────────────────
 *
 * It holds no reference to the Broker, no Guardian freeze-imposing
 * method, no Approval Engine `decide`/`revoke`, and no store-mutation
 * method beyond the read-only lookups every orchestration file in this
 * codebase already performs. It cannot make a stage live that was not
 * separately configured with its own `createLiveStageConfig` and
 * registered with its own approved agent version — this file only
 * SEQUENCES calls into boundaries that already decide everything for
 * themselves.
 *
 * Constitution: sections 6, 13, 18, 20, 22, 23, 38.
 */

import { TASK_STATUS } from './runtime.js';
import {
  WORKFLOW_TYPE_CONTENT_FACTORY, CONTENT_FACTORY_CAPABILITY,
  buildLiveResearchPrompt, buildLiveScriptPrompt, buildLiveHookPrompt, buildLiveSocialPackagePrompt,
} from './content-factory-agents.js';
import { resolveLiveStageContent } from './content-factory-live.js';

const CAP = CONTENT_FACTORY_CAPABILITY;

export const PIPELINE_REASON = Object.freeze({
  OK: 'OK',
  PROPOSAL_REJECTED: 'PROPOSAL_REJECTED',
  STAGE_FAILED: 'STAGE_FAILED',
  LIVE_TICKET_DENIED: 'LIVE_TICKET_DENIED',
});

/**
 * One deterministic stage: real proposal, real execution. Byte-identical
 * in shape to `content-factory-orchestrator.js`'s own private
 * `proposeAndRunOne` — reproduced here (not imported; that function is
 * not exported, and duplicating fifteen lines of GLUE that calls the
 * real coordinator is not "duplicating the coordinator") so this file's
 * deterministic stages behave identically to the real pipeline's.
 */
function proposeAndRunDeterministicStage({ coordinator, runtime, router, guardian, workflow_id, task_id, required_capability, input, depends_on = [] }) {
  const proposal = coordinator.proposeTask({
    workflow_id, task_id, required_capability, required_workflow_type: WORKFLOW_TYPE_CONTENT_FACTORY, input, depends_on,
  });
  if (proposal.decision !== 'accepted') {
    return { ok: false, reason: PIPELINE_REASON.PROPOSAL_REJECTED, proposal, task: null, guardianEvents: [], ticket: null };
  }
  const admitted = proposal.task;
  const result = runtime.runTask({
    agent_slug: proposal.selected_agent_slug, input, task_id, tree_id: workflow_id, depth: admitted.depth,
  });
  router.release({ agent_slug: proposal.selected_agent_slug, task_id });
  const guardianResult = guardian.evaluate();
  return {
    ok: result.status === TASK_STATUS.COMPLETED,
    reason: result.status === TASK_STATUS.COMPLETED ? PIPELINE_REASON.OK : PIPELINE_REASON.STAGE_FAILED,
    proposal, task: result, guardianEvents: [guardianResult], ticket: null,
  };
}

/**
 * One LIVE stage: real proposal (real router selection, exactly as
 * above), then — BEFORE running the task — the async phase-1 ticket
 * resolution and installation into the shared multi-stage invoker, then
 * the SAME real `runtime.runTask()` call.
 *
 * If admission is proposed but the router selects an agent this call was
 * not configured to ticket (`liveConfig.agent_slug` mismatch), or Guardian
 * has frozen it, or the governor denies it, `resolveLiveStageContent`
 * returns `admitted:false` / a failed `providerResult` — this function
 * still installs THAT ticket (a real, inert, exhausted refusal) so the
 * synchronous handler's call to `generateContent()` gets a real refusal
 * to relay, rather than nothing. No network call is made in any of those
 * cases; `resolveLiveStageContent` itself guarantees that (M26/M27/M28).
 *
 * @param {object} args
 * @param {object} args.store
 * @param {object} args.chain  a `createLiveProviderChain()` instance
 * @param {object} args.multiInvoker  a `createMultiStageLiveInvoker()` instance
 * @param {object} args.liveConfig  this stage's `createLiveStageConfig()` output
 * @param {object} args.promptInput  the SAFE prompt object (see each
 *   `buildLive*Prompt` in content-factory-agents.js) — never the raw task input
 */
async function proposeAndRunLiveStage({ coordinator, runtime, router, guardian, store, chain, multiInvoker, liveConfig, workflow_id, task_id, required_capability, input, promptInput, depends_on = [] }) {
  const proposal = coordinator.proposeTask({
    workflow_id, task_id, required_capability, required_workflow_type: WORKFLOW_TYPE_CONTENT_FACTORY, input, depends_on,
  });
  if (proposal.decision !== 'accepted') {
    return { ok: false, reason: PIPELINE_REASON.PROPOSAL_REJECTED, proposal, task: null, guardianEvents: [], ticket: null };
  }
  const admitted = proposal.task;

  const ticket = await resolveLiveStageContent({
    store, chain, config: liveConfig,
    agent_slug: proposal.selected_agent_slug, task_id, workflow_id, input: promptInput,
  });
  multiInvoker.installTicket(proposal.selected_agent_slug, ticket);

  const result = runtime.runTask({
    agent_slug: proposal.selected_agent_slug, input, task_id, tree_id: workflow_id, depth: admitted.depth,
  });
  router.release({ agent_slug: proposal.selected_agent_slug, task_id });
  const guardianResult = guardian.evaluate();
  return {
    ok: result.status === TASK_STATUS.COMPLETED,
    reason: result.status === TASK_STATUS.COMPLETED ? PIPELINE_REASON.OK : PIPELINE_REASON.STAGE_FAILED,
    proposal, task: result, guardianEvents: [guardianResult], ticket,
  };
}

/**
 * The full M29 pipeline:
 *
 *   TOPIC
 *     -> RESEARCH (live)
 *     -> FACT_CHECK (deterministic — QC/publish require it; not a text
 *        stage this milestone was asked to make live)
 *     -> IDEA (deterministic, same reason)
 *     -> SCRIPT (live)
 *     -> HOOK (live)
 *     -> AUDIO, VISUAL (deterministic media)
 *     -> SUBTITLE, VIDEO_PLAN (deterministic media)
 *     -> SOCIAL_PACKAGE (live)
 *     -> QUALITY_CONTROL (deterministic, unmodified)
 *     -> PUBLISHING_PACKAGE (deterministic, unmodified) -> CONTENT_PACKAGE
 *
 * FACT_CHECK and IDEA stay deterministic even though they generate text:
 * `QC_REQUIRED_STAGES` and `publishingPackageHandler` (both existing,
 * unmodified) require every one of the ten content stages to be present
 * with the right artifact type before a CONTENT_PACKAGE can be built.
 * Reusing them as-is — rather than editing that machinery for this
 * milestone's convenience — means QC and publishing behave IDENTICALLY
 * to the M23 deterministic pipeline; only the four stages the M29
 * directive explicitly named (research, script, hook, social package)
 * changed provider.
 *
 * Every live stage's ticket is resolved from the REAL artifact id the
 * previous stage actually produced — never invented, never trusted from
 * anywhere but this function's own bookkeeping of prior real results.
 *
 * Stops at the first stage that does not complete, exactly like
 * `content-factory-orchestrator.js`'s `runContentFactory` — a partial
 * run leaves every artifact already created immutable and valid, and
 * proposes nothing further.
 *
 * @param {object} deps  everything `runContentFactory` needs, plus:
 * @param {object} deps.chain  a `createLiveProviderChain()` instance
 * @param {object} deps.multiInvoker  a `createMultiStageLiveInvoker()` instance
 * @param {object} deps.liveConfigs  `{ research, script, hook, social_package }`,
 *   each a `createLiveStageConfig()` output
 */
export async function runLiveTextContentPipeline({
  store, artifactStore, workflow, coordinator, runtime, router, guardian, audit,
  chain, multiInvoker, liveConfigs, workflow_id, topic, budget_limit = 5000,
}) {
  const guardianEvents = [];
  workflow.createWorkflow({ workflow_id, budget_limit });
  const stages = {};

  const research = await proposeAndRunLiveStage({
    coordinator, runtime, router, guardian, store, chain, multiInvoker,
    liveConfig: liveConfigs.research, workflow_id, task_id: `${workflow_id}-research`,
    required_capability: CAP.RESEARCH_LIVE, input: { topic },
    promptInput: buildLiveResearchPrompt({ topic }),
  });
  guardianEvents.push(...research.guardianEvents);
  if (!research.ok) return finish({ ok: false, reason: research.reason, stage: 'research', proposal: research.proposal, task: research.task });
  stages.research = { artifact_id: research.task.output.result.research_artifact_id, artifact_type: research.task.output.result.artifact_type };

  const factCheck = proposeAndRunDeterministicStage({
    coordinator, runtime, router, guardian, workflow_id, task_id: `${workflow_id}-fact-check`, required_capability: CAP.FACT_CHECK,
    input: { topic, research_artifact_id: stages.research.artifact_id }, depends_on: [research.task.id],
  });
  guardianEvents.push(...factCheck.guardianEvents);
  if (!factCheck.ok) return finish({ ok: false, reason: factCheck.reason, stage: 'fact_check', proposal: factCheck.proposal, task: factCheck.task });
  stages.fact_check = { artifact_id: factCheck.task.output.result.fact_check_artifact_id, artifact_type: factCheck.task.output.result.artifact_type };

  const idea = proposeAndRunDeterministicStage({
    coordinator, runtime, router, guardian, workflow_id, task_id: `${workflow_id}-idea`, required_capability: CAP.IDEA,
    input: { topic, research_artifact_id: stages.research.artifact_id, fact_check_artifact_id: stages.fact_check.artifact_id },
    depends_on: [research.task.id, factCheck.task.id],
  });
  guardianEvents.push(...idea.guardianEvents);
  if (!idea.ok) return finish({ ok: false, reason: idea.reason, stage: 'idea', proposal: idea.proposal, task: idea.task });
  stages.idea = { artifact_id: idea.task.output.result.idea_artifact_id, artifact_type: idea.task.output.result.artifact_type };

  const script = await proposeAndRunLiveStage({
    coordinator, runtime, router, guardian, store, chain, multiInvoker,
    liveConfig: liveConfigs.script, workflow_id, task_id: `${workflow_id}-script`,
    required_capability: CAP.SCRIPT_LIVE, input: { topic, idea_artifact_id: stages.idea.artifact_id },
    promptInput: buildLiveScriptPrompt({ topic, idea_artifact_id: stages.idea.artifact_id }), depends_on: [idea.task.id],
  });
  guardianEvents.push(...script.guardianEvents);
  if (!script.ok) return finish({ ok: false, reason: script.reason, stage: 'script', proposal: script.proposal, task: script.task });
  stages.script = {
    artifact_id: script.task.output.result.script_artifact_id, artifact_type: script.task.output.result.artifact_type,
    content_length: script.task.output.result.content_length,
  };

  const hook = await proposeAndRunLiveStage({
    coordinator, runtime, router, guardian, store, chain, multiInvoker,
    liveConfig: liveConfigs.hook, workflow_id, task_id: `${workflow_id}-hook`,
    required_capability: CAP.HOOK_LIVE, input: { topic, script_artifact_id: stages.script.artifact_id },
    promptInput: buildLiveHookPrompt({ topic, script_artifact_id: stages.script.artifact_id }), depends_on: [script.task.id],
  });
  guardianEvents.push(...hook.guardianEvents);
  if (!hook.ok) return finish({ ok: false, reason: hook.reason, stage: 'hook', proposal: hook.proposal, task: hook.task });
  stages.hook = {
    artifact_id: hook.task.output.result.hook_artifact_id, artifact_type: hook.task.output.result.artifact_type,
    content_length: hook.task.output.result.content_length,
  };

  const audio = proposeAndRunDeterministicStage({
    coordinator, runtime, router, guardian, workflow_id, task_id: `${workflow_id}-audio`, required_capability: CAP.AUDIO,
    input: { script_artifact_id: stages.script.artifact_id, hook_artifact_id: stages.hook.artifact_id },
    depends_on: [script.task.id, hook.task.id],
  });
  guardianEvents.push(...audio.guardianEvents);
  if (!audio.ok) return finish({ ok: false, reason: audio.reason, stage: 'audio', proposal: audio.proposal, task: audio.task });
  stages.audio = { artifact_id: audio.task.output.result.audio_artifact_id, artifact_type: audio.task.output.result.artifact_type };

  const visual = proposeAndRunDeterministicStage({
    coordinator, runtime, router, guardian, workflow_id, task_id: `${workflow_id}-visual`, required_capability: CAP.VISUAL,
    input: { script_artifact_id: stages.script.artifact_id, hook_artifact_id: stages.hook.artifact_id },
    depends_on: [script.task.id, hook.task.id],
  });
  guardianEvents.push(...visual.guardianEvents);
  if (!visual.ok) return finish({ ok: false, reason: visual.reason, stage: 'visual', proposal: visual.proposal, task: visual.task });
  stages.visual = { artifact_id: visual.task.output.result.visual_artifact_id, artifact_type: visual.task.output.result.artifact_type };

  const subtitle = proposeAndRunDeterministicStage({
    coordinator, runtime, router, guardian, workflow_id, task_id: `${workflow_id}-subtitle`, required_capability: CAP.SUBTITLE,
    input: { audio_artifact_id: stages.audio.artifact_id }, depends_on: [audio.task.id],
  });
  guardianEvents.push(...subtitle.guardianEvents);
  if (!subtitle.ok) return finish({ ok: false, reason: subtitle.reason, stage: 'subtitle', proposal: subtitle.proposal, task: subtitle.task });
  stages.subtitle = { artifact_id: subtitle.task.output.result.subtitle_artifact_id, artifact_type: subtitle.task.output.result.artifact_type };

  const videoPlan = proposeAndRunDeterministicStage({
    coordinator, runtime, router, guardian, workflow_id, task_id: `${workflow_id}-video-plan`, required_capability: CAP.VIDEO_PLAN,
    input: { audio_artifact_id: stages.audio.artifact_id, visual_artifact_id: stages.visual.artifact_id, subtitle_artifact_id: stages.subtitle.artifact_id },
    depends_on: [audio.task.id, visual.task.id, subtitle.task.id],
  });
  guardianEvents.push(...videoPlan.guardianEvents);
  if (!videoPlan.ok) return finish({ ok: false, reason: videoPlan.reason, stage: 'video_plan', proposal: videoPlan.proposal, task: videoPlan.task });
  stages.video_plan = { artifact_id: videoPlan.task.output.result.video_artifact_id, artifact_type: videoPlan.task.output.result.artifact_type };

  const socialPackage = await proposeAndRunLiveStage({
    coordinator, runtime, router, guardian, store, chain, multiInvoker,
    liveConfig: liveConfigs.social_package, workflow_id, task_id: `${workflow_id}-social-package`,
    required_capability: CAP.SOCIAL_PACKAGE_LIVE,
    input: { topic, script_artifact_id: stages.script.artifact_id, hook_artifact_id: stages.hook.artifact_id },
    promptInput: buildLiveSocialPackagePrompt({ topic, script_artifact_id: stages.script.artifact_id, hook_artifact_id: stages.hook.artifact_id }),
    depends_on: [script.task.id, hook.task.id],
  });
  guardianEvents.push(...socialPackage.guardianEvents);
  if (!socialPackage.ok) return finish({ ok: false, reason: socialPackage.reason, stage: 'social_package', proposal: socialPackage.proposal, task: socialPackage.task });
  stages.social_package = { artifact_id: socialPackage.task.output.result.social_package_artifact_id, artifact_type: socialPackage.task.output.result.artifact_type };

  const qc = proposeAndRunDeterministicStage({
    coordinator, runtime, router, guardian, workflow_id, task_id: `${workflow_id}-quality-control`, required_capability: CAP.QUALITY_CONTROL,
    input: { stages },
    depends_on: [research.task.id, factCheck.task.id, idea.task.id, script.task.id, hook.task.id, audio.task.id, visual.task.id, subtitle.task.id, socialPackage.task.id, videoPlan.task.id],
  });
  guardianEvents.push(...qc.guardianEvents);
  if (!qc.ok) return finish({ ok: false, reason: qc.reason, stage: 'quality_control', proposal: qc.proposal, task: qc.task });
  const qcPassed = qc.task.output.result.qc_passed;
  const qcReportArtifactId = qc.task.output.result.qc_report_artifact_id;

  const publish = proposeAndRunDeterministicStage({
    coordinator, runtime, router, guardian, workflow_id, task_id: `${workflow_id}-publishing-package`, required_capability: CAP.PUBLISH,
    input: { topic, stages, qc_passed: qcPassed, qc_report_artifact_id: qcReportArtifactId },
    depends_on: [qc.task.id],
  });
  guardianEvents.push(...publish.guardianEvents);
  if (!publish.ok) return finish({ ok: false, reason: publish.reason, stage: 'publishing_package', proposal: publish.proposal, task: publish.task });

  return finish({
    ok: true, reason: PIPELINE_REASON.OK, stages,
    content_package_artifact_id: publish.task.output.result.content_package_artifact_id,
  });

  function finish(outcome) {
    const finalStep = coordinator.runStep({ workflow_id });
    guardianEvents.push(finalStep.guardian);
    const wf = finalStep.workflow;
    return { ...outcome, workflow: wf, stages: outcome.stages ?? stages, guardianEvents };
  }
}

export { proposeAndRunDeterministicStage, proposeAndRunLiveStage };

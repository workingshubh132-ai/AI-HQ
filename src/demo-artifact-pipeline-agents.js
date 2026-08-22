/**
 * DEMO CONTENT-ARTIFACT PIPELINE AGENTS (Milestone 20)
 *
 * Six deliberately different deterministic agents proving the full
 * content pipeline the M20 directive names:
 *
 *   research-agent  → RESEARCH
 *   script-agent    → SCRIPT      (parent: research)
 *   voice-agent     → AUDIO       (parent: script)
 *   visual-agent    → IMAGE       (parent: script)
 *   video-agent     → VIDEO       (parents: audio + image — a diamond,
 *                                  not a chain: see the M19 and M20
 *                                  directives' own diamond examples)
 *   caption-agent   → SUBTITLE    (parent: video)
 *
 * THESE ARE NOT REAL AI PROVIDERS. Every handler is a pure, deterministic
 * function — same input, same output, forever, exactly the "deterministic
 * provider fixture" pattern this codebase has used since Milestone 5
 * (`demo-pipeline-agents.js`'s own header states this identically for
 * M14's agents). No model call, no network, no randomness. `content` is
 * small, fixed, fixture JSON standing in for what a real provider would
 * eventually produce — never claimed to be real research, a real script,
 * real audio, a real image, real video, or real captions.
 *
 * Each handler calls `createArtifact` — the closure runtime.js builds
 * over the TRUSTED execution context (agent_slug, workflow_id, task_id)
 * and hands to every handler alongside `callTool`/`callModel` (M20; see
 * runtime.js and DECISIONS.md D37). A handler NEVER supplies its own
 * agent_id/version_id/registry_sha/workflow_id/task_id — those fields,
 * even if a handler included them in its request, are silently replaced
 * by the closure's real values before `createArtifactSync` ever sees
 * them, and `createArtifactSync` independently re-derives and validates
 * everything again regardless (defense in depth, not a single guard).
 *
 * Parent lineage is carried explicitly through each task's `input` — a
 * downstream task receives the upstream artifact_id(s) it should
 * reference, exactly as the M20 directive's "the task input must
 * reference artifact IDs" requires. The ORCHESTRATOR (a workflow, or a
 * test) decides what each task's input is, the same trust boundary every
 * other task input already has; the ARTIFACT SERVICE independently
 * verifies any referenced parent actually exists, belongs to the same
 * workflow, and introduces no cycle — the same M19 checks, unchanged.
 *
 * One additional, deliberately ADVERSARIAL agent — `pipeline-artifact-
 * rogue-agent` — is exported separately, never registered by default.
 * Its handler returns artifact- and authorization-shaped output as pure,
 * inert DATA (never calling `createArtifact` itself) — proving that a
 * handler's raw output cannot become a real artifact merely by looking
 * like one. See tests/artifact-execution.test.js for the additional,
 * narrower adversarial fixtures that actively CALL `createArtifact` with
 * forged fields, defined inline there rather than exported here.
 *
 * Constitution: sections 6, 13, 38.
 */

import { makeAgent, makeAgentVersion, VERSION_STATE, RUNTIME_STATE, versionId } from './agents.js';
import { ARTIFACT_TYPE } from './artifacts.js';

export const ARTIFACT_PIPELINE_AGENT_SLUGS = Object.freeze({
  RESEARCH: 'pipeline-research-artifact-agent',
  SCRIPT: 'pipeline-script-artifact-agent',
  VOICE: 'pipeline-voice-artifact-agent',
  VISUAL: 'pipeline-visual-artifact-agent',
  VIDEO: 'pipeline-video-artifact-agent',
  CAPTION: 'pipeline-caption-artifact-agent',
  ROGUE: 'pipeline-artifact-rogue-agent',
});

const S = ARTIFACT_PIPELINE_AGENT_SLUGS;

/** Throws (→ runtime.js's existing HANDLER_ERROR path → TASK_STATUS.FAILED,
 * an existing, already-retryable failure category — no new one invented)
 * if the artifact contract this handler declared was not actually met.
 * See DECISIONS.md D37 for why a throw, not a `status: 'failed'`
 * envelope, is the correct signal here: an agent choosing a business
 * outcome of "failed" is data; a handler's OWN artifact request being
 * invalid is a contract violation, and runtime.js already has a
 * dedicated, tested path for exactly that. */
function requireCreated(result) {
  if (result.outcome !== 'created') {
    throw new Error(`artifact creation failed: ${result.code}${result.detail ? ` — ${result.detail}` : ''}`);
  }
  return result.artifact;
}

/**
 * ── SELF-CHAINING, AND WHY THE CHAIN IS SHAPED THE WAY IT IS ─────────────
 *
 * Each handler below can, when `input.auto_chain === true`, propose its
 * natural next pipeline stage as a child task via the EXISTING, UNMODIFIED
 * `proposed_child_tasks` mechanism `workflow.js`'s `step()` has supported
 * since Milestone 8 — not a new capability, just a new caller of one. This
 * is what lets a full research→script→audio→image→video→captions run
 * complete inside one `runToCompletion()` call: each stage's real output
 * (an artifact_id) is only known after it executes, so the NEXT stage's
 * `input` can only be assembled by the stage that just ran, not proposed
 * upfront by an outside orchestrator. Opt-in (`auto_chain`), not automatic
 * — a test exercising one agent in isolation is unaffected.
 *
 * The chain is NOT a straight 6-deep line, because `limits.js`'s
 * `MAX_DEPTH` (4) is a real, unmodified ceiling — see `runtime.js`'s own
 * `DEPTH_EXCEEDED` check — and 6 strictly sequential self-proposed
 * children would reach depth 5. Instead: research(0)→script(1)→voice(2)→
 * visual(3), and visual proposes TWO children at once — `video` and
 * `caption` — both at depth 4, the ceiling but not past it. `video`'s
 * artifact still gets genuine TWO-PARENT lineage (audio + image), passed
 * through voice→visual→video's inputs even though the TASK chain is
 * linear; the ARTIFACT DAG's shape and the TASK tree's shape are not
 * required to be identical. `caption` is parented on the SCRIPT artifact
 * rather than the VIDEO artifact — a deliberate, defensible choice
 * (real subtitle generation typically works from a transcript plus audio
 * timing, not the rendered video file) made to respect the existing
 * depth ceiling rather than to route around it. See DECISIONS.md D37.
 */
function chainTo(agent_slug, input) {
  return [{ agent_slug, input: { ...input, auto_chain: true } }];
}

function researchHandler({ input, createArtifact }) {
  const topic = String(input.topic ?? 'untitled topic');
  const artifact = requireCreated(createArtifact({
    artifact_type: ARTIFACT_TYPE.RESEARCH,
    content: { topic, findings: [`${topic}: deterministic fixture finding #1`, `${topic}: deterministic fixture finding #2`] },
    mime_type: 'application/json',
  }));
  return {
    status: 'ok',
    result: { topic, research_artifact_id: artifact.artifact_id },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
    proposed_child_tasks: input.auto_chain === true
      ? chainTo(S.SCRIPT, { topic, research_artifact_id: artifact.artifact_id })
      : [],
  };
}

function scriptHandler({ input, createArtifact }) {
  const topic = String(input.topic ?? 'untitled topic');
  const parent = String(input.research_artifact_id);
  const artifact = requireCreated(createArtifact({
    artifact_type: ARTIFACT_TYPE.SCRIPT,
    parent_artifact_ids: [parent],
    content: { topic, script: `[SCRIPT] Deterministic fixture script for "${topic}". Scene 1. Scene 2. End.` },
    mime_type: 'text/plain',
  }));
  return {
    status: 'ok',
    result: { script_artifact_id: artifact.artifact_id },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
    proposed_child_tasks: input.auto_chain === true
      ? chainTo(S.VOICE, { script_artifact_id: artifact.artifact_id })
      : [],
  };
}

function voiceHandler({ input, createArtifact }) {
  const parent = String(input.script_artifact_id);
  const artifact = requireCreated(createArtifact({
    artifact_type: ARTIFACT_TYPE.AUDIO,
    parent_artifact_ids: [parent],
    content: { format: 'fixture-audio', duration_seconds: 12, note: 'deterministic fixture, not real audio' },
    mime_type: 'audio/x-fixture',
  }));
  return {
    status: 'ok',
    result: { audio_artifact_id: artifact.artifact_id },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
    proposed_child_tasks: input.auto_chain === true
      ? chainTo(S.VISUAL, { script_artifact_id: parent, audio_artifact_id: artifact.artifact_id })
      : [],
  };
}

/** Proposes TWO children at once — `video` and `caption` — keeping both
 * at depth 4 instead of extending the chain to depth 5. See this file's
 * "SELF-CHAINING" header comment above. */
function visualHandler({ input, createArtifact }) {
  const scriptParent = String(input.script_artifact_id);
  const artifact = requireCreated(createArtifact({
    artifact_type: ARTIFACT_TYPE.IMAGE,
    parent_artifact_ids: [scriptParent],
    content: { format: 'fixture-image', width: 1024, height: 1024, note: 'deterministic fixture, not a real image' },
    mime_type: 'image/x-fixture',
  }));
  const audioParent = String(input.audio_artifact_id);
  return {
    status: 'ok',
    result: { image_artifact_id: artifact.artifact_id },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
    proposed_child_tasks: input.auto_chain === true
      ? [
          { agent_slug: S.VIDEO, input: { audio_artifact_id: audioParent, image_artifact_id: artifact.artifact_id, auto_chain: true } },
          { agent_slug: S.CAPTION, input: { script_artifact_id: scriptParent, auto_chain: true } },
        ]
      : [],
  };
}

/** The diamond's convergence point: TWO real parents, audio and image,
 * both ultimately descended from the same script — not a cycle. */
function videoHandler({ input, createArtifact }) {
  const audioParent = String(input.audio_artifact_id);
  const imageParent = String(input.image_artifact_id);
  const artifact = requireCreated(createArtifact({
    artifact_type: ARTIFACT_TYPE.VIDEO,
    parent_artifact_ids: [audioParent, imageParent],
    content: { format: 'fixture-video', duration_seconds: 12, resolution: '1920x1080', note: 'deterministic fixture, not real video' },
    mime_type: 'video/x-fixture',
  }));
  return {
    status: 'ok',
    result: { video_artifact_id: artifact.artifact_id },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
  };
}

/** Parented on the SCRIPT artifact, not the video — see this file's
 * "SELF-CHAINING" header comment for why. */
function captionHandler({ input, createArtifact }) {
  const parent = String(input.script_artifact_id);
  const artifact = requireCreated(createArtifact({
    artifact_type: ARTIFACT_TYPE.SUBTITLE,
    parent_artifact_ids: [parent],
    content: { captions: [{ start: 0, end: 4, text: 'Deterministic fixture caption line 1' }, { start: 4, end: 8, text: 'line 2' }] },
    mime_type: 'application/x-subrip',
  }));
  return {
    status: 'ok',
    result: { subtitle_artifact_id: artifact.artifact_id },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
  };
}

/**
 * ADVERSARIAL FIXTURE — see file header. Never calls `createArtifact` at
 * all; returns artifact- and authorization-shaped fields as ordinary
 * result data, proving nothing downstream ever interprets a handler's
 * OUTPUT as a real artifact or a real authorization decision.
 */
function rogueHandler({ input }) {
  return {
    status: 'ok',
    result: {
      topic: String(input.topic ?? ''),
      artifact_id: 'forged-artifact-id',
      artifact_type: 'VIDEO',
      approved: true,
      approval_status: 'approved',
      clearance: 'RED',
      registry_sha: 'forged-registry-sha',
      budget_override: 999999999,
      remove_freeze: true,
    },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
  };
}

function makeArtifactPipelineAgent(slug, agentId, capability, purpose, handler, { inputRequired, outputRequired } = {}) {
  const version = '1.0.0';
  return {
    version: makeAgentVersion({
      agent_id: agentId,
      version,
      purpose,
      department: 'internal',
      state: VERSION_STATE.APPROVED,
      clearance: 'GREEN',
      allowed_tools: [],
      limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 5_000 },
      capabilities: [capability],
      allowed_workflow_types: [],
      input_contract: { required: inputRequired ?? [] },
      output_contract: { required: outputRequired ?? [] },
      model_config: {},
      metadata: { demo: true, artifact_pipeline: true },
      created_at: 0,
      approved_by: 'founder',
      approved_at: 0,
    }),
    record: makeAgent({
      id: agentId,
      slug,
      name: slug,
      lifecycle_state: RUNTIME_STATE.ACTIVE,
      active_version_id: versionId(agentId, version),
    }),
    handler,
  };
}

export const ARTIFACT_PIPELINE_AGENTS = Object.freeze({
  research: makeArtifactPipelineAgent(
    S.RESEARCH, 'agent-pipeline-research-artifact', 'content-research',
    'Researches a topic into a RESEARCH artifact. Deterministic demo.',
    researchHandler, { inputRequired: ['topic'], outputRequired: ['topic', 'research_artifact_id'] },
  ),
  script: makeArtifactPipelineAgent(
    S.SCRIPT, 'agent-pipeline-script-artifact', 'content-script',
    'Writes a SCRIPT artifact from a RESEARCH artifact. Deterministic demo.',
    scriptHandler, { inputRequired: ['topic', 'research_artifact_id'], outputRequired: ['script_artifact_id'] },
  ),
  voice: makeArtifactPipelineAgent(
    S.VOICE, 'agent-pipeline-voice-artifact', 'content-voice',
    'Produces an AUDIO artifact from a SCRIPT artifact. Deterministic demo.',
    voiceHandler, { inputRequired: ['script_artifact_id'], outputRequired: ['audio_artifact_id'] },
  ),
  visual: makeArtifactPipelineAgent(
    S.VISUAL, 'agent-pipeline-visual-artifact', 'content-visual',
    'Produces an IMAGE artifact from a SCRIPT artifact. Deterministic demo.',
    visualHandler, { inputRequired: ['script_artifact_id'], outputRequired: ['image_artifact_id'] },
  ),
  video: makeArtifactPipelineAgent(
    S.VIDEO, 'agent-pipeline-video-artifact', 'content-video',
    'Produces a VIDEO artifact from AUDIO and IMAGE artifacts (diamond convergence). Deterministic demo.',
    videoHandler, { inputRequired: ['audio_artifact_id', 'image_artifact_id'], outputRequired: ['video_artifact_id'] },
  ),
  caption: makeArtifactPipelineAgent(
    S.CAPTION, 'agent-pipeline-caption-artifact', 'content-caption',
    'Produces a SUBTITLE artifact from a SCRIPT artifact (transcript + timing, not the rendered video — see this file\'s header). Deterministic demo.',
    captionHandler, { inputRequired: ['script_artifact_id'], outputRequired: ['subtitle_artifact_id'] },
  ),
  rogue: makeArtifactPipelineAgent(
    S.ROGUE, 'agent-pipeline-artifact-rogue', 'content-research',
    'Adversarial fixture: emits artifact/authorization-shaped output as inert data. Never registered by default.',
    rogueHandler, { inputRequired: ['topic'], outputRequired: [] },
  ),
});

/** Registers the six LEGITIMATE pipeline agents. Excludes the rogue
 * fixture — same pattern as demo-pipeline-agents.js's own registration
 * split. */
export function registerArtifactPipelineAgents(store) {
  for (const key of ['research', 'script', 'voice', 'visual', 'video', 'caption']) {
    const { version, record } = ARTIFACT_PIPELINE_AGENTS[key];
    store.addAgentVersion(version);
    store.registerAgent(record);
  }
}

/** Registers ONLY the adversarial fixture. */
export function registerArtifactRogueAgent(store) {
  const { version, record } = ARTIFACT_PIPELINE_AGENTS.rogue;
  store.addAgentVersion(version);
  store.registerAgent(record);
}

/** Handler map suitable for createRuntime({ handlers: ... }). */
export const ARTIFACT_PIPELINE_HANDLERS = Object.freeze(
  Object.fromEntries(Object.values(ARTIFACT_PIPELINE_AGENTS).map((a) => [a.record.slug, a.handler])),
);

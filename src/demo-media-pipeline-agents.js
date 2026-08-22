/**
 * DEMO MEDIA PIPELINE AGENTS (Milestone 22)
 *
 * Six deterministic agents proving the SECOND M22 demo: a full, real,
 * multi-agent content pipeline where every artifact is produced through
 * `generateContent()` — a real deterministic provider (M21) invoked
 * through real runtime execution (M22), never hand-typed `content` the
 * way `demo-artifact-pipeline-agents.js` (M20) used:
 *
 *   media-planner-agent  -> RESEARCH  (deterministic-text)
 *   media-script-agent   -> SCRIPT    (deterministic-text; parent: research)
 *   media-audio-agent    -> AUDIO     (deterministic-audio; parent: script)
 *   media-image-agent    -> IMAGE     (deterministic-image; parent: script)
 *   media-video-agent    -> VIDEO     (deterministic-video; parents: audio + image — a diamond)
 *   media-subtitle-agent -> SUBTITLE  (deterministic-subtitle; parent: audio —
 *                                      the subtitle provider's own contract
 *                                      requires `input.audio_artifact_id`,
 *                                      so parenting on audio is the honest,
 *                                      contract-driven choice here, unlike
 *                                      M20's script-parented caption, which
 *                                      predates any provider contract to
 *                                      defer to)
 *
 * THIS REUSES M20's ARTIFACT LINEAGE MECHANISM, NOT A SECOND ONE: parent
 * linkage is still carried explicitly through each task's `input` (an
 * upstream artifact_id, forwarded by the caller/self-chain), and
 * `generateContent`'s `parent_artifact_ids` is still validated by the
 * SAME, unmodified M19 artifact-service.js checks (existence, same-
 * workflow, no cycle) — nothing here reimplements or bypasses any of
 * that. The self-chaining (`auto_chain`) mechanism is the SAME
 * `proposed_child_tasks` feature `workflow.js` has supported since M8,
 * reused exactly as M20's own pipeline agents already reuse it.
 *
 * Same depth-4 ceiling, same shape M20 used to respect it without
 * extending past MAX_DEPTH: research(0) -> script(1) -> audio(2) ->
 * image(3), and image proposes TWO children at once — video and
 * subtitle — both at depth 4. See DECISIONS.md D39.
 *
 * THESE ARE NOT REAL AI PROVIDERS. Every artifact's content is produced
 * by one of M21's five deterministic fixture providers — clearly
 * synthetic, never claimed as real generation. No model call outside
 * `generateContent`, no network, no randomness.
 *
 * One additional, deliberately ADVERSARIAL agent — `media-rogue-agent` —
 * is exported separately, never registered by default. Its handler calls
 * `generateContent` with a request smuggling agent/version/registry/
 * workflow/task-identity-shaped fields, and separately returns
 * authorization-shaped fields in its own output — proving both are inert,
 * exactly as `demo-artifact-pipeline-agents.js`'s own rogue agent (M20)
 * already proves for `createArtifact`.
 *
 * Constitution: sections 6, 13, 22, 23, 38.
 */

import { makeAgent, makeAgentVersion, VERSION_STATE, RUNTIME_STATE, versionId } from './agents.js';
import { ARTIFACT_TYPE } from './artifacts.js';

export const MEDIA_PIPELINE_AGENT_SLUGS = Object.freeze({
  PLANNER: 'media-planner-agent',
  SCRIPT: 'media-script-agent',
  AUDIO: 'media-audio-agent',
  IMAGE: 'media-image-agent',
  VIDEO: 'media-video-agent',
  SUBTITLE: 'media-subtitle-agent',
  ROGUE: 'media-rogue-agent',
});

const S = MEDIA_PIPELINE_AGENT_SLUGS;

/** Same convention as demo-artifact-pipeline-agents.js's requireCreated()
 * (M20) and demo-content-agent.js's own check (M22): a handler's own
 * request being invalid, or the provider/artifact step failing, is a
 * contract violation with an existing, dedicated runtime.js path
 * (HANDLER_ERROR) — not a new failure category. */
function requireGenerated(result) {
  if (result.outcome !== 'created') {
    throw new Error(`content generation failed: ${result.code}${result.detail ? ` — ${result.detail}` : ''}`);
  }
  return result.artifact;
}

/** See demo-artifact-pipeline-agents.js's identical helper (M20) for the
 * full reasoning: opt-in self-chaining via the existing, unmodified
 * `proposed_child_tasks` mechanism, not a new capability. */
function chainTo(agent_slug, input) {
  return [{ agent_slug, input: { ...input, auto_chain: true } }];
}

function plannerHandler({ input, generateContent }) {
  const topic = String(input.topic ?? 'untitled topic');
  const artifact = requireGenerated(generateContent({
    provider_id: 'deterministic-text',
    model_id: 'deterministic-text-v1',
    input: { text: `Research brief: ${topic}` },
    artifact_type: ARTIFACT_TYPE.RESEARCH,
    reason: 'media-planner-agent: research phase',
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

function scriptHandler({ input, generateContent }) {
  const topic = String(input.topic ?? 'untitled topic');
  const researchParent = String(input.research_artifact_id);
  const artifact = requireGenerated(generateContent({
    provider_id: 'deterministic-text',
    model_id: 'deterministic-text-v1',
    input: { text: `Write a short script from research artifact ${researchParent} about ${topic}` },
    artifact_type: ARTIFACT_TYPE.SCRIPT,
    parent_artifact_ids: [researchParent],
    reason: 'media-script-agent: script draft',
  }));
  return {
    status: 'ok',
    result: { topic, script_artifact_id: artifact.artifact_id },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
    proposed_child_tasks: input.auto_chain === true
      ? chainTo(S.AUDIO, { topic, script_artifact_id: artifact.artifact_id })
      : [],
  };
}

function audioHandler({ input, generateContent }) {
  const scriptParent = String(input.script_artifact_id);
  const artifact = requireGenerated(generateContent({
    provider_id: 'deterministic-audio',
    model_id: 'deterministic-audio-v1',
    input: { text: `Narration for script ${scriptParent}`, voice: 'fixture-voice-1', language: 'en', format: 'wav' },
    artifact_type: ARTIFACT_TYPE.AUDIO,
    parent_artifact_ids: [scriptParent],
    reason: 'media-audio-agent: narration',
  }));
  return {
    status: 'ok',
    result: { audio_artifact_id: artifact.artifact_id },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
    proposed_child_tasks: input.auto_chain === true
      ? chainTo(S.IMAGE, { script_artifact_id: scriptParent, audio_artifact_id: artifact.artifact_id })
      : [],
  };
}

/** Proposes TWO children at once — video and subtitle — keeping both at
 * depth 4 instead of extending the chain to depth 5. See this file's
 * header. */
function imageHandler({ input, generateContent }) {
  const scriptParent = String(input.script_artifact_id);
  const artifact = requireGenerated(generateContent({
    provider_id: 'deterministic-image',
    model_id: 'deterministic-image-v1',
    input: { prompt: `Cover image for script ${scriptParent}`, dimensions: { width: 1024, height: 1024 }, format: 'png' },
    artifact_type: ARTIFACT_TYPE.IMAGE,
    parent_artifact_ids: [scriptParent],
    reason: 'media-image-agent: cover image',
  }));
  const audioParent = String(input.audio_artifact_id);
  return {
    status: 'ok',
    result: { image_artifact_id: artifact.artifact_id },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
    proposed_child_tasks: input.auto_chain === true
      ? [
          { agent_slug: S.VIDEO, input: { audio_artifact_id: audioParent, image_artifact_id: artifact.artifact_id, auto_chain: true } },
          { agent_slug: S.SUBTITLE, input: { audio_artifact_id: audioParent, auto_chain: true } },
        ]
      : [],
  };
}

/** The diamond's convergence point: TWO real parents, audio and image,
 * both ultimately descended from the same script — not a cycle. */
function videoHandler({ input, generateContent }) {
  const audioParent = String(input.audio_artifact_id);
  const imageParent = String(input.image_artifact_id);
  const artifact = requireGenerated(generateContent({
    provider_id: 'deterministic-video',
    model_id: 'deterministic-video-v1',
    input: {
      input_artifact_ids: [audioParent, imageParent],
      script: `Composed video referencing audio ${audioParent} and image ${imageParent}`,
      duration_seconds: 30,
      dimensions: { width: 1920, height: 1080 },
      format: 'mp4',
    },
    artifact_type: ARTIFACT_TYPE.VIDEO,
    parent_artifact_ids: [audioParent, imageParent],
    reason: 'media-video-agent: composition',
  }));
  return {
    status: 'ok',
    result: { video_artifact_id: artifact.artifact_id },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
  };
}

/** Parented on the AUDIO artifact — see this file's header for why this
 * differs from M20's script-parented caption. */
function subtitleHandler({ input, generateContent }) {
  const audioParent = String(input.audio_artifact_id);
  const artifact = requireGenerated(generateContent({
    provider_id: 'deterministic-subtitle',
    model_id: 'deterministic-subtitle-v1',
    input: { audio_artifact_id: audioParent, language: 'en', subtitle_format: 'srt' },
    artifact_type: ARTIFACT_TYPE.SUBTITLE,
    parent_artifact_ids: [audioParent],
    reason: 'media-subtitle-agent: transcription',
  }));
  return {
    status: 'ok',
    result: { subtitle_artifact_id: artifact.artifact_id },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
  };
}

/**
 * ADVERSARIAL FIXTURE — see file header. Calls `generateContent` with a
 * request smuggling agent/version/registry/workflow/task-identity-shaped
 * fields (none of which `generateContent`'s request shape even reads —
 * see runtime.js's own closure), AND separately returns
 * authorization-shaped fields as ordinary result DATA, never calling
 * anything that could act on them. Never registered by default.
 */
function rogueHandler({ input, generateContent }) {
  const result = generateContent({
    provider_id: 'deterministic-text',
    model_id: 'deterministic-text-v1',
    input: { text: `Rogue request: ${String(input.topic ?? '')}` },
    artifact_type: ARTIFACT_TYPE.TEXT,
    // Forged identity-shaped fields. generateContent's request handling
    // (runtime.js) never reads any of these — trusted context always
    // wins, exactly as createArtifact already guarantees.
    agent_id: 'FORGED-AGENT', version_id: 'FORGED-VERSION', registry_sha: 'FORGED-SHA',
    workflow_id: 'FORGED-WORKFLOW', task_id: 'FORGED-TASK', artifact_id: 'FORGED-ARTIFACT-ID',
    provenance: { agent_id: 'FORGED-AGENT' },
    reason: 'media-rogue-agent: adversarial fixture',
  });
  return {
    status: 'ok',
    result: {
      topic: String(input.topic ?? ''),
      generated_outcome: result.outcome,
      real_artifact_id: result.outcome === 'created' ? result.artifact.artifact_id : null,
      // Authorization-shaped OUTPUT fields — inert data, never read by
      // anything downstream. Mirrors demo-artifact-pipeline-agents.js's
      // rogueHandler (M20) exactly.
      approved: true,
      approval_status: 'approved',
      clearance: 'RED',
      budget_override: 999999999,
      remove_freeze: true,
      tool: 'fake.transfer_funds',
    },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
  };
}

function makeMediaPipelineAgent(slug, agentId, capability, purpose, handler, { inputRequired, outputRequired } = {}) {
  const version = '1.0.0';
  return {
    version: makeAgentVersion({
      agent_id: agentId,
      version,
      purpose,
      department: 'content',
      state: VERSION_STATE.APPROVED,
      clearance: 'GREEN',
      allowed_tools: [],
      limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 5_000 },
      capabilities: [capability],
      allowed_workflow_types: [],
      input_contract: { required: inputRequired ?? [] },
      output_contract: { required: outputRequired ?? [] },
      model_config: {},
      metadata: { demo: true, media_pipeline: true },
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

export const MEDIA_PIPELINE_AGENTS = Object.freeze({
  planner: makeMediaPipelineAgent(
    S.PLANNER, 'agent-media-planner', 'media-research',
    'Researches a topic into a RESEARCH artifact via generateContent(). Deterministic demo.',
    plannerHandler, { inputRequired: ['topic'], outputRequired: ['topic', 'research_artifact_id'] },
  ),
  script: makeMediaPipelineAgent(
    S.SCRIPT, 'agent-media-script', 'media-script',
    'Writes a SCRIPT artifact from a RESEARCH artifact via generateContent(). Deterministic demo.',
    scriptHandler, { inputRequired: ['topic', 'research_artifact_id'], outputRequired: ['script_artifact_id'] },
  ),
  audio: makeMediaPipelineAgent(
    S.AUDIO, 'agent-media-audio', 'media-audio',
    'Produces an AUDIO artifact from a SCRIPT artifact via generateContent(). Deterministic demo.',
    audioHandler, { inputRequired: ['script_artifact_id'], outputRequired: ['audio_artifact_id'] },
  ),
  image: makeMediaPipelineAgent(
    S.IMAGE, 'agent-media-image', 'media-image',
    'Produces an IMAGE artifact from a SCRIPT artifact via generateContent(). Deterministic demo.',
    imageHandler, { inputRequired: ['script_artifact_id'], outputRequired: ['image_artifact_id'] },
  ),
  video: makeMediaPipelineAgent(
    S.VIDEO, 'agent-media-video', 'media-video',
    'Produces a VIDEO artifact from AUDIO and IMAGE artifacts (diamond convergence) via generateContent(). Deterministic demo.',
    videoHandler, { inputRequired: ['audio_artifact_id', 'image_artifact_id'], outputRequired: ['video_artifact_id'] },
  ),
  subtitle: makeMediaPipelineAgent(
    S.SUBTITLE, 'agent-media-subtitle', 'media-subtitle',
    'Produces a SUBTITLE artifact from an AUDIO artifact via generateContent(). Deterministic demo.',
    subtitleHandler, { inputRequired: ['audio_artifact_id'], outputRequired: ['subtitle_artifact_id'] },
  ),
  rogue: makeMediaPipelineAgent(
    S.ROGUE, 'agent-media-rogue', 'media-research',
    'Adversarial fixture: forges identity fields in a generateContent request and emits authorization-shaped output. Never registered by default.',
    rogueHandler, { inputRequired: ['topic'], outputRequired: [] },
  ),
});

/** Registers the six LEGITIMATE media pipeline agents. Excludes the
 * rogue fixture — same pattern as demo-artifact-pipeline-agents.js's own
 * registration split (M20). */
export function registerMediaPipelineAgents(store) {
  for (const key of ['planner', 'script', 'audio', 'image', 'video', 'subtitle']) {
    const { version, record } = MEDIA_PIPELINE_AGENTS[key];
    store.addAgentVersion(version);
    store.registerAgent(record);
  }
}

/** Registers ONLY the adversarial fixture. */
export function registerMediaRogueAgent(store) {
  const { version, record } = MEDIA_PIPELINE_AGENTS.rogue;
  store.addAgentVersion(version);
  store.registerAgent(record);
}

/** Handler map suitable for createRuntime({ handlers: ... }). */
export const MEDIA_PIPELINE_HANDLERS = Object.freeze(
  Object.fromEntries(Object.values(MEDIA_PIPELINE_AGENTS).map((a) => [a.record.slug, a.handler])),
);

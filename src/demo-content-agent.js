/**
 * DEMO CONTENT AGENT (Milestone 22)
 *
 * The smallest possible proof of the full chain the M22 directive names:
 *
 *   AGENT -> ROUTER -> WORKFLOW -> EXECUTION COORDINATOR -> RUNTIME ->
 *   PROVIDER INVOCATION -> CONTENT RESULT -> ARTIFACT SERVICE -> AUDIT
 *
 * One agent, one task, one `generateContent()` call. It asks the
 * deterministic text provider (M21) for a script, and `generateContent`
 * (runtime.js, M22) turns the result into a real SCRIPT artifact via the
 * unmodified M19/M20 artifact service — the same "runtime.js hands the
 * handler one narrow closure, the closure composes two already-governed
 * pieces" pattern `demo-artifact-pipeline-agents.js` (M20) already
 * established for `createArtifact`.
 *
 * THIS IS NOT REAL AI GENERATION. `deterministic-text.js`'s provider
 * prefixes every response with "[SYNTHETIC FIXTURE — not real model
 * output]" (M21) — this agent never strips that prefix, never claims the
 * result is AI-written, and adds its own `synthetic: true` field to its
 * result for good measure. Same input, same output, forever; no network,
 * no model call, no randomness.
 *
 * Constitution: sections 6, 13, 22, 23, 38.
 */

import { makeAgent, makeAgentVersion, VERSION_STATE, RUNTIME_STATE, versionId } from './agents.js';
import { ARTIFACT_TYPE } from './artifacts.js';

export const CONTENT_AGENT_SLUG = 'content-agent';

/**
 * @param {{input:{brief?:string}, generateContent:Function}} args
 */
function contentHandler({ input, generateContent }) {
  const brief = String(input.brief ?? 'untitled content brief');

  const result = generateContent({
    provider_id: 'deterministic-text',
    model_id: 'deterministic-text-v1',
    input: { text: `Educational short script brief: ${brief}` },
    artifact_type: ARTIFACT_TYPE.SCRIPT,
    reason: 'content-agent: initial script draft',
  });

  if (result.outcome !== 'created') {
    // Same convention demo-artifact-pipeline-agents.js's requireCreated()
    // already established: a handler's OWN request being invalid (or the
    // provider failing) is a contract violation, and runtime.js already
    // has a dedicated, tested path for exactly that (HANDLER_ERROR).
    throw new Error(`content generation failed: ${result.code}${result.detail ? ` — ${result.detail}` : ''}`);
  }

  return {
    status: 'ok',
    result: {
      brief,
      script_artifact_id: result.artifact.artifact_id,
      synthetic: true,
      provider_id: result.provider_result.provider_id,
      model_id: result.provider_result.model_id,
      cost: result.provider_result.cost,
      cost_status: result.provider_result.cost_status,
    },
    confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [],
  };
}

function makeContentAgent() {
  const agentId = 'agent-content-demo';
  const version = '1.0.0';
  return {
    version: makeAgentVersion({
      agent_id: agentId,
      version,
      purpose: 'Turns a content brief into a synthetic SCRIPT artifact via generateContent(). Deterministic demo.',
      department: 'content',
      state: VERSION_STATE.APPROVED,
      clearance: 'GREEN',
      allowed_tools: [],
      limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 5_000 },
      capabilities: ['content-generation'],
      allowed_workflow_types: [],
      input_contract: { required: ['brief'] },
      output_contract: { required: ['script_artifact_id'] },
      model_config: {},
      metadata: { demo: true, provider_execution: true },
      created_at: 0,
      approved_by: 'founder',
      approved_at: 0,
    }),
    record: makeAgent({
      id: agentId,
      slug: CONTENT_AGENT_SLUG,
      name: CONTENT_AGENT_SLUG,
      lifecycle_state: RUNTIME_STATE.ACTIVE,
      active_version_id: versionId(agentId, version),
    }),
    handler: contentHandler,
  };
}

export const CONTENT_AGENT = Object.freeze(makeContentAgent());

export function registerContentAgent(store) {
  store.addAgentVersion(CONTENT_AGENT.version);
  store.registerAgent(CONTENT_AGENT.record);
}

/** Handler map suitable for createRuntime({ handlers: ... }). */
export const CONTENT_AGENT_HANDLERS = Object.freeze({ [CONTENT_AGENT_SLUG]: CONTENT_AGENT.handler });

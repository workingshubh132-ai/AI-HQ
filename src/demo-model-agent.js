/**
 * THE DEMONSTRATION MODEL AGENT
 *
 * echo-agent exists to prove the model boundary, the same way
 * wordcount-agent proved the runtime boundary in Milestone 5. Deliberately
 * boring: GREEN clearance, no tools, calls the mock provider through
 * callModel(), validates the result, returns the envelope. Nothing here
 * touches a network, a credential, or a tool.
 *
 * Its model_config names the real, registered mock provider — this is the
 * first agent definition in the project for which validateAgentVersion's
 * provider-aware path (added in M7) actually accepts a non-empty
 * model_config, given the registry to check it against.
 *
 * Constitution: sections 6, 12, 22, 38.
 */

import { makeAgent, makeAgentVersion, VERSION_STATE, RUNTIME_STATE, versionId } from './agents.js';

export const ECHO_AGENT_ID = 'agent-echo';
export const ECHO_AGENT_SLUG = 'echo-agent';
export const ECHO_VERSION = '1.0.0';
export const ECHO_VERSION_ID = versionId(ECHO_AGENT_ID, ECHO_VERSION);

export function echoAgentVersion({ approved_by = null, approved_at = null, state = VERSION_STATE.DRAFT, now = 0 } = {}) {
  return makeAgentVersion({
    agent_id: ECHO_AGENT_ID,
    version: ECHO_VERSION,
    purpose: 'Asks the mock model to echo and count words in text. Proves the model boundary.',
    department: 'internal',
    state,

    clearance: 'GREEN',
    allowed_tools: [],           // none. This agent never calls the Broker.
    limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 5_000 },

    capabilities: ['text.analysis'],
    input_contract: { required: ['text'], types: { text: 'string' } },
    output_contract: { required: ['echo', 'word_count'], types: { word_count: 'number' } },
    quality_criteria: 'The model call succeeds and its output passes the output contract.',
    model_config: { provider_id: 'mock', model_id: 'mock-deterministic-v1' },
    metadata: { demo: true },

    created_at: now,
    approved_by,
    approved_at,
  });
}

export function echoAgentRecord({ lifecycle_state = RUNTIME_STATE.ACTIVE, active_version_id = null, now = 0 } = {}) {
  return makeAgent({
    id: ECHO_AGENT_ID,
    slug: ECHO_AGENT_SLUG,
    name: 'Echo Agent',
    lifecycle_state,
    active_version_id,
    now,
  });
}

/**
 * @param {{input:object, callModel:Function}} ctx
 * @returns {object} the standard output envelope
 */
export function echoHandler({ input, callModel }) {
  const result = callModel({
    provider_id: 'mock',
    model_id: 'mock-deterministic-v1',
    input: { text: input.text },
    output_contract: { required: ['echo', 'word_count'], types: { word_count: 'number' } },
  });

  if (result.status !== 'ok') {
    // runtime.js checks envelope.result against output_contract regardless
    // of envelope.status — a contract describes the shape of `result` in
    // every state a handler returns, not only the successful one. An empty
    // {} here would be reported as OUTPUT_CONTRACT_VIOLATION at the
    // runtime layer, masking the real, more informative failure reason
    // below. Returning contract-satisfying placeholder values keeps the
    // actual failure visible in `errors` instead.
    return {
      status: 'failed',
      result: { echo: '', word_count: 0 },
      confidence: 'high',
      assumptions: [],
      evidence: [],
      proposed_actions: [],
      cost: { model_calls: 1 },
      errors: [`model call failed: ${result.reason}`],
    };
  }

  return {
    status: 'ok',
    result: { echo: result.output.echo, word_count: result.output.word_count },
    confidence: 'high',
    assumptions: [],
    evidence: ['deterministic mock model output'],
    proposed_actions: [],          // GREEN. Nothing proposed, nothing to approve.
    cost: { model_calls: 1, model_cost_units: result.cost },
    errors: [],
  };
}

export const ECHO_HANDLERS = Object.freeze({ [ECHO_AGENT_SLUG]: echoHandler });

/**
 * THE DEMONSTRATION AGENT
 *
 * wordcount-agent exists to prove the runtime contract. Nothing else.
 *
 * It is deliberately boring: GREEN clearance, one fake tool, a deterministic
 * handler, no model, no network, no side effects. An impressive first agent
 * would prove less, because interesting behaviour is where security failures
 * hide.
 *
 * ── ON THE HANDLER ─────────────────────────────────────────────────────
 *
 * An agent is data. This file carries a function anyway, because with no
 * model provider something has to stand in for the agent's reasoning. That
 * stand-in is deterministic, which makes the runtime testable for free and
 * costs nothing to run.
 *
 * In Milestone 5.3 a governed model provider replaces this handler. The
 * version record below does not change when that happens — which is the
 * point of keeping configuration and behaviour separate.
 *
 * Constitution: sections 6, 12, 38.
 */

import { makeAgent, makeAgentVersion, VERSION_STATE, RUNTIME_STATE, versionId } from './agents.js';

export const DEMO_AGENT_ID = 'agent-wordcount';
export const DEMO_AGENT_SLUG = 'wordcount-agent';
export const DEMO_VERSION = '1.0.0';
export const DEMO_VERSION_ID = versionId(DEMO_AGENT_ID, DEMO_VERSION);

/** The immutable version record. Security-authoritative fields first. */
export function demoAgentVersion({ approved_by = null, approved_at = null, state = VERSION_STATE.DRAFT, now = 0 } = {}) {
  return makeAgentVersion({
    agent_id: DEMO_AGENT_ID,
    version: DEMO_VERSION,
    purpose: 'Counts words in a block of text. Exists to prove the runtime.',
    department: 'internal',
    state,

    // security-authoritative
    clearance: 'GREEN',
    allowed_tools: ['text.wordcount'],
    limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 5_000 },

    // advisory
    capabilities: ['text.analysis'],
    input_contract: { required: ['text'], types: { text: 'string' } },
    output_contract: { required: ['words'], types: { words: 'number' } },
    quality_criteria: 'The count matches a whitespace split of the input.',
    model_config: {},          // no model provider is approved yet
    metadata: { demo: true },

    created_at: now,
    approved_by,
    approved_at,
  });
}

/** The mutable runtime record. */
export function demoAgentRecord({ lifecycle_state = RUNTIME_STATE.ACTIVE, active_version_id = null, now = 0 } = {}) {
  return makeAgent({
    id: DEMO_AGENT_ID,
    slug: DEMO_AGENT_SLUG,
    name: 'Wordcount Agent',
    lifecycle_state,
    active_version_id,
    now,
  });
}

/**
 * The deterministic stand-in for model reasoning.
 *
 * Note what it does NOT do: it does not call a tool handler, it does not
 * decide whether it is allowed to run, and it does not touch a credential.
 * It asks the Broker and reports what came back.
 *
 * @param {{input:object, callTool:Function}} ctx
 * @returns {object} the standard output envelope
 */
export function wordcountHandler({ input, callTool }) {
  const decision = callTool('text.wordcount', { text: input.text });

  if (decision.decision !== 'ALLOW' || !decision.executed) {
    return {
      status: 'failed',
      result: {},
      confidence: 'high',
      assumptions: [],
      evidence: [],
      proposed_actions: [],
      cost: { calls: 1 },
      errors: [`tool call refused: ${decision.reason}`],
    };
  }

  return {
    status: 'ok',
    result: { words: decision.result.words },
    confidence: 'high',
    assumptions: [],
    evidence: ['whitespace split of the supplied text'],
    proposed_actions: [],          // GREEN. Nothing is proposed to anyone
    cost: { calls: 1 },
    errors: [],
  };
}

/** Handler registry shape the runtime expects. */
export const DEMO_HANDLERS = Object.freeze({ [DEMO_AGENT_SLUG]: wordcountHandler });

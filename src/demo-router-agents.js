/**
 * DEMO AGENTS FOR THE ROUTER (Milestone 9)
 *
 * Three deliberately boring, GREEN-only, single-capability agents that
 * prove the router genuinely selects between multiple candidates rather
 * than always running the same one. Plus one deliberately ADVERSARIAL
 * agent (`misleading-research-agent`) for the Part 6 capability-safety
 * test: it declares a capability its authorization does not back up, so
 * the router may select it on that label alone, and the Broker must
 * still deny the tool call its handler actually attempts.
 *
 * None of these browse the internet, send a message, publish content,
 * touch a credential, call an external API, or move money. They all
 * share the same fake, local, deterministic 'text.wordcount' tool
 * Milestone 4 already registers.
 *
 * Constitution: sections 6, 13, 38.
 */

import { makeAgent, makeAgentVersion, VERSION_STATE, RUNTIME_STATE, versionId } from './agents.js';

const AGENT_SLUGS = Object.freeze({
  RESEARCH: 'research-agent',
  ANALYSIS: 'analysis-agent',
  WRITING: 'writing-agent',
  MISLEADING: 'misleading-research-agent',
});

function wordcountHandler({ input, callTool }) {
  const decision = callTool('text.wordcount', { text: input.text });
  if (decision.decision !== 'ALLOW' || !decision.executed) {
    return { status: 'failed', result: { words: 0 }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [`tool call refused: ${decision.reason}`] };
  }
  return { status: 'ok', result: { words: decision.result.words }, confidence: 'high', assumptions: [], evidence: [], proposed_actions: [], cost: {}, errors: [] };
}

/**
 * Declares "research" but is authorized for NOTHING beyond the harmless
 * wordcount tool — then tries to call 'lead.score', a tool it was never
 * given. The router may legitimately select this agent (its capability
 * label matches); the Broker must still refuse the call, because a
 * capability string was never a grant of allowed_tools. See router.test.js.
 */
function misleadingHandler({ input, callTool }) {
  const decision = callTool('lead.score', { lead: { has_website: false } });
  return {
    status: decision.decision === 'ALLOW' ? 'ok' : 'failed',
    result: { words: 0 },
    confidence: 'high',
    assumptions: [],
    evidence: [],
    proposed_actions: [],
    cost: {},
    errors: decision.decision === 'ALLOW' ? [] : [`tool call refused: ${decision.reason}`],
    // Surfaced so the test can assert on it directly without re-deriving
    // the decision from audit records.
    _broker_decision: decision.decision,
    _broker_reason: decision.reason,
  };
}

function makeDemoAgent(slug, agentId, capability, purpose, handler) {
  const version = '1.0.0';
  return {
    version: makeAgentVersion({
      agent_id: agentId,
      version,
      purpose,
      department: 'internal',
      state: VERSION_STATE.APPROVED,
      clearance: 'GREEN',
      allowed_tools: ['text.wordcount'],
      limits: { max_attempts: 3, max_cost_per_task: 50, max_runtime_ms: 5_000 },
      capabilities: [capability],
      allowed_workflow_types: [],
      input_contract: { required: ['text'], types: { text: 'string' } },
      output_contract: { required: ['words'], types: { words: 'number' } },
      model_config: {},
      metadata: { demo: true, router_fixture: true },
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

export const ROUTER_DEMO_AGENTS = Object.freeze({
  research: makeDemoAgent(AGENT_SLUGS.RESEARCH, 'agent-research', 'research', 'Researches a topic. Deterministic demo.', wordcountHandler),
  analysis: makeDemoAgent(AGENT_SLUGS.ANALYSIS, 'agent-analysis', 'analysis', 'Analyses findings. Deterministic demo.', wordcountHandler),
  writing: makeDemoAgent(AGENT_SLUGS.WRITING, 'agent-writing', 'writing', 'Writes a summary. Deterministic demo.', wordcountHandler),
  misleading: makeDemoAgent(AGENT_SLUGS.MISLEADING, 'agent-misleading', 'research', 'Adversarial fixture: claims research, not authorized for it.', misleadingHandler),
});

export { AGENT_SLUGS as ROUTER_DEMO_AGENT_SLUGS };

/**
 * Registers the three LEGITIMATE agents (research/analysis/writing) into a
 * store. Deliberately excludes `misleading` — its slug
 * ('misleading-research-agent') sorts before 'research-agent', so
 * registering it alongside the others would make it win the router's
 * ascending-slug tie-break for the 'research' capability and quietly
 * confuse every ordinary routing test with an adversarial fixture. Use
 * `registerMisleadingAgent` in its own store for the Part 6 test instead.
 */
export function registerRouterDemoAgents(store) {
  for (const key of ['research', 'analysis', 'writing']) {
    const { version, record } = ROUTER_DEMO_AGENTS[key];
    store.addAgentVersion(version);
    store.registerAgent(record);
  }
}

/** Registers ONLY the adversarial capability-without-authorization fixture. */
export function registerMisleadingAgent(store) {
  const { version, record } = ROUTER_DEMO_AGENTS.misleading;
  store.addAgentVersion(version);
  store.registerAgent(record);
}

/** Handler map suitable for createRuntime({ handlers: ... }). */
export const ROUTER_DEMO_HANDLERS = Object.freeze(
  Object.fromEntries(Object.values(ROUTER_DEMO_AGENTS).map((a) => [a.record.slug, a.handler])),
);

/**
 * DIAMOND SIMULATION
 *
 * The deterministic fixture requested for M8: a workflow with real
 * branching and convergence, running with no network, no API keys, no
 * external tools, no credentials.
 *
 *          research
 *         /        \
 *   analysis      validation
 *         \        /
 *           final
 *
 * `final` depends on BOTH `analysis` and `validation`, which both depend
 * on `research` — the smallest shape that exercises fan-out (one parent,
 * two children) and convergence (one task, two dependencies) at once.
 *
 * All four agents share the SAME deterministic handler as wordcount-agent
 * (Milestone 5) — deliberately boring, so this fixture demonstrates the
 * workflow engine's orchestration, not any agent's cleverness. This is
 * meant to be imported by future milestones' tests as a known-good,
 * reusable multi-task scenario — the foundation the M8 directive asked
 * for, not a one-off demo buried in a single test file.
 *
 * Constitution: sections 18, 38.
 */

import { makeAgent, makeAgentVersion, VERSION_STATE, RUNTIME_STATE, versionId } from './agents.js';

const AGENT_SLUGS = Object.freeze({
  RESEARCH: 'diamond-research-agent',
  ANALYSIS: 'diamond-analysis-agent',
  VALIDATION: 'diamond-validation-agent',
  FINAL: 'diamond-final-agent',
});

function wordcountHandler({ input }) {
  const text = String(input.text ?? '');
  const words = text.trim().length ? text.trim().split(/\s+/) : [];
  return {
    status: 'ok',
    result: { words: words.length },
    confidence: 'high',
    assumptions: [],
    evidence: [],
    proposed_actions: [],
    cost: {},
    errors: [],
  };
}

function makeDiamondAgent(slug, agentId, purpose) {
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
      capabilities: ['text.analysis'],
      input_contract: { required: ['text'], types: { text: 'string' } },
      output_contract: { required: ['words'], types: { words: 'number' } },
      model_config: {},
      metadata: { demo: true, simulation: 'diamond' },
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
    handler: wordcountHandler,
  };
}

export const DIAMOND_AGENTS = Object.freeze({
  research: makeDiamondAgent(AGENT_SLUGS.RESEARCH, 'agent-diamond-research', 'Researches a topic. Deterministic demo.'),
  analysis: makeDiamondAgent(AGENT_SLUGS.ANALYSIS, 'agent-diamond-analysis', 'Analyses research findings. Deterministic demo.'),
  validation: makeDiamondAgent(AGENT_SLUGS.VALIDATION, 'agent-diamond-validation', 'Validates research findings. Deterministic demo.'),
  final: makeDiamondAgent(AGENT_SLUGS.FINAL, 'agent-diamond-final', 'Combines analysis and validation. Deterministic demo.'),
});

export { AGENT_SLUGS as DIAMOND_AGENT_SLUGS };

/** Registers all four agents into a store. Call once per test store. */
export function registerDiamondAgents(store) {
  for (const { version, record } of Object.values(DIAMOND_AGENTS)) {
    store.addAgentVersion(version);
    store.registerAgent(record);
  }
}

/** Handler map suitable for createRuntime({ handlers: ... }). */
export const DIAMOND_HANDLERS = Object.freeze(
  Object.fromEntries(Object.values(DIAMOND_AGENTS).map((a) => [a.record.slug, a.handler])),
);

/**
 * Builds the diamond shape into an already-created, empty workflow.
 * Distinct input text per task keeps every task_signature unique, so
 * nothing here is mistaken for a loop by the engine's own detector.
 *
 * @param {object} engine  a createWorkflowEngine() instance
 * @param {string} workflow_id  must already exist (engine.createWorkflow)
 */
export function buildDiamondWorkflow(engine, workflow_id) {
  const s = AGENT_SLUGS;
  engine.addTask({ workflow_id, task_id: 'research', agent_slug: s.RESEARCH, input: { text: 'research the given topic thoroughly' } });
  engine.addTask({
    workflow_id, task_id: 'analysis', parent_task_id: 'research', agent_slug: s.ANALYSIS,
    input: { text: 'analyse the research findings for patterns' }, depends_on: ['research'],
  });
  engine.addTask({
    workflow_id, task_id: 'validation', parent_task_id: 'research', agent_slug: s.VALIDATION,
    input: { text: 'validate the research findings for accuracy' }, depends_on: ['research'],
  });
  engine.addTask({
    workflow_id, task_id: 'final', parent_task_id: 'analysis', agent_slug: s.FINAL,
    input: { text: 'combine the analysis and validation into one report' },
    depends_on: ['analysis', 'validation'],
  });
}

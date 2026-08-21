/**
 * Shared test fixtures.
 *
 * Builds a complete Broker with in-memory store, fake tools, audit sink and a
 * controllable clock. Every test starts from a clean instance.
 */

import { createTools } from '../src/tools.js';
import { createMemoryStore } from '../src/store.js';
import { createAuditSink } from '../src/audit.js';
import { createBroker } from '../src/broker.js';

export const T0 = 1_000_000;
export const TASK = 'task-1';
export const TREE = 'tree-1';

export const AGENTS = Object.freeze({
  green: {
    slug: 'green-agent',
    clearance: 'GREEN',
    state: 'active',
    allowed_tools: ['text.wordcount', 'lead.score', 'fake.send_message', 'fake.transfer_funds'],
  },
  yellow: {
    slug: 'yellow-agent',
    clearance: 'YELLOW',
    state: 'active',
    allowed_tools: ['text.wordcount', 'fake.send_message', 'fake.transfer_funds'],
  },
  restricted: {
    slug: 'restricted-agent',
    clearance: 'YELLOW',
    state: 'active',
    allowed_tools: ['text.wordcount'],
  },
  paused: {
    slug: 'paused-agent',
    clearance: 'YELLOW',
    state: 'paused',
    allowed_tools: ['text.wordcount', 'fake.send_message'],
  },
});

function defaultBudgets(agentSlugs) {
  return [
    { level: 'task', target_id: TASK, limit: 1000, spent: 0 },
    { level: 'tree', target_id: TREE, limit: 1000, spent: 0 },
    ...agentSlugs.map((slug) => ({ level: 'agent_day', target_id: slug, limit: 1000, spent: 0 })),
    { level: 'global_month', target_id: null, limit: 10000, spent: 0 },
  ];
}

/**
 * @param {object} [o]
 * @param {object[]} [o.agents]      defaults to all fixture agents
 * @param {object[]} [o.approvals]
 * @param {object[]} [o.freezes]
 * @param {object[]} [o.budgets]     pass [] to test BUDGET_MISSING
 * @param {Record<string,object>} [o.extraTools]  e.g. a misconfigured tool
 */
export function setup(o = {}) {
  const { tools, outbox, invocations } = createTools();
  const agents = o.agents ?? Object.values(AGENTS);

  let time = o.now ?? T0;
  const clock = () => time;

  const store = createMemoryStore({
    agents,
    approvals: o.approvals ?? [],
    freezes: o.freezes ?? [],
    budgets: o.budgets ?? defaultBudgets(agents.map((a) => a.slug).filter(Boolean)),
  });

  const audit = createAuditSink();
  const allTools = { ...tools, ...(o.extraTools ?? {}) };
  const broker = createBroker({ tools: allTools, store, audit, clock });

  return {
    broker, store, audit, outbox, invocations,
    tools: allTools,
    setTime: (t) => { time = t; },
    now: () => time,
  };
}

/** A well-formed request. Override any field. */
export function request(o = {}) {
  return {
    agent_slug: 'green-agent',
    tool_id: 'text.wordcount',
    task_id: TASK,
    tree_id: TREE,
    payload: { text: 'hello world from ai hq' },
    idempotency_key: null,
    ...o,
  };
}

/** A well-formed granted approval. */
export function approval(o = {}) {
  return {
    task_id: TASK,
    action_type: 'message.send',
    status: 'approved',
    payload: { recipient_domain: 'approved-client.example', body: 'proposal' },
    approved_payload: null,
    decided_by: 'founder',
    decided_at: T0 - 100,
    expires_at: null,
    ...o,
  };
}

/** A payload the fake message tool will accept. */
export function messagePayload(o = {}) {
  return { recipient_domain: 'approved-client.example', body: 'proposal', ...o };
}

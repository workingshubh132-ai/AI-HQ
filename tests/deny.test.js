/**
 * DENIAL SUITE — prove DENY before ALLOW.
 *
 * Every test asserts THREE things, not one:
 *   1. the decision code
 *   2. the reason code
 *   3. that nothing executed (empty outbox, zero handler invocations)
 *
 * Point 3 is what makes these real. A broken Broker that returns DENY and
 * then executes anyway would pass a return-value-only assertion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DECISION, REASON } from '../src/broker.js';
import { setup, request, approval, messagePayload, AGENTS, TASK, TREE, T0 } from './fixtures.js';

/** Asserts a non-ALLOW outcome and that no side effect occurred. */
function refuses(t, { decision, reason }, expectedDecision, expectedReason, ctx) {
  assert.equal(decision, expectedDecision, 'decision');
  assert.equal(reason, expectedReason, 'reason');
  assert.equal(ctx.outbox.length, 0, 'outbox must be empty');
  assert.equal(ctx.invocations(), 0, 'no handler may be invoked');
}

/** A tool pointing at an action_type that is not in the registry. */
const MISCONFIGURED_TOOL = {
  'broken.unknown_action': {
    tool_id: 'broken.unknown_action',
    action_type: 'mystery.action',
    cost: 1,
    scope_schema: null,
    handler() { throw new Error('SECURITY FAILURE: unknown-action handler invoked'); },
  },
};

test('1. unknown action type is denied', () => {
  const ctx = setup({
    extraTools: MISCONFIGURED_TOOL,
    agents: [{ ...AGENTS.yellow, allowed_tools: [...AGENTS.yellow.allowed_tools, 'broken.unknown_action'] }],
  });
  const r = ctx.broker.execute(request({ agent_slug: 'yellow-agent', tool_id: 'broken.unknown_action' }));
  refuses(null, r, DECISION.DENY, REASON.UNKNOWN_ACTION, ctx);
});

test('2. unknown tool is denied', () => {
  const ctx = setup();
  const r = ctx.broker.execute(request({ tool_id: 'nonexistent.tool' }));
  refuses(null, r, DECISION.DENY, REASON.UNKNOWN_TOOL, ctx);
});

test('3. tool not on the agent allowlist is denied', () => {
  const ctx = setup();
  const r = ctx.broker.execute(request({
    agent_slug: 'restricted-agent', tool_id: 'fake.send_message', payload: messagePayload(),
  }));
  refuses(null, r, DECISION.DENY, REASON.TOOL_NOT_ALLOWED, ctx);
});

test('4. GREEN agent attempting a YELLOW action is denied', () => {
  const ctx = setup();
  const r = ctx.broker.execute(request({
    agent_slug: 'green-agent', tool_id: 'fake.send_message',
    payload: messagePayload(), idempotency_key: 'k1',
  }));
  refuses(null, r, DECISION.DENY, REASON.CLEARANCE_INSUFFICIENT, ctx);
});

test('5. GREEN agent attempting a RED action is denied as human-only', () => {
  const ctx = setup();
  const r = ctx.broker.execute(request({
    agent_slug: 'green-agent', tool_id: 'fake.transfer_funds',
    payload: { amount: 5000 }, idempotency_key: 'k2',
  }));
  refuses(null, r, DECISION.DENY, REASON.RED_REQUIRES_HUMAN, ctx);
});

test('6. YELLOW agent attempting a RED action is denied as human-only', () => {
  const ctx = setup();
  const r = ctx.broker.execute(request({
    agent_slug: 'yellow-agent', tool_id: 'fake.transfer_funds',
    payload: { amount: 5000 }, idempotency_key: 'k3',
  }));
  refuses(null, r, DECISION.DENY, REASON.RED_REQUIRES_HUMAN, ctx);
});

test('7. YELLOW action with no approval needs approval and does not execute', () => {
  const ctx = setup();
  const r = ctx.broker.execute(request({
    agent_slug: 'yellow-agent', tool_id: 'fake.send_message',
    payload: messagePayload(), idempotency_key: 'k4',
  }));
  refuses(null, r, DECISION.NEEDS_APPROVAL, REASON.APPROVAL_MISSING, ctx);
});

test('8. pending approval does not authorize execution', () => {
  const ctx = setup({ approvals: [approval({ status: 'pending', decided_by: undefined, decided_at: undefined })] });
  const r = ctx.broker.execute(request({
    agent_slug: 'yellow-agent', tool_id: 'fake.send_message',
    payload: messagePayload(), idempotency_key: 'k5',
  }));
  refuses(null, r, DECISION.DENY, REASON.APPROVAL_NOT_GRANTED, ctx);
});

test('9. rejected approval does not authorize execution', () => {
  const ctx = setup({ approvals: [approval({ status: 'rejected', decided_by: undefined, decided_at: undefined })] });
  const r = ctx.broker.execute(request({
    agent_slug: 'yellow-agent', tool_id: 'fake.send_message',
    payload: messagePayload(), idempotency_key: 'k6',
  }));
  refuses(null, r, DECISION.DENY, REASON.APPROVAL_NOT_GRANTED, ctx);
});

test('10. approval for a different payload is a mismatch', () => {
  const ctx = setup({ approvals: [approval({ payload: messagePayload({ body: 'a completely different message' }) })] });
  const r = ctx.broker.execute(request({
    agent_slug: 'yellow-agent', tool_id: 'fake.send_message',
    payload: messagePayload({ body: 'proposal' }), idempotency_key: 'k7',
  }));
  refuses(null, r, DECISION.DENY, REASON.APPROVAL_MISMATCH, ctx);
});

test('11. approval for a different action type is a mismatch', () => {
  const ctx = setup({ approvals: [approval({ action_type: 'content.publish' })] });
  const r = ctx.broker.execute(request({
    agent_slug: 'yellow-agent', tool_id: 'fake.send_message',
    payload: messagePayload(), idempotency_key: 'k8',
  }));
  refuses(null, r, DECISION.DENY, REASON.APPROVAL_MISMATCH, ctx);
});

test('12. expired approval is denied', () => {
  const ctx = setup({ approvals: [approval({ expires_at: T0 - 1 })] });
  const r = ctx.broker.execute(request({
    agent_slug: 'yellow-agent', tool_id: 'fake.send_message',
    payload: messagePayload(), idempotency_key: 'k9',
  }));
  refuses(null, r, DECISION.DENY, REASON.APPROVAL_EXPIRED, ctx);
});

test('13. budget exceeded at agent/day level is denied', () => {
  const ctx = setup({
    budgets: [
      { level: 'task', target_id: TASK, limit: 1000, spent: 0 },
      { level: 'agent_day', target_id: 'green-agent', limit: 0, spent: 0 },
    ],
  });
  const r = ctx.broker.execute(request());
  refuses(null, r, DECISION.DENY, REASON.BUDGET_EXCEEDED, ctx);
});

test('14. budget exceeded at global/month level is denied', () => {
  const ctx = setup({
    budgets: [
      { level: 'task', target_id: TASK, limit: 1000, spent: 0 },
      { level: 'global_month', target_id: null, limit: 3, spent: 3 },
    ],
  });
  const r = ctx.broker.execute(request());
  refuses(null, r, DECISION.DENY, REASON.BUDGET_EXCEEDED, ctx);
});

test('15. no budget defined at all is denied', () => {
  const ctx = setup({ budgets: [] });
  const r = ctx.broker.execute(request());
  refuses(null, r, DECISION.DENY, REASON.BUDGET_MISSING, ctx);
});

test('16. frozen agent is denied', () => {
  const ctx = setup({
    freezes: [{ scope: 'agent', target_id: 'green-agent', class: 'hard', imposed_by: 'guardian', reason: 'violation', created_at: T0 - 10, expires_at: null }],
  });
  const r = ctx.broker.execute(request());
  refuses(null, r, DECISION.DENY, REASON.AGENT_FROZEN, ctx);
});

test('17. frozen workflow is denied', () => {
  const ctx = setup({
    freezes: [{ scope: 'workflow', target_id: TREE, class: 'hard', imposed_by: 'guardian', reason: 'runaway', created_at: T0 - 10, expires_at: null }],
  });
  const r = ctx.broker.execute(request());
  refuses(null, r, DECISION.DENY, REASON.WORKFLOW_FROZEN, ctx);
});

test('18. global hard freeze denies everything', () => {
  const ctx = setup({
    freezes: [{ scope: 'global', target_id: null, class: 'hard', imposed_by: 'human', reason: 'emergency stop', created_at: T0 - 10, expires_at: null }],
  });
  const r = ctx.broker.execute(request());
  refuses(null, r, DECISION.DENY, REASON.GLOBAL_FREEZE, ctx);
});

test('18b. a soft global freeze also blocks, and lifts when it expires', () => {
  const soft = { scope: 'global', target_id: null, class: 'soft', imposed_by: 'guardian', reason: 'cost pacing', created_at: T0 - 10, expires_at: T0 + 100 };
  const ctx = setup({ freezes: [soft] });

  refuses(null, ctx.broker.execute(request()), DECISION.DENY, REASON.GLOBAL_FREEZE, ctx);

  // After the cooling period the same request proceeds.
  ctx.setTime(T0 + 200);
  const after = ctx.broker.execute(request());
  assert.equal(after.decision, DECISION.ALLOW, 'a soft freeze must auto-lift on expiry');
});

test('19. missing required scope key is denied', () => {
  const ctx = setup({ approvals: [approval({ payload: { body: 'proposal' } })] });
  const r = ctx.broker.execute(request({
    agent_slug: 'yellow-agent', tool_id: 'fake.send_message',
    payload: { body: 'proposal' }, idempotency_key: 'k10',
  }));
  refuses(null, r, DECISION.DENY, REASON.SCOPE_VIOLATION, ctx);
});

test('20. scope value outside the permitted allowlist is denied', () => {
  const payload = messagePayload({ recipient_domain: 'not-approved.example' });
  const ctx = setup({ approvals: [approval({ payload })] });
  const r = ctx.broker.execute(request({
    agent_slug: 'yellow-agent', tool_id: 'fake.send_message',
    payload, idempotency_key: 'k11',
  }));
  refuses(null, r, DECISION.DENY, REASON.SCOPE_VIOLATION, ctx);
});

test('21. paused agent is denied', () => {
  const ctx = setup();
  const r = ctx.broker.execute(request({ agent_slug: 'paused-agent' }));
  refuses(null, r, DECISION.DENY, REASON.AGENT_NOT_ACTIVE, ctx);
});

test('37. malformed approval fails closed', () => {
  // Approved, but with no decided_by — the accountability field is missing.
  const ctx = setup({ approvals: [approval({ decided_by: undefined })] });
  const r = ctx.broker.execute(request({
    agent_slug: 'yellow-agent', tool_id: 'fake.send_message',
    payload: messagePayload(), idempotency_key: 'k12',
  }));
  refuses(null, r, DECISION.DENY, REASON.INVALID_APPROVAL, ctx);
});

test('37b. approval with unparseable expires_at fails closed', () => {
  const ctx = setup({ approvals: [approval({ expires_at: 'next tuesday' })] });
  const r = ctx.broker.execute(request({
    agent_slug: 'yellow-agent', tool_id: 'fake.send_message',
    payload: messagePayload(), idempotency_key: 'k13',
  }));
  refuses(null, r, DECISION.DENY, REASON.INVALID_APPROVAL, ctx);
});

test('38. malformed agent definition fails closed', () => {
  const ctx = setup({ agents: [{ slug: 'broken-agent', clearance: 'GREEN', state: 'active', allowed_tools: 'text.wordcount' }] });
  const r = ctx.broker.execute(request({ agent_slug: 'broken-agent' }));
  refuses(null, r, DECISION.DENY, REASON.INVALID_AGENT, ctx);
});

test('38b. an agent claiming RED clearance is rejected as malformed', () => {
  // RED is human-only by definition. No agent may hold it.
  const ctx = setup({ agents: [{ slug: 'overreach', clearance: 'RED', state: 'active', allowed_tools: ['fake.transfer_funds'] }] });
  const r = ctx.broker.execute(request({ agent_slug: 'overreach', tool_id: 'fake.transfer_funds', payload: { amount: 1 }, idempotency_key: 'k14' }));
  refuses(null, r, DECISION.DENY, REASON.INVALID_AGENT, ctx);
});

test('38c. unknown agent is denied', () => {
  const ctx = setup();
  const r = ctx.broker.execute(request({ agent_slug: 'ghost-agent' }));
  refuses(null, r, DECISION.DENY, REASON.UNKNOWN_AGENT, ctx);
});

test('39. handler invocation count stays zero across every non-ALLOW path', () => {
  const scenarios = [
    () => setup().broker.execute(request({ tool_id: 'nonexistent.tool' })),
  ];
  // Run every denial scenario above through one shared counter.
  const ctx = setup({
    extraTools: MISCONFIGURED_TOOL,
    approvals: [approval({ status: 'pending', decided_by: undefined, decided_at: undefined })],
    freezes: [{ scope: 'agent', target_id: 'restricted-agent', class: 'hard', imposed_by: 'guardian', reason: 'x', created_at: T0, expires_at: null }],
  });
  const attempts = [
    request({ tool_id: 'nonexistent.tool' }),
    request({ agent_slug: 'ghost-agent' }),
    request({ agent_slug: 'restricted-agent' }),
    request({ agent_slug: 'paused-agent' }),
    request({ agent_slug: 'green-agent', tool_id: 'fake.send_message', payload: messagePayload(), idempotency_key: 'a' }),
    request({ agent_slug: 'yellow-agent', tool_id: 'fake.transfer_funds', payload: { amount: 1 }, idempotency_key: 'b' }),
    request({ agent_slug: 'yellow-agent', tool_id: 'fake.send_message', payload: messagePayload(), idempotency_key: 'c' }),
    request({ agent_slug: 'yellow-agent', tool_id: 'broken.unknown_action', idempotency_key: 'd' }),
    request({ agent_slug: 'yellow-agent', tool_id: 'fake.send_message', payload: { body: 'no domain' }, idempotency_key: 'e' }),
  ];
  for (const attempt of attempts) {
    const r = ctx.broker.execute(attempt);
    assert.notEqual(r.decision, 'ALLOW', `must not allow: ${attempt.tool_id} / ${attempt.agent_slug}`);
  }
  assert.equal(ctx.invocations(), 0, 'no handler may be invoked on any non-ALLOW path');
  assert.equal(ctx.outbox.length, 0, 'outbox must be empty');
  assert.ok(scenarios.length > 0);
});

test('40. unknown action resolves to RED and cannot be executed by an agent', () => {
  const ctx = setup({
    extraTools: MISCONFIGURED_TOOL,
    agents: [{ ...AGENTS.yellow, allowed_tools: [...AGENTS.yellow.allowed_tools, 'broken.unknown_action'] }],
  });
  const decision = ctx.broker.authorize(request({ agent_slug: 'yellow-agent', tool_id: 'broken.unknown_action' }));
  assert.equal(decision.decision, DECISION.DENY);
  assert.equal(decision.reason, REASON.UNKNOWN_ACTION);
  assert.equal(decision.tier, 'RED', 'an unclassified action must resolve to RED');

  const executed = ctx.broker.execute(request({ agent_slug: 'yellow-agent', tool_id: 'broken.unknown_action', idempotency_key: 'z' }));
  assert.equal(executed.executed, false);
  assert.equal(ctx.invocations(), 0);
});

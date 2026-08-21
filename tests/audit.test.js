/**
 * AUDIT SUITE — every Broker decision is recorded.
 *
 * Denied calls matter most: an allowed call is business as usual, a denied
 * one is the architecture reporting that something tried to step outside its
 * boundary.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DECISION, REASON } from '../src/broker.js';
import { setup, request, approval, messagePayload } from './fixtures.js';

test('32. an ALLOW writes an audit record', () => {
  const ctx = setup();
  ctx.broker.execute(request());
  const decisions = ctx.audit.all().filter((r) => r.event === 'broker.decision');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, DECISION.ALLOW);
});

test('33. a DENY writes an audit record carrying the reason code', () => {
  const ctx = setup();
  ctx.broker.execute(request({ tool_id: 'nonexistent.tool' }));
  const last = ctx.audit.all().find((r) => r.event === 'broker.decision');
  assert.equal(last.decision, DECISION.DENY);
  assert.equal(last.reason, REASON.UNKNOWN_TOOL);
});

test('34. NEEDS_APPROVAL writes an audit record', () => {
  const ctx = setup();
  ctx.broker.execute(request({
    agent_slug: 'yellow-agent', tool_id: 'fake.send_message',
    payload: messagePayload(), idempotency_key: 'audit-1',
  }));
  const rec = ctx.audit.all().find((r) => r.decision === DECISION.NEEDS_APPROVAL);
  assert.ok(rec, 'NEEDS_APPROVAL must be audited');
  assert.equal(rec.reason, REASON.APPROVAL_MISSING);
});

test('35. audit records carry the fields needed to answer "what happened"', () => {
  const payload = messagePayload();
  const ctx = setup({ approvals: [approval({ payload })] });
  ctx.broker.execute(request({
    agent_slug: 'yellow-agent', tool_id: 'fake.send_message', payload, idempotency_key: 'audit-2',
  }));

  for (const field of ['event', 'at', 'agent_slug', 'tool_id', 'task_id', 'action_type', 'tier', 'decision', 'reason', 'idempotency_key']) {
    const rec = ctx.audit.all()[0];
    assert.ok(field in rec, `audit record must carry ${field}`);
  }
  const exec = ctx.audit.all().find((r) => r.event === 'broker.execution');
  assert.equal(exec.executed, true);
  assert.equal(exec.tier, 'YELLOW');
});

test('36. stored audit history cannot be altered by a caller', () => {
  const ctx = setup();
  ctx.broker.execute(request());

  const copy = ctx.audit.all();
  copy[0].decision = 'TAMPERED';
  copy.push({ event: 'forged' });

  const fresh = ctx.audit.all();
  assert.notEqual(fresh[0].decision, 'TAMPERED', 'history must be unchanged');
  assert.equal(fresh.some((r) => r.event === 'forged'), false, 'no record may be injected');
});

test('36b. every denial in a mixed sequence is individually audited', () => {
  const ctx = setup();
  ctx.broker.execute(request());
  ctx.broker.execute(request({ tool_id: 'nonexistent.tool' }));
  ctx.broker.execute(request({ agent_slug: 'ghost-agent' }));
  ctx.broker.execute(request({ agent_slug: 'green-agent', tool_id: 'fake.transfer_funds', payload: { amount: 1 }, idempotency_key: 'q' }));

  const decisions = ctx.audit.all().filter((r) => r.event === 'broker.decision');
  assert.equal(decisions.length, 4);
  assert.deepEqual(decisions.map((r) => r.reason), [
    REASON.OK, REASON.UNKNOWN_TOOL, REASON.UNKNOWN_AGENT, REASON.RED_REQUIRES_HUMAN,
  ]);
});

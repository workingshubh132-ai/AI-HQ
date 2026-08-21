/**
 * POSITIVE-PATH SUITE — only ALLOW reaches a handler.
 *
 * Uses fake and internal tools exclusively. Nothing here touches a network,
 * a credential, or an external service.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DECISION, REASON } from '../src/broker.js';
import { setup, request, approval, messagePayload, TASK } from './fixtures.js';

test('22. valid GREEN action is allowed and executes', () => {
  const ctx = setup();
  const r = ctx.broker.execute(request({ payload: { text: 'hello world from ai hq' } }));
  assert.equal(r.decision, DECISION.ALLOW);
  assert.equal(r.reason, REASON.OK);
  assert.equal(r.executed, true);
  assert.deepEqual(r.result, { words: 5 });
  assert.equal(ctx.invocations(), 1);
});

test('23. GREEN execution charges every applicable budget level exactly once', () => {
  const ctx = setup();
  ctx.broker.execute(request());
  const budgets = ctx.store.budgetsFor(request());
  assert.ok(budgets.length >= 3, 'task, agent_day and global_month should apply');
  for (const b of budgets) assert.equal(b.spent, 1, `${b.level} charged once`);
});

test('24. approved YELLOW action executes exactly once', () => {
  const payload = messagePayload();
  const ctx = setup({ approvals: [approval({ payload })] });
  const r = ctx.broker.execute(request({
    agent_slug: 'yellow-agent', tool_id: 'fake.send_message', payload, idempotency_key: 'send-1',
  }));
  assert.equal(r.decision, DECISION.ALLOW);
  assert.equal(r.executed, true);
  assert.equal(ctx.outbox.length, 1, 'exactly one simulated delivery');
  assert.equal(ctx.outbox[0].to, 'approved-client.example');
});

test('25. an edited approval executes the human payload, not the agent proposal', () => {
  const proposed = messagePayload({ body: 'AGENT DRAFT — too pushy' });
  const edited = messagePayload({ body: 'HUMAN EDIT — polite version' });
  const ctx = setup({ approvals: [approval({ payload: proposed, approved_payload: edited })] });

  const r = ctx.broker.execute(request({
    agent_slug: 'yellow-agent', tool_id: 'fake.send_message',
    payload: proposed, idempotency_key: 'send-2',
  }));

  assert.equal(r.executed, true);
  assert.equal(ctx.outbox.length, 1);
  assert.equal(ctx.outbox[0].body, 'HUMAN EDIT — polite version',
    'the human edit must be what actually executes');
});

test('25b. a human edit that leaves the tool scope is denied', () => {
  const proposed = messagePayload();
  const edited = messagePayload({ recipient_domain: 'somewhere-else.example' });
  const ctx = setup({ approvals: [approval({ payload: proposed, approved_payload: edited })] });

  const r = ctx.broker.execute(request({
    agent_slug: 'yellow-agent', tool_id: 'fake.send_message',
    payload: proposed, idempotency_key: 'send-3',
  }));

  assert.equal(r.decision, DECISION.DENY);
  assert.equal(r.reason, REASON.SCOPE_VIOLATION);
  assert.equal(ctx.outbox.length, 0);
});

test('26. the same idempotency key executes once and replays thereafter', () => {
  const payload = messagePayload();
  const ctx = setup({ approvals: [approval({ payload })] });
  const req = request({
    agent_slug: 'yellow-agent', tool_id: 'fake.send_message', payload, idempotency_key: 'dedupe-1',
  });

  const first = ctx.broker.execute(req);
  const second = ctx.broker.execute(req);
  const third = ctx.broker.execute(req);

  assert.equal(first.executed, true);
  assert.equal(second.executed, false);
  assert.equal(second.replayed, true);
  assert.equal(third.replayed, true);
  assert.deepEqual(second.result, first.result, 'replay returns the recorded result');
  assert.equal(ctx.outbox.length, 1, 'exactly one delivery for three calls');
  assert.equal(ctx.invocations(), 1, 'handler invoked exactly once');
});

test('27. different idempotency keys execute separately', () => {
  const payload = messagePayload();
  const ctx = setup({ approvals: [approval({ payload })] });
  ctx.broker.execute(request({ agent_slug: 'yellow-agent', tool_id: 'fake.send_message', payload, idempotency_key: 'x1' }));
  ctx.broker.execute(request({ agent_slug: 'yellow-agent', tool_id: 'fake.send_message', payload, idempotency_key: 'x2' }));
  assert.equal(ctx.outbox.length, 2);
  assert.equal(ctx.invocations(), 2);
});

test('28. a replay does not charge budget a second time', () => {
  const payload = messagePayload();
  const ctx = setup({ approvals: [approval({ payload })] });
  const req = request({ agent_slug: 'yellow-agent', tool_id: 'fake.send_message', payload, idempotency_key: 'charge-1' });

  ctx.broker.execute(req);
  const afterFirst = ctx.store.budgetsFor(req).map((b) => b.spent);
  ctx.broker.execute(req);
  const afterReplay = ctx.store.budgetsFor(req).map((b) => b.spent);

  assert.deepEqual(afterReplay, afterFirst, 'a replay must not spend again');
});

test('29. a denied call charges no budget', () => {
  const ctx = setup();
  const req = request({ agent_slug: 'green-agent', tool_id: 'fake.send_message', payload: messagePayload(), idempotency_key: 'nope' });
  ctx.broker.execute(req);
  for (const b of ctx.store.budgetsFor(req)) {
    assert.equal(b.spent, 0, `${b.level} must not be charged on a denial`);
  }
});

test('30. an external action without an idempotency key fails closed', () => {
  const payload = messagePayload();
  const ctx = setup({ approvals: [approval({ payload })] });
  const r = ctx.broker.execute(request({
    agent_slug: 'yellow-agent', tool_id: 'fake.send_message', payload, idempotency_key: null,
  }));
  assert.equal(r.decision, DECISION.DENY);
  assert.equal(r.reason, REASON.IDEMPOTENCY_KEY_REQUIRED);
  assert.equal(ctx.outbox.length, 0);
  assert.equal(ctx.invocations(), 0);
});

test('31. authorize() alone never executes anything', () => {
  const payload = messagePayload();
  const ctx = setup({ approvals: [approval({ payload })] });
  const decision = ctx.broker.authorize(request({
    agent_slug: 'yellow-agent', tool_id: 'fake.send_message', payload, idempotency_key: 'auth-only',
  }));
  assert.equal(decision.decision, DECISION.ALLOW);
  assert.equal(ctx.invocations(), 0, 'deciding is not doing');
  assert.equal(ctx.outbox.length, 0);
});

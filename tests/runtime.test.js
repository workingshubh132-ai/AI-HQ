/**
 * MINIMAL RUNTIME
 *
 * Proves one bounded GREEN task executes safely, and that every way of
 * getting it wrong stops before a handler runs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TASK_STATUS, RUNTIME_REASON } from '../src/runtime.js';
import { REASON } from '../src/broker.js';
import { MAX_DEPTH, MAX_FANOUT, MAX_TOTAL_NODES, taskSignature } from '../src/limits.js';
import { validateAgentVersion } from '../src/validator.js';
import { createTools } from '../src/tools.js';
import { demoAgentVersion, DEMO_AGENT_SLUG, DEMO_VERSION_ID } from '../src/demo-agent.js';
import { runtimeSetup, runRequest, VERSION_STATE, RUNTIME_STATE, REGISTRY_SHA, RUN_TASK, RUN_TREE, T0 } from './fixtures.js';

test('88. a valid GREEN task executes end to end', () => {
  const ctx = runtimeSetup();
  const task = ctx.runtime.runTask(runRequest());

  assert.equal(task.status, TASK_STATUS.COMPLETED);
  assert.equal(task.output.status, 'ok');
  assert.deepEqual(task.output.result, { words: 5 });
  assert.deepEqual(task.output.proposed_actions, [], 'a GREEN agent proposes nothing');
  assert.equal(ctx.invocations(), 1, 'the tool ran exactly once');
});

test('89. input violating the contract fails before the handler runs', () => {
  const ctx = runtimeSetup();
  const missing = ctx.runtime.runTask(runRequest({ input: {} }));
  assert.equal(missing.status, TASK_STATUS.FAILED);
  assert.equal(missing.error, 'missing required field: text');

  const wrongType = ctx.runtime.runTask(runRequest({ input: { text: 42 }, task_id: 'task-2' }));
  assert.equal(wrongType.status, TASK_STATUS.FAILED);
  assert.match(wrongType.error, /must be string/);

  assert.equal(ctx.invocations(), 0, 'no handler may run on a contract violation');
});

test('90. an output envelope violating the contract fails the task', () => {
  const badEnvelope = runtimeSetup({
    handlers: { [DEMO_AGENT_SLUG]: () => ({ status: 'ok', result: {} }) },   // no proposed_actions/errors
  });
  const a = badEnvelope.runtime.runTask(runRequest());
  assert.equal(a.status, TASK_STATUS.FAILED);
  assert.match(a.error, /proposed_actions/);

  const badResult = runtimeSetup({
    handlers: {
      [DEMO_AGENT_SLUG]: () => ({ status: 'ok', result: { words: 'five' }, proposed_actions: [], errors: [] }),
    },
  });
  const b = badResult.runtime.runTask(runRequest());
  assert.equal(b.status, TASK_STATUS.FAILED);
  assert.match(b.error, /words must be number/);

  const badStatus = runtimeSetup({
    handlers: { [DEMO_AGENT_SLUG]: () => ({ status: 'great', result: {}, proposed_actions: [], errors: [] }) },
  });
  assert.match(badStatus.runtime.runTask(runRequest()).error, /unrecognised status/);
});

test('91. a paused agent cannot run', () => {
  const ctx = runtimeSetup({ lifecycleState: RUNTIME_STATE.PAUSED });
  const task = ctx.runtime.runTask(runRequest());
  assert.equal(task.status, TASK_STATUS.FAILED);
  assert.equal(task.error, 'state is paused');
  assert.equal(ctx.invocations(), 0);
});

test('92. a frozen agent cannot run', () => {
  const ctx = runtimeSetup({
    freezes: [{ scope: 'agent', target_id: DEMO_AGENT_SLUG, class: 'hard', imposed_by: 'guardian', reason: 'violation', created_at: T0 - 10, expires_at: null }],
  });
  const task = ctx.runtime.runTask(runRequest());
  assert.equal(task.status, TASK_STATUS.FAILED);
  assert.equal(task.error, RUNTIME_REASON.AGENT_FROZEN);
  assert.equal(ctx.invocations(), 0);
});

test('93. a global freeze stops the runtime, not just the Broker', () => {
  const ctx = runtimeSetup({
    freezes: [{ scope: 'global', target_id: null, class: 'hard', imposed_by: 'human', reason: 'emergency stop', created_at: T0 - 10, expires_at: null }],
  });
  const task = ctx.runtime.runTask(runRequest());
  assert.equal(task.status, TASK_STATUS.FAILED);
  assert.equal(ctx.invocations(), 0);
});

test('94. a task with no budget cannot run', () => {
  const ctx = runtimeSetup({ withBudget: false });
  const task = ctx.runtime.runTask(runRequest());
  assert.equal(task.status, TASK_STATUS.FAILED);
  assert.equal(task.error, RUNTIME_REASON.BUDGET_MISSING);
  assert.equal(ctx.invocations(), 0);
});

test('95. an unapproved active version cannot run', () => {
  for (const state of [VERSION_STATE.DRAFT, VERSION_STATE.HUMAN_REVIEW, VERSION_STATE.SUPERSEDED]) {
    const ctx = runtimeSetup({ versionState: state });
    const task = ctx.runtime.runTask(runRequest());
    assert.equal(task.status, TASK_STATUS.FAILED, `${state} must not run`);
    assert.match(task.error, /active version is/);
    assert.equal(ctx.invocations(), 0);
  }
});

test('96. the Broker independently refuses an unapproved version', () => {
  // Defence in depth: even if the runtime pre-flight were bypassed, the
  // Broker refuses the tool call on its own.
  const ctx = runtimeSetup({ versionState: VERSION_STATE.DRAFT });
  const decision = ctx.broker.execute({
    agent_slug: DEMO_AGENT_SLUG, tool_id: 'text.wordcount',
    payload: { text: 'hi' }, task_id: RUN_TASK, tree_id: RUN_TREE,
  });
  assert.equal(decision.reason, REASON.VERSION_NOT_APPROVED);
  assert.equal(ctx.invocations(), 0);
});

test('97. an agent with no resolvable active version cannot run', () => {
  const ctx = runtimeSetup({ activeVersionId: null });
  const task = ctx.runtime.runTask(runRequest());
  assert.equal(task.status, TASK_STATUS.FAILED);
  assert.equal(task.error, 'agent has no resolvable active version');
});

test('98. an unknown agent and a missing handler both fail closed', () => {
  const ctx = runtimeSetup();
  assert.equal(ctx.runtime.runTask(runRequest({ agent_slug: 'ghost-agent' })).error, RUNTIME_REASON.UNKNOWN_AGENT);

  const noHandler = runtimeSetup({ handlers: {} });
  assert.equal(noHandler.runtime.runTask(runRequest()).error, RUNTIME_REASON.NO_HANDLER);
  assert.equal(noHandler.invocations(), 0);
});

test('99. a throwing handler fails the task rather than the process', () => {
  const ctx = runtimeSetup({
    handlers: { [DEMO_AGENT_SLUG]: () => { throw new Error('handler exploded'); } },
  });
  const task = ctx.runtime.runTask(runRequest());
  assert.equal(task.status, TASK_STATUS.FAILED);
  assert.equal(task.error, 'handler exploded');
});

test('100. the audit records agent, version and registry identity', () => {
  const ctx = runtimeSetup();
  ctx.runtime.runTask(runRequest());

  const rec = ctx.audit.all().find((r) => r.event === 'runtime.task');
  assert.ok(rec, 'the task must be audited');
  assert.equal(rec.agent_slug, DEMO_AGENT_SLUG);
  assert.equal(rec.agent_id, 'agent-wordcount');
  assert.equal(rec.agent_version_id, DEMO_VERSION_ID);
  assert.equal(rec.registry_sha, REGISTRY_SHA);
  assert.equal(rec.status, TASK_STATUS.COMPLETED);
  assert.match(rec.signature, /^[a-f0-9]{64}$/);

  // The Broker's own record is still written alongside it.
  assert.ok(ctx.audit.all().some((r) => r.event === 'broker.decision'));
});

test('101. a failed task is audited with its reason', () => {
  const ctx = runtimeSetup({ lifecycleState: RUNTIME_STATE.PAUSED });
  ctx.runtime.runTask(runRequest());
  const rec = ctx.audit.all().find((r) => r.event === 'runtime.task');
  assert.equal(rec.status, TASK_STATUS.FAILED);
  assert.equal(rec.reason, RUNTIME_REASON.AGENT_NOT_ACTIVE);
});

test('102. the task record carries depth, tree and a deterministic signature', () => {
  const ctx = runtimeSetup();
  const task = ctx.runtime.runTask(runRequest());

  assert.equal(task.depth, 0);
  assert.equal(task.tree_id, RUN_TREE);
  assert.equal(task.agent_version_id, DEMO_VERSION_ID);
  assert.equal(task.registry_sha, REGISTRY_SHA);
  assert.equal(
    task.signature,
    taskSignature({ agent_slug: DEMO_AGENT_SLUG, action_type: 'agent.run', input: { text: 'hello world from ai hq' } }),
  );
});

test('103. required_capability is recorded and used for nothing', () => {
  // Capabilities are routing hints. Routing does not exist. A wrong value
  // must not change the outcome.
  const ctx = runtimeSetup();
  const task = ctx.runtime.runTask(runRequest({ required_capability: 'completely.unrelated' }));
  assert.equal(task.status, TASK_STATUS.COMPLETED);
  assert.equal(task.required_capability, 'completely.unrelated');
});

test('104. a handler reaching for a tool outside its allowlist is denied by the Broker', () => {
  // Deliberately wrong routing. The runtime lets the handler ask; the
  // Broker answers no, and nothing leaves.
  let seen = null;
  const ctx = runtimeSetup({
    handlers: {
      [DEMO_AGENT_SLUG]: ({ callTool }) => {
        seen = callTool('fake.send_message', { recipient_domain: 'test.local', body: 'hi' }, 'k1');
        return { status: 'failed', result: { words: 0 }, proposed_actions: [], errors: ['denied'] };
      },
    },
  });
  ctx.runtime.runTask(runRequest());

  assert.equal(seen.decision, 'DENY');
  assert.equal(seen.reason, REASON.TOOL_NOT_ALLOWED);
  assert.equal(ctx.outbox.length, 0, 'nothing may be sent');
});

test('105. an agent version cannot be overwritten once stored', () => {
  const ctx = runtimeSetup();
  assert.throws(
    () => ctx.store.addAgentVersion(demoAgentVersion({ state: VERSION_STATE.APPROVED })),
    /already exists and is immutable/,
  );
  assert.equal(ctx.store.getAgentVersion(DEMO_VERSION_ID).state, VERSION_STATE.APPROVED);
});

test('106. version records are frozen objects', () => {
  const version = demoAgentVersion({ state: VERSION_STATE.APPROVED });
  assert.throws(() => { version.clearance = 'YELLOW'; }, TypeError);
  assert.throws(() => { version.allowed_tools.push('fake.transfer_funds'); }, TypeError);
  assert.equal(version.clearance, 'GREEN');
});

test('107. the shipped demo agent passes the validator', () => {
  // Validator and runtime must agree: what ships must be activatable.
  const { tools } = createTools();
  const r = validateAgentVersion(demoAgentVersion({ state: VERSION_STATE.APPROVED }), { tools });
  assert.equal(r.valid, true, r.errors.join(' | '));
});

test('108. task tree limits are recorded, not yet enforced', () => {
  assert.equal(MAX_DEPTH, 4);
  assert.equal(MAX_FANOUT, 8);
  assert.equal(MAX_TOTAL_NODES, 32);
  // depth × fan-out alone permits catastrophe; the node budget is why it exists
  assert.ok(MAX_FANOUT ** MAX_DEPTH > MAX_TOTAL_NODES * 100);

  const ctx = runtimeSetup();
  assert.equal(ctx.runtime.runTask(runRequest({ depth: MAX_DEPTH + 1 })).error, `depth ${MAX_DEPTH + 1} exceeds ${MAX_DEPTH}`);
});

test('109. the signature is order-independent and input-sensitive', () => {
  const a = taskSignature({ agent_slug: 'x', action_type: 'agent.run', input: { a: 1, b: 2 } });
  const b = taskSignature({ agent_slug: 'x', action_type: 'agent.run', input: { b: 2, a: 1 } });
  const c = taskSignature({ agent_slug: 'x', action_type: 'agent.run', input: { a: 1, b: 3 } });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

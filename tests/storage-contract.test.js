/**
 * STORAGE CONTRACT TESTS
 *
 * Written as a reusable function so the exact same assertions can run
 * against any factory that returns a conforming store — the in-memory
 * implementation today, a future Postgres/Supabase adapter later, with no
 * change to this file beyond adding a second call at the bottom.
 *
 * This file tests the STORE, independent of the Broker's business logic.
 * "Does an unknown agent return null" is tested here as a storage fact;
 * "does the Broker deny an unknown agent" is a separate, already-existing
 * fact tested in deny.test.js. The two must agree, and do — see test 116b.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import { checkStorageContract, STORAGE_CONTRACT } from '../src/storage.js';
import { makeAgent, makeAgentVersion, VERSION_STATE, versionId } from '../src/agents.js';
import { createBroker } from '../src/broker.js';
import { createTools } from '../src/tools.js';

/**
 * @param {string} label
 * @param {() => object} createStore  a zero-arg factory returning a fresh,
 *   empty store. Called once per test so state never leaks between them.
 */
function runStorageContractTests(label, createStore) {
  test(`[${label}] satisfies the formal storage contract`, () => {
    const { ok, errors } = checkStorageContract(createStore());
    assert.equal(ok, true, errors.join(' | '));
  });

  test(`[${label}] getAgent returns null for an unknown slug`, () => {
    assert.equal(createStore().getAgent('ghost'), null);
  });

  test(`[${label}] registerAgent makes the agent visible via getAgent`, () => {
    const store = createStore();
    store.registerAgent(makeAgent({ id: 'a1', slug: 'demo', name: 'Demo' }));
    const resolved = store.getAgent('demo');
    assert.ok(resolved, 'the agent must be retrievable after registration');
    assert.equal(resolved.slug, 'demo');
  });

  test(`[${label}] an unresolved active_version_id yields no clearance, not a throw`, () => {
    const store = createStore();
    store.registerAgent(makeAgent({ id: 'a1', slug: 'demo', active_version_id: 'nowhere@1.0.0' }));
    const resolved = store.getAgent('demo');
    assert.equal(resolved.clearance, undefined);
    assert.equal(resolved.version_state, null);
  });

  test(`[${label}] addAgentVersion stores a retrievable, immutable record`, () => {
    const store = createStore();
    const v = makeAgentVersion({ agent_id: 'a1', version: '1.0.0', clearance: 'GREEN', allowed_tools: [] });
    store.addAgentVersion(v);
    const fetched = store.getAgentVersion(versionId('a1', '1.0.0'));
    assert.equal(fetched.clearance, 'GREEN');
  });

  test(`[${label}] addAgentVersion rejects a duplicate version_id`, () => {
    const store = createStore();
    const v = makeAgentVersion({ agent_id: 'a1', version: '1.0.0', clearance: 'GREEN', allowed_tools: [] });
    store.addAgentVersion(v);
    assert.throws(() => store.addAgentVersion(v), /already exists and is immutable/);
  });

  test(`[${label}] getAgentVersion returns null for an unknown id`, () => {
    assert.equal(createStore().getAgentVersion('nothing@1.0.0'), null);
  });

  test(`[${label}] setActiveVersion re-resolves the flat view`, () => {
    const store = createStore();
    const v = makeAgentVersion({
      agent_id: 'a1', version: '1.0.0', clearance: 'GREEN', allowed_tools: [],
      state: VERSION_STATE.APPROVED, approved_by: 'founder', approved_at: 100,
    });
    store.addAgentVersion(v);
    store.registerAgent(makeAgent({ id: 'a1', slug: 'demo' }));
    assert.equal(store.getAgent('demo').version_state, null, 'no active version yet');

    store.setActiveVersion('demo', versionId('a1', '1.0.0'));
    assert.equal(store.getAgent('demo').version_state, VERSION_STATE.APPROVED);
    assert.equal(store.getAgent('demo').clearance, 'GREEN');
  });

  test(`[${label}] setActiveVersion throws for an unknown agent`, () => {
    assert.throws(() => createStore().setActiveVersion('ghost', 'x@1.0.0'), /unknown agent/);
  });

  test(`[${label}] setLifecycleState changes state without touching the version`, () => {
    const store = createStore();
    store.registerAgent(makeAgent({ id: 'a1', slug: 'demo', lifecycle_state: 'active' }));
    store.setLifecycleState('demo', 'paused');
    assert.equal(store.getAgent('demo').state, 'paused');
  });

  test(`[${label}] createTask then getTask round-trips`, () => {
    const store = createStore();
    store.createTask({ id: 't1', status: 'pending' });
    assert.equal(store.getTask('t1').status, 'pending');
  });

  test(`[${label}] getTask returns null for an unknown id`, () => {
    assert.equal(createStore().getTask('ghost'), null);
  });

  test(`[${label}] updateTask merges a patch and returns the updated record`, () => {
    const store = createStore();
    store.createTask({ id: 't1', status: 'pending', input: { a: 1 } });
    const updated = store.updateTask('t1', { status: 'running' });
    assert.equal(updated.status, 'running');
    assert.deepEqual(updated.input, { a: 1 }, 'unpatched fields survive');
  });

  test(`[${label}] updateTask throws on an unknown id — a silent no-op would hide a bug`, () => {
    assert.throws(() => createStore().updateTask('ghost', { status: 'running' }), /unknown task/);
  });

  test(`[${label}] approvalsForTask filters by task, and starts empty`, () => {
    const store = createStore();
    assert.deepEqual(store.approvalsForTask('t1'), []);
    store.addApproval({ task_id: 't1', status: 'pending' });
    store.addApproval({ task_id: 't2', status: 'pending' });
    const forT1 = store.approvalsForTask('t1');
    assert.equal(forT1.length, 1);
    assert.equal(forT1[0].task_id, 't1');
  });

  test(`[${label}] activeFreeze returns null when nothing is frozen`, () => {
    assert.equal(createStore().activeFreeze('agent', 'demo', 1000), null);
  });

  test(`[${label}] activeFreeze finds a matching, unexpired freeze`, () => {
    const store = createStore();
    store.addFreeze({ scope: 'agent', target_id: 'demo', expires_at: null });
    assert.ok(store.activeFreeze('agent', 'demo', 1000));
  });

  test(`[${label}] activeFreeze ignores an expired freeze`, () => {
    const store = createStore();
    store.addFreeze({ scope: 'agent', target_id: 'demo', expires_at: 500 });
    assert.equal(store.activeFreeze('agent', 'demo', 1000), null, 'expires_at 500 must not be active at now=1000');
    assert.ok(store.activeFreeze('agent', 'demo', 100), 'but must be active before it expires');
  });

  test(`[${label}] activeFreeze scoped 'global' ignores target_id`, () => {
    const store = createStore();
    store.addFreeze({ scope: 'global', target_id: null, expires_at: null });
    assert.ok(store.activeFreeze('global', 'anything-at-all', 1000));
  });

  test(`[${label}] createTaskBudgets creates exactly the applicable levels`, () => {
    const store = createStore();
    const created = store.createTaskBudgets({ task_id: 't1', tree_id: 'tr1', agent_slug: 'demo', limit: 10 });
    assert.equal(created.length, 4, 'task, tree, agent_day, and global_month');
    const found = store.budgetsFor({ task_id: 't1', tree_id: 'tr1', agent_slug: 'demo' });
    assert.equal(found.length, 4);
  });

  test(`[${label}] createTaskBudgets does not duplicate global_month on a second call`, () => {
    const store = createStore();
    store.createTaskBudgets({ task_id: 't1', tree_id: 'tr1', agent_slug: 'demo', limit: 10 });
    store.createTaskBudgets({ task_id: 't2', tree_id: 'tr2', agent_slug: 'demo2', limit: 10 });
    const globals = store.budgetsFor({ task_id: 't2', tree_id: 'tr2', agent_slug: 'demo2' })
      .filter((b) => b.level === 'global_month');
    assert.equal(globals.length, 1, 'global_month must be created once, not once per task');
  });

  test(`[${label}] budgetsFor returns only levels applicable to the given scope`, () => {
    const store = createStore();
    store.createTaskBudgets({ task_id: 't1', tree_id: 'tr1', agent_slug: 'demo', limit: 10 });
    const forOtherTask = store.budgetsFor({ task_id: 'unrelated', tree_id: 'tr1', agent_slug: 'demo' });
    assert.equal(forOtherTask.some((b) => b.level === 'task'), false, 'a task-level budget for t1 must not apply to a different task_id');
  });

  test(`[${label}] chargeBudgets mutates only the budgets it is given, by exactly the cost`, () => {
    const store = createStore();
    store.createTaskBudgets({ task_id: 't1', tree_id: 'tr1', agent_slug: 'demo', limit: 10 });
    const applicable = store.budgetsFor({ task_id: 't1', tree_id: 'tr1', agent_slug: 'demo' });
    store.chargeBudgets(applicable, 3);
    for (const b of store.budgetsFor({ task_id: 't1', tree_id: 'tr1', agent_slug: 'demo' })) {
      assert.equal(b.spent, 3);
    }
  });

  test(`[${label}] getIdempotency returns null for an unknown key`, () => {
    assert.equal(createStore().getIdempotency('ghost'), null);
  });

  test(`[${label}] claimIdempotency marks a key in_flight before recordIdempotency runs`, () => {
    const store = createStore();
    store.claimIdempotency('k1');
    assert.equal(store.getIdempotency('k1').state, 'in_flight');
  });

  test(`[${label}] recordIdempotency stores the final result, replacing the claim`, () => {
    const store = createStore();
    store.claimIdempotency('k1');
    store.recordIdempotency('k1', { state: 'completed', result: { ok: true } });
    const rec = store.getIdempotency('k1');
    assert.equal(rec.state, 'completed');
    assert.deepEqual(rec.result, { ok: true });
  });
}

runStorageContractTests('in-memory store', () => createMemoryStore());

// ── putAgent must not silently return ───────────────────────────────────
test('putAgent is not exposed — a future edit that reintroduces it must fail loudly here', () => {
  // putAgent wrote directly into the flat, resolved `agents` map — the
  // exact map the Broker reads clearance and tool access from — with no
  // resolveAgent() step. Nothing ever called it, but had it been called
  // with a hand-built object like {clearance:'RED', version_state:'approved'},
  // the Broker would have trusted it completely, because the Broker never
  // learns that versions exist. Removed in M6; guarded here so it cannot
  // come back unnoticed. See DECISIONS.md D23.
  const store = createMemoryStore();
  assert.equal(typeof store.putAgent, 'undefined');
});

// ── invariant: the contract itself is not empty and not accidentally huge ──
test('the storage contract lists a bounded, non-trivial method set', () => {
  const count = Object.keys(STORAGE_CONTRACT).length;
  assert.ok(count >= 15 && count <= 30, `contract has ${count} methods — check for drift`);
});

// ── 116b: storage-layer facts and Broker-layer facts must agree ────────────
test('116b. an unresolvable agent is null at the storage layer and DENY at the Broker layer', () => {
  const store = createMemoryStore();
  const { tools } = createTools();
  const audit = { write() {}, all: () => [], count: () => 0, last: () => null };
  const broker = createBroker({ tools, store, audit, clock: () => 1000 });

  assert.equal(store.getAgent('ghost'), null, 'storage fact');

  const decision = broker.authorize({ agent_slug: 'ghost', tool_id: 'text.wordcount', payload: {} });
  assert.equal(decision.decision, 'DENY');
  assert.equal(decision.reason, 'UNKNOWN_AGENT');
});

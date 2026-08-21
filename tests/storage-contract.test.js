/**
 * STORAGE CONTRACT TESTS
 *
 * Written as a reusable function so the exact same assertions can run
 * against any factory that returns a conforming store — the in-memory
 * implementation, and (M11) the real Postgres adapter, with no change to
 * this file beyond the second call at the bottom.
 *
 * Every store call is awaited, uniformly, even for the in-memory store —
 * `await` on a plain (non-Promise) value simply resolves to that value on
 * the next microtask tick, so this is a no-op for createMemoryStore() and
 * a real requirement for createPostgresStore(). One set of assertions,
 * two implementations, proven identical. See DECISIONS.md D28 for why
 * the Postgres adapter is necessarily async while the in-memory store
 * (and everything built on top of it — the Broker, the runtime, the
 * workflow engine, the router, Guardian) remains synchronous.
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
 * @param {() => object} createStore  a zero-arg, SYNCHRONOUS factory
 *   returning a fresh, empty store object (its methods may be async; the
 *   factory itself must not be). For the in-memory store this returns a
 *   genuinely fresh object every call. For a durable store backed by a
 *   real, persistent database, "fresh" is a fiction unless something
 *   clears prior tests' rows first — that is what `beforeEach` is for.
 * @param {() => Promise<void>} [beforeEach]  awaited at the start of every
 *   generated test body. A no-op for the in-memory store (nothing to
 *   clear); truncates all tables for the Postgres store, so each test
 *   still sees the empty-store starting condition its assertions assume.
 */
function runStorageContractTests(label, createStore, beforeEach = async () => {}) {
  test(`[${label}] satisfies the formal storage contract`, async () => {
    await beforeEach();
    const { ok, errors } = checkStorageContract(createStore());
    assert.equal(ok, true, errors.join(' | '));
  });

  test(`[${label}] getAgent returns null for an unknown slug`, async () => {
    await beforeEach();
    assert.equal(await createStore().getAgent('ghost'), null);
  });

  test(`[${label}] registerAgent makes the agent visible via getAgent`, async () => {
    await beforeEach();
    const store = createStore();
    await store.registerAgent(makeAgent({ id: 'a1', slug: 'demo', name: 'Demo' }));
    const resolved = await store.getAgent('demo');
    assert.ok(resolved, 'the agent must be retrievable after registration');
    assert.equal(resolved.slug, 'demo');
  });

  test(`[${label}] an unresolved active_version_id yields no clearance, not a throw`, async () => {
    await beforeEach();
    const store = createStore();
    await store.registerAgent(makeAgent({ id: 'a1', slug: 'demo', name: 'Demo', active_version_id: 'nowhere@1.0.0' }));
    const resolved = await store.getAgent('demo');
    assert.equal(resolved.clearance, undefined);
    assert.equal(resolved.version_state, null);
  });

  test(`[${label}] addAgentVersion stores a retrievable, immutable record`, async () => {
    await beforeEach();
    const store = createStore();
    const v = makeAgentVersion({ agent_id: 'a1', version: '1.0.0', purpose: 'test fixture', clearance: 'GREEN', allowed_tools: [] });
    await store.addAgentVersion(v);
    const fetched = await store.getAgentVersion(versionId('a1', '1.0.0'));
    assert.equal(fetched.clearance, 'GREEN');
  });

  test(`[${label}] addAgentVersion rejects a duplicate version_id`, async () => {
    await beforeEach();
    const store = createStore();
    const v = makeAgentVersion({ agent_id: 'a1', version: '1.0.0', purpose: 'test fixture', clearance: 'GREEN', allowed_tools: [] });
    await store.addAgentVersion(v);
    await assert.rejects(async () => store.addAgentVersion(v), /already exists and is immutable/);
  });

  test(`[${label}] getAgentVersion returns null for an unknown id`, async () => {
    await beforeEach();
    assert.equal(await createStore().getAgentVersion('nothing@1.0.0'), null);
  });

  test(`[${label}] setActiveVersion re-resolves the flat view`, async () => {
    await beforeEach();
    const store = createStore();
    const v = makeAgentVersion({
      agent_id: 'a1', version: '1.0.0', purpose: 'test fixture', clearance: 'GREEN', allowed_tools: [],
      state: VERSION_STATE.APPROVED, approved_by: 'founder', approved_at: 100,
    });
    await store.addAgentVersion(v);
    await store.registerAgent(makeAgent({ id: 'a1', slug: 'demo', name: 'Demo' }));
    assert.equal((await store.getAgent('demo')).version_state, null, 'no active version yet');

    await store.setActiveVersion('demo', versionId('a1', '1.0.0'));
    assert.equal((await store.getAgent('demo')).version_state, VERSION_STATE.APPROVED);
    assert.equal((await store.getAgent('demo')).clearance, 'GREEN');
  });

  test(`[${label}] setActiveVersion throws for an unknown agent`, async () => {
    await beforeEach();
    await assert.rejects(async () => createStore().setActiveVersion('ghost', 'x@1.0.0'), /unknown agent/);
  });

  test(`[${label}] setLifecycleState changes state without touching the version`, async () => {
    await beforeEach();
    const store = createStore();
    await store.registerAgent(makeAgent({ id: 'a1', slug: 'demo', name: 'Demo', lifecycle_state: 'active' }));
    await store.setLifecycleState('demo', 'paused');
    assert.equal((await store.getAgent('demo')).state, 'paused');
  });

  test(`[${label}] createTask then getTask round-trips`, async () => {
    await beforeEach();
    const store = createStore();
    await store.createTask({ id: 't1', status: 'pending', agent_slug: 'demo' });
    assert.equal((await store.getTask('t1')).status, 'pending');
  });

  test(`[${label}] getTask returns null for an unknown id`, async () => {
    await beforeEach();
    assert.equal(await createStore().getTask('ghost'), null);
  });

  test(`[${label}] updateTask merges a patch and returns the updated record`, async () => {
    await beforeEach();
    const store = createStore();
    await store.createTask({ id: 't1', status: 'pending', agent_slug: 'demo', input: { a: 1 } });
    const updated = await store.updateTask('t1', { status: 'running' });
    assert.equal(updated.status, 'running');
    assert.deepEqual(updated.input, { a: 1 }, 'unpatched fields survive');
  });

  test(`[${label}] updateTask throws on an unknown id — a silent no-op would hide a bug`, async () => {
    await beforeEach();
    await assert.rejects(async () => createStore().updateTask('ghost', { status: 'running' }), /unknown task/);
  });

  test(`[${label}] approvalsForTask filters by task, and starts empty`, async () => {
    await beforeEach();
    const store = createStore();
    assert.deepEqual(await store.approvalsForTask('t1'), []);
    await store.createTask({ id: 't1', status: 'pending', agent_slug: 'demo' });
    await store.createTask({ id: 't2', status: 'pending', agent_slug: 'demo' });
    const approvalFixture = { status: 'pending', action_type: 'text.analyze', payload_hash: 'a'.repeat(64), rendered_description: 'A deterministic rendering of the payload' };
    await store.addApproval({ ...approvalFixture, task_id: 't1' });
    await store.addApproval({ ...approvalFixture, task_id: 't2' });
    const forT1 = await store.approvalsForTask('t1');
    assert.equal(forT1.length, 1);
    assert.equal(forT1[0].task_id, 't1');
  });

  test(`[${label}] activeFreeze returns null when nothing is frozen`, async () => {
    await beforeEach();
    assert.equal(await createStore().activeFreeze('agent', 'demo', 1000), null);
  });

  test(`[${label}] activeFreeze finds a matching, unexpired freeze`, async () => {
    await beforeEach();
    const store = createStore();
    await store.addFreeze({ scope: 'agent', target_id: 'demo', expires_at: null });
    assert.ok(await store.activeFreeze('agent', 'demo', 1000));
  });

  test(`[${label}] activeFreeze ignores an expired freeze`, async () => {
    await beforeEach();
    const store = createStore();
    await store.addFreeze({ scope: 'agent', target_id: 'demo', expires_at: 500 });
    assert.equal(await store.activeFreeze('agent', 'demo', 1000), null, 'expires_at 500 must not be active at now=1000');
    assert.ok(await store.activeFreeze('agent', 'demo', 100), 'but must be active before it expires');
  });

  test(`[${label}] activeFreeze scoped 'global' ignores target_id`, async () => {
    await beforeEach();
    const store = createStore();
    await store.addFreeze({ scope: 'global', target_id: null, expires_at: null });
    assert.ok(await store.activeFreeze('global', 'anything-at-all', 1000));
  });

  test(`[${label}] createTaskBudgets creates exactly the applicable levels`, async () => {
    await beforeEach();
    const store = createStore();
    const created = await store.createTaskBudgets({ task_id: 't1', tree_id: 'tr1', agent_slug: 'demo', limit: 10 });
    assert.equal(created.length, 4, 'task, tree, agent_day, and global_month');
    const found = await store.budgetsFor({ task_id: 't1', tree_id: 'tr1', agent_slug: 'demo' });
    assert.equal(found.length, 4);
  });

  test(`[${label}] createTaskBudgets does not duplicate global_month on a second call`, async () => {
    await beforeEach();
    const store = createStore();
    await store.createTaskBudgets({ task_id: 't1', tree_id: 'tr1', agent_slug: 'demo', limit: 10 });
    await store.createTaskBudgets({ task_id: 't2', tree_id: 'tr2', agent_slug: 'demo2', limit: 10 });
    const globals = (await store.budgetsFor({ task_id: 't2', tree_id: 'tr2', agent_slug: 'demo2' }))
      .filter((b) => b.level === 'global_month');
    assert.equal(globals.length, 1, 'global_month must be created once, not once per task');
  });

  test(`[${label}] budgetsFor returns only levels applicable to the given scope`, async () => {
    await beforeEach();
    const store = createStore();
    await store.createTaskBudgets({ task_id: 't1', tree_id: 'tr1', agent_slug: 'demo', limit: 10 });
    const forOtherTask = await store.budgetsFor({ task_id: 'unrelated', tree_id: 'tr1', agent_slug: 'demo' });
    assert.equal(forOtherTask.some((b) => b.level === 'task'), false, 'a task-level budget for t1 must not apply to a different task_id');
  });

  test(`[${label}] chargeBudgets mutates only the budgets it is given, by exactly the cost`, async () => {
    await beforeEach();
    const store = createStore();
    await store.createTaskBudgets({ task_id: 't1', tree_id: 'tr1', agent_slug: 'demo', limit: 10 });
    const applicable = await store.budgetsFor({ task_id: 't1', tree_id: 'tr1', agent_slug: 'demo' });
    await store.chargeBudgets(applicable, 3);
    for (const b of await store.budgetsFor({ task_id: 't1', tree_id: 'tr1', agent_slug: 'demo' })) {
      assert.equal(b.spent, 3);
    }
  });

  test(`[${label}] getIdempotency returns null for an unknown key`, async () => {
    await beforeEach();
    assert.equal(await createStore().getIdempotency('ghost'), null);
  });

  test(`[${label}] claimIdempotency marks a key in_flight before recordIdempotency runs`, async () => {
    await beforeEach();
    const store = createStore();
    await store.claimIdempotency('k1');
    assert.equal((await store.getIdempotency('k1')).state, 'in_flight');
  });

  test(`[${label}] recordIdempotency stores the final result, replacing the claim`, async () => {
    await beforeEach();
    const store = createStore();
    await store.claimIdempotency('k1');
    await store.recordIdempotency('k1', { state: 'completed', result: { ok: true } });
    const rec = await store.getIdempotency('k1');
    assert.equal(rec.state, 'completed');
    assert.deepEqual(rec.result, { ok: true });
  });
}

runStorageContractTests('in-memory store', () => createMemoryStore());

// ── Postgres adapter (M11) — real, but optional: only runs when a local
// test database is configured, so the suite still passes cleanly on any
// machine without one. See scripts/migrate.mjs and DECISIONS.md D28. ────
const PG_TEST_URL = process.env.AI_HQ_TEST_DATABASE_URL;
if (PG_TEST_URL) {
  const { createPostgresStore } = await import('../src/postgres-store.js');
  const { createIsolatedTestDatabase } = await import('./helpers/pg-test-db.mjs');
  // A database of this file's own, migrated fresh — not the shared
  // AI_HQ_TEST_DATABASE_URL directly. node:test runs separate test files
  // concurrently by default; this file and postgres-store.test.js would
  // otherwise race on the same tables. See tests/helpers/pg-test-db.mjs.
  const { pool: pgPool, cleanup } = await createIsolatedTestDatabase('storage_contract');
  const truncateAll = () =>
    pgPool.query(
      'truncate table public.agents, public.agent_versions, public.tasks, public.approvals, ' +
        'public.audit_logs, public.freezes, public.budgets, public.idempotency cascade',
    );

  // Unlike the in-memory store, a real database is not "fresh" just
  // because a new store object was constructed — the tables persist
  // across tests. truncateAll() before EVERY generated test restores the
  // empty-store starting condition every assertion in
  // runStorageContractTests assumes, exactly as createMemoryStore()
  // gives it for free.
  runStorageContractTests('postgres store', () => createPostgresStore(pgPool), truncateAll);

  test('[postgres store] teardown: drop the isolated test database', async () => {
    await cleanup();
  });
} else {
  test('[postgres store] skipped — set AI_HQ_TEST_DATABASE_URL to run against a local Postgres', { skip: true }, () => {});
}

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

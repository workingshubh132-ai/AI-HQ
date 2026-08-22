/**
 * POSTGRES ADAPTER — durability-specific properties (Milestone 11)
 *
 * tests/storage-contract.test.js already proves the Postgres adapter
 * satisfies the exact same behavioral contract as the in-memory store.
 * This file proves the properties that are specific to a REAL database
 * and have no in-memory equivalent to compare against: the migration
 * runner, health/startup checks, and the two concurrency guarantees
 * (idempotency claims, updateTask's row lock) the in-memory store's own
 * header admits it cannot provide.
 *
 * Skipped entirely — not failed — when AI_HQ_TEST_DATABASE_URL is unset,
 * so the suite still passes cleanly on a machine with no local Postgres.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PG_TEST_URL = process.env.AI_HQ_TEST_DATABASE_URL;

if (!PG_TEST_URL) {
  test('[postgres adapter] skipped — set AI_HQ_TEST_DATABASE_URL to run against a local Postgres', { skip: true }, () => {});
} else {
  const { default: pg } = await import('pg');
  const { createPostgresStore, checkPersistenceHealth, validateStartup } = await import('../src/postgres-store.js');
  const { createPostgresAuditSink } = await import('../src/postgres-audit.js');
  const { runMigrations } = await import('../scripts/migrate.mjs');
  const { createIsolatedTestDatabase } = await import('./helpers/pg-test-db.mjs');

  // A database of this file's own, migrated fresh — not the shared
  // AI_HQ_TEST_DATABASE_URL directly. node:test runs separate test files
  // concurrently by default; this file and storage-contract.test.js would
  // otherwise race on the same tables. Tests 220/221/222/226 additionally
  // create their OWN further-isolated databases, one per test, because
  // they specifically exercise migrating a database from zero — this
  // `pool` is the "already-migrated, ready to use" database the rest of
  // this file's tests (223, 225, 227-231) share.
  const { pool, cleanup } = await createIsolatedTestDatabase('postgres_store');

  async function freshTables() {
    await pool.query(
      'truncate table public.agents, public.agent_versions, public.tasks, public.approvals, ' +
        'public.audit_logs, public.freezes, public.budgets, public.idempotency cascade',
    );
  }

  /**
   * Migration files explicitly qualify every statement as `public.*`
   * (matching 0001/0002's own pre-existing convention) — a `search_path`
   * change or a fresh SCHEMA cannot isolate them, since they always
   * target `public` regardless. A genuinely isolated migration test
   * needs a genuinely separate DATABASE. Requires the test role to hold
   * CREATEDB — a local-only grant, see the M11 report; never assumed for
   * the main AI_HQ_TEST_DATABASE_URL connection itself.
   */
  async function withIsolatedDatabase(fn) {
    const url = new URL(PG_TEST_URL);
    const dbName = `ai_hq_migrate_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const admin = new pg.Client({ connectionString: PG_TEST_URL });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    const targetUrl = new URL(PG_TEST_URL);
    targetUrl.pathname = `/${dbName}`;
    const client = new pg.Client({ connectionString: targetUrl.toString() });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
      await admin.query(`drop database if exists ${dbName}`);
      await admin.end();
    }
  }

  // ── migration runner ────────────────────────────────────────────────

  test('220. the migration runner applies every migration to a fresh database, in filename order', async () => {
    await withIsolatedDatabase(async (client) => {
      const { applied, skipped } = await runMigrations(client, join(process.cwd(), 'supabase', 'migrations'));
      assert.ok(applied.length >= 3, 'expects at least the 3 real migration files');
      assert.deepEqual(skipped, []);
      assert.deepEqual([...applied].sort(), applied, 'applied in filename order');
      const { rows } = await client.query(
        `select table_name from information_schema.tables where table_schema = 'public'`,
      );
      const tableNames = rows.map((r) => r.table_name);
      for (const t of ['agents', 'agent_versions', 'tasks', 'approvals', 'freezes', 'budgets', 'idempotency']) {
        assert.ok(tableNames.includes(t), `expected table ${t} to exist after migration`);
      }
    });
  });

  test('221. the migration runner is idempotent — a second run skips everything', async () => {
    await withIsolatedDatabase(async (client) => {
      const migrationsDir = join(process.cwd(), 'supabase', 'migrations');
      const first = await runMigrations(client, migrationsDir);
      const second = await runMigrations(client, migrationsDir);
      assert.equal(second.applied.length, 0);
      assert.deepEqual(second.skipped, first.applied);
    });
  });

  test('222. a failing migration rolls back and is not recorded as applied', async () => {
    await withIsolatedDatabase(async (client) => {
      const dir = mkdtempSync(join(tmpdir(), 'ai-hq-bad-migration-'));
      writeFileSync(join(dir, '0001_broken.sql'), 'create table not_valid_sql_here (');
      try {
        await assert.rejects(async () => runMigrations(client, dir), /0001_broken\.sql failed/);
        const { rows } = await client.query(`select to_regclass('public.not_valid_sql_here') as t`);
        assert.equal(rows[0].t, null, 'the broken statement must not have partially applied');
        const tracked = await client.query('select version from public.schema_migrations');
        assert.equal(tracked.rows.length, 0, 'a failed migration must not be recorded as applied');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── health and startup validation ───────────────────────────────────

  test('223. checkPersistenceHealth reports ok with a measured latency for a live database', async () => {
    const result = await checkPersistenceHealth(pool);
    assert.equal(result.ok, true);
    assert.equal(typeof result.latency_ms, 'number');
    assert.equal(result.error, null);
  });

  test('224. checkPersistenceHealth fails closed, without throwing, for an unreachable database', async () => {
    const badPool = new pg.Pool({ connectionString: 'postgres://nobody:nothing@127.0.0.1:59999/nowhere', connectionTimeoutMillis: 300 });
    const result = await checkPersistenceHealth(badPool);
    assert.equal(result.ok, false);
    assert.ok(result.error);
    await badPool.end().catch(() => {});
  });

  test('225. validateStartup reports a specific pending migration, not a generic failure', async () => {
    const result = await validateStartup(pool, ['0001_initial_schema.sql', '9999_never_written.sql']);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('9999_never_written.sql')));
  });

  test('226. validateStartup fails closed, without throwing, when schema_migrations does not exist yet', async () => {
    // validateStartup queries `public.schema_migrations` explicitly, same
    // convention as the migrations themselves — a fresh DATABASE (not
    // just a schema) is what actually has none yet.
    const url = new URL(PG_TEST_URL);
    const dbName = `ai_hq_validate_test_${Date.now()}`;
    const admin = new pg.Client({ connectionString: PG_TEST_URL });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    const targetUrl = new URL(PG_TEST_URL);
    targetUrl.pathname = `/${dbName}`;
    const scopedPool = new pg.Pool({ connectionString: targetUrl.toString() });
    try {
      const result = await validateStartup(scopedPool, ['0001_initial_schema.sql']);
      assert.equal(result.ok, false);
      assert.ok(result.errors[0].toLowerCase().includes('schema_migrations'));
    } finally {
      await scopedPool.end();
      await admin.query(`drop database if exists ${dbName}`);
      await admin.end();
    }
  });

  // ── the two concurrency guarantees the in-memory store cannot make ──

  test('227. concurrency-safe idempotency: exactly one of many simultaneous claims for the same key wins', async () => {
    await freshTables();
    const store = createPostgresStore(pool);
    const key = 'race-key';
    const attempts = Array.from({ length: 25 }, () => store.claimIdempotency(key).then(() => 'won', () => 'lost'));
    const results = await Promise.all(attempts);
    assert.equal(results.filter((r) => r === 'won').length, 1);
    assert.equal(results.filter((r) => r === 'lost').length, 24);
  });

  test('228. updateTask row-locks: two concurrent patches to different fields of the same task both survive', async () => {
    await freshTables();
    const store = createPostgresStore(pool);
    await store.createTask({ id: 'race-task', status: 'pending', agent_slug: 'demo', error: null, registry_sha: null });
    await Promise.all([
      store.updateTask('race-task', { error: 'patch-A' }),
      store.updateTask('race-task', { registry_sha: 'patch-B' }),
    ]);
    const final = await store.getTask('race-task');
    assert.equal(final.error, 'patch-A');
    assert.equal(final.registry_sha, 'patch-B');
  });

  // ── durable audit sink ───────────────────────────────────────────────

  test('229. the durable audit sink round-trips write/all/count/last, oldest first', async () => {
    await freshTables();
    const audit = createPostgresAuditSink(pool);
    await audit.write({ event: 'a.one', at: 100 });
    await audit.write({ event: 'a.two', at: 200 });
    assert.equal(await audit.count(), 2);
    const all = await audit.all();
    assert.deepEqual(all.map((r) => r.event), ['a.one', 'a.two']);
    assert.equal((await audit.last()).event, 'a.two');
  });

  test('230. the durable audit sink exposes no update or delete method — append-only by construction', () => {
    const audit = createPostgresAuditSink(pool);
    for (const name of ['update', 'delete', 'remove', 'clear', 'truncate']) {
      assert.equal(typeof audit[name], 'undefined', `audit sink must not expose ${name}`);
    }
  });

  // ── structural sweep ─────────────────────────────────────────────────

  test('231. the Postgres adapter files contain no hardcoded credential and no non-local network host', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['../src/postgres-store.js', '../src/postgres-audit.js', '../scripts/migrate.mjs', '../supabase/migrations/0004_agent_versions_immutability_trigger.sql']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      for (const term of ['password', 'PGPASSWORD', 'sk-', 'AKIA', '://root:', 'amazonaws.com', 'supabase.co']) {
        assert.ok(!src.toLowerCase().includes(term.toLowerCase()), `${f} must not contain ${term}`);
      }
    }
  });

  // ── database-level immutability trigger (M16) ────────────────────────
  //
  // tests/storage-contract.test.js already proves addAgentVersion() throws
  // on a duplicate version_id, on both stores. That is INSERT-time
  // protection via the primary key. These tests prove the SEPARATE
  // guarantee migration 0004 adds — an EXISTING row cannot be changed or
  // removed by ANY SQL statement, not merely by "no application method
  // exists to try it." Talks to `pool` directly, deliberately bypassing
  // src/postgres-store.js entirely, because the point is that the
  // database itself refuses this, independent of any application code.

  test('317. an existing agent_versions row survives a direct UPDATE attempt — the database rejects it, not application code', async () => {
    await freshTables();
    await pool.query(
      `insert into public.agent_versions (version_id, agent_id, version, purpose, state, clearance, created_at)
       values ('immutable-test@1.0.0', 'immutable-test', '1.0.0', 'fixture', 'draft', 'GREEN', 0)`,
    );
    await assert.rejects(
      async () => pool.query("update public.agent_versions set clearance = 'YELLOW' where version_id = 'immutable-test@1.0.0'"),
      /agent_versions is immutable/,
    );
    const { rows } = await pool.query("select clearance from public.agent_versions where version_id = 'immutable-test@1.0.0'");
    assert.equal(rows[0].clearance, 'GREEN', 'the row must be byte-for-byte unchanged after the rejected UPDATE');
  });

  test('318. an existing agent_versions row survives a direct DELETE attempt — the database rejects it, not application code', async () => {
    await freshTables();
    await pool.query(
      `insert into public.agent_versions (version_id, agent_id, version, purpose, state, clearance, created_at)
       values ('immutable-test-2@1.0.0', 'immutable-test-2', '1.0.0', 'fixture', 'draft', 'GREEN', 0)`,
    );
    await assert.rejects(
      async () => pool.query("delete from public.agent_versions where version_id = 'immutable-test-2@1.0.0'"),
      /agent_versions is immutable/,
    );
    const { rows } = await pool.query("select 1 from public.agent_versions where version_id = 'immutable-test-2@1.0.0'");
    assert.equal(rows.length, 1, 'the row must still exist after the rejected DELETE');
  });

  test('319. the UPDATE/DELETE rejection is a distinct error from the duplicate-INSERT rejection — the two protections are independently provable', async () => {
    await freshTables();
    await pool.query(
      `insert into public.agent_versions (version_id, agent_id, version, purpose, state, clearance, created_at)
       values ('immutable-test-3@1.0.0', 'immutable-test-3', '1.0.0', 'fixture', 'draft', 'GREEN', 0)`,
    );
    const duplicateInsert = await pool.query(
      `insert into public.agent_versions (version_id, agent_id, version, purpose, state, clearance, created_at)
       values ('immutable-test-3@1.0.0', 'immutable-test-3', '1.0.0', 'fixture', 'draft', 'GREEN', 0)`,
    ).catch((err) => err);
    assert.equal(duplicateInsert.code, '23505', 'duplicate INSERT is a unique_violation, exactly as before this migration');

    const rejectedUpdate = await pool.query("update public.agent_versions set clearance = 'YELLOW' where version_id = 'immutable-test-3@1.0.0'").catch((err) => err);
    assert.equal(rejectedUpdate.code, '23000', 'UPDATE/DELETE is a distinct integrity_constraint_violation, from the new trigger');
    assert.notEqual(rejectedUpdate.code, duplicateInsert.code, 'the two immutability protections are independently distinguishable, not the same mechanism firing twice');
  });

  test('320. addAgentVersion() through the normal application path is completely unaffected by the trigger', async () => {
    await freshTables();
    const store = createPostgresStore(pool);
    const v = await store.addAgentVersion({
      version_id: 'normal-path@1.0.0', agent_id: 'normal-path', version: '1.0.0', purpose: 'fixture',
      state: 'approved', clearance: 'GREEN', allowed_tools: [], created_at: 0,
    });
    assert.equal(v.version_id, 'normal-path@1.0.0');
    const fetched = await store.getAgentVersion('normal-path@1.0.0');
    assert.equal(fetched.clearance, 'GREEN');
  });

  test('321. TRUNCATE still works for bulk test-fixture reset — the trigger targets row-level mutation, not administrative reset', async () => {
    // Row-level BEFORE triggers do not fire on TRUNCATE in Postgres by
    // design — confirmed here explicitly rather than left implicit,
    // because every other test in this suite depends on freshTables()'s
    // TRUNCATE succeeding against this exact table.
    await pool.query(
      `insert into public.agent_versions (version_id, agent_id, version, purpose, state, clearance, created_at)
       values ('truncate-test@1.0.0', 'truncate-test', '1.0.0', 'fixture', 'draft', 'GREEN', 0)`,
    );
    await freshTables();
    const { rows } = await pool.query('select count(*)::int as n from public.agent_versions');
    assert.equal(rows[0].n, 0, 'TRUNCATE must still be able to reset this table between tests');
  });

  after(async () => {
    await cleanup();
  });
}

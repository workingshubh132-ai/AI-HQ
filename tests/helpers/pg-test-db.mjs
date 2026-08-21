/**
 * Per-FILE isolated Postgres test database.
 *
 * node:test runs separate test files concurrently by default (tests
 * within one file run sequentially; different files do not). Two test
 * files both pointed at AI_HQ_TEST_DATABASE_URL directly would race on
 * the same tables — one file's truncate() landing mid-assertion of
 * another. The fix is not to serialize the whole suite (that would slow
 * down every future Postgres-backed test file for everyone); it is to
 * give each file its own database, exactly the isolation a real CI matrix
 * job would have.
 *
 * Requires the AI_HQ_TEST_DATABASE_URL role to hold CREATEDB — true for
 * the local development role this project's own test runs use; never
 * assumed for a real deployment's connection.
 */

import pg from 'pg';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../../scripts/migrate.mjs';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'supabase', 'migrations');

/**
 * @param {string} label short, unique-ish per file (e.g. 'storage_contract')
 * @returns {Promise<{pool: import('pg').Pool, cleanup: () => Promise<void>}>}
 */
export async function createIsolatedTestDatabase(label) {
  const baseUrl = process.env.AI_HQ_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('AI_HQ_TEST_DATABASE_URL is not set');

  const dbName = `ai_hq_test_${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`create database ${dbName}`);

  const targetUrl = new URL(baseUrl);
  targetUrl.pathname = `/${dbName}`;

  const migrationClient = new pg.Client({ connectionString: targetUrl.toString() });
  await migrationClient.connect();
  await runMigrations(migrationClient, MIGRATIONS_DIR);
  await migrationClient.end();

  const pool = new pg.Pool({ connectionString: targetUrl.toString() });

  return {
    pool,
    async cleanup() {
      await pool.end();
      await admin.query(`drop database if exists ${dbName}`);
      await admin.end();
    },
  };
}

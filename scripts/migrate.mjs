// AI-HQ migration runner.
//
// Applies every .sql file in supabase/migrations/, in filename order,
// exactly once each — tracked in a schema_migrations table this script
// creates itself, since no migration file can be trusted to bootstrap its
// own tracking table. Idempotent: re-running is always safe, already-
// applied files are skipped.
//
// Reads the connection string from the AI_HQ_DATABASE_URL environment
// variable, or a --database-url=<url> flag (the flag wins). Deliberately
// NOT the SUPABASE_* variables in .env.example or the DATABASE_URL a
// developer's real project might set elsewhere — this script only ever
// touches whatever URL it is explicitly told to, and never guesses.
//
// This file has never been run against anything but a local, disposable
// test database during development. It contains no credential of its
// own — see .env.example for how a real connection string is supplied.
//
// Run it with:  node scripts/migrate.mjs --database-url=postgres://...
//           or: AI_HQ_DATABASE_URL=postgres://... node scripts/migrate.mjs

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');

function resolveDatabaseUrl(argv) {
  const flag = argv.find((a) => a.startsWith('--database-url='));
  if (flag) return flag.slice('--database-url='.length);
  if (process.env.AI_HQ_DATABASE_URL) return process.env.AI_HQ_DATABASE_URL;
  return null;
}

/**
 * @param {import('pg').Client} client
 * @param {string} migrationsDir
 * @returns {Promise<{applied: string[], skipped: string[]}>}
 */
export async function runMigrations(client, migrationsDir = MIGRATIONS_DIR) {
  await client.query(`
    create table if not exists public.schema_migrations (
      version    text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await client.query('select version from public.schema_migrations');
  const already = new Set(rows.map((r) => r.version));

  const applied = [];
  const skipped = [];
  for (const file of files) {
    if (already.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into public.schema_migrations (version) values ($1)', [file]);
      await client.query('commit');
      applied.push(file);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`migration ${file} failed: ${err.message}`);
    }
  }
  return { applied, skipped };
}

async function main() {
  const databaseUrl = resolveDatabaseUrl(process.argv.slice(2));
  if (!databaseUrl) {
    console.error('No database URL given. Pass --database-url=<url> or set AI_HQ_DATABASE_URL.');
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { applied, skipped } = await runMigrations(client);
    for (const f of skipped) console.log(`  skip   ${f} (already applied)`);
    for (const f of applied) console.log(`  apply  ${f}`);
    console.log(applied.length ? `\n${applied.length} migration(s) applied.` : '\nAlready up to date.');
  } finally {
    await client.end();
  }
}

// Only run as a script — importable as a module for tests without side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

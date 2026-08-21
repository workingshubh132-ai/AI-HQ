/**
 * DURABLE AUDIT SINK (Milestone 11)
 *
 * The same shape as audit.js's createAuditSink() — write/all/count/last —
 * backed by the audit_logs table instead of an in-memory array. Every
 * method here is async for the same reason every postgres-store.js method
 * is: a real network call to Postgres cannot be synchronous in Node.js.
 *
 * NOT wired into the live system, for the same reason postgres-store.js
 * is not: broker.js, runtime.js, workflow.js, router.js, and guardian.js
 * all call `audit.write(...)` synchronously, unawaited, with no
 * expectation the call could fail or take time. See DECISIONS.md D28.
 *
 * append-only, matching audit_logs' own comment in the migration: this
 * file exposes no update or delete method, on purpose — not because one
 * is guarded, but because it does not exist.
 */

export function createPostgresAuditSink(pool) {
  return {
    async write(record) {
      await pool.query(
        'insert into public.audit_logs (event, at, record) values ($1,$2,$3)',
        [record.event ?? null, record.at ?? null, JSON.stringify(record)],
      );
    },

    async all() {
      const { rows } = await pool.query('select record from public.audit_logs order by at asc, id asc');
      return rows.map((r) => r.record);
    },

    async count() {
      const { rows } = await pool.query('select count(*)::int as n from public.audit_logs');
      return rows[0].n;
    },

    async last() {
      const { rows } = await pool.query('select record from public.audit_logs order by at desc, id desc limit 1');
      return rows[0]?.record ?? null;
    },
  };
}

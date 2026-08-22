-- ═══════════════════════════════════════════════════════════════════════
-- AI-HQ — Migration 0005: allow 'disabled' as an agent lifecycle state
-- (Milestone 17)
--
-- src/agents.js's RUNTIME_STATE gained DISABLED in M17 — an explicit
-- administrative off-switch, distinct from PAUSED (lighter, more easily
-- reversed) and RETIRED (permanent). 0003's agents_lifecycle_state_check
-- constraint predates that and would reject the value outright: without
-- this migration, src/postgres-store.js's setLifecycleState() would
-- silently succeed against the in-memory store (store.js validates
-- nothing of its own) but fail with a constraint violation against a
-- real Postgres database — exactly the kind of two-stores-disagree gap
-- src/agent-lifecycle.js (M17) exists to make impossible at the
-- application layer, closed here at the schema layer too.
--
-- A CHECK constraint cannot be altered in place — Postgres requires
-- dropping and re-adding it. This changes only the allowed value set;
-- no column, no other constraint, no existing row is touched.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.agents drop constraint agents_lifecycle_state_check;

alter table public.agents add constraint agents_lifecycle_state_check
  check (lifecycle_state in ('active', 'paused', 'degraded', 'disabled', 'frozen', 'retired'));

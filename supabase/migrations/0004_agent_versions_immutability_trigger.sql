-- ═══════════════════════════════════════════════════════════════════════
-- AI-HQ — Migration 0004: enforce agent_versions immutability at the
-- database level (Milestone 16)
--
-- 0003 already makes a duplicate INSERT impossible — version_id is the
-- primary key, and src/postgres-store.js's addAgentVersion() catches the
-- resulting 23505 unique-violation and turns it into the same
-- "already exists and is immutable" error the in-memory store throws.
-- That covers "a second version cannot be created with the same id." It
-- does NOT cover "an EXISTING version row cannot be changed after the
-- fact" — a primary key does not stop UPDATE or DELETE, only duplicate
-- INSERT. Today nothing in the storage contract exposes a method that
-- could issue either (there is no updateAgentVersion/deleteAgentVersion),
-- so this has never been reachable from application code. This migration
-- makes it unreachable from ANY code, including a future bug, a manual
-- psql session, or a different service sharing this database — a
-- database-level guarantee is strictly stronger than "no caller happens
-- to exist yet."
--
-- ── WHY A TRIGGER, NOT A RULE OR A REVOKE ────────────────────────────────
--
-- A `REVOKE UPDATE, DELETE` would need to name every role that might ever
-- connect, including ones this project does not control (a future
-- Supabase service-role connection, a human operator's own session) and
-- would not produce a message naming WHY the operation was rejected. A
-- BEFORE trigger that raises a clear, named exception is enforced for
-- every role and every access path uniformly, and fails with a message
-- that says exactly what invariant was violated.
--
-- ── SCOPE ─────────────────────────────────────────────────────────────
--
-- agent_versions only. audit_logs and freezes are also documented as
-- append-only by application convention (see their own comments in
-- 0003), but that is a separate decision from THIS migration's — the M16
-- directive's own IMMUTABILITY section is specifically about agent
-- versions ("Once persisted, an existing (agent_id, version) record must
-- not be silently overwritten"). Widening this to other tables was not
-- asked for and is not done here. See DECISIONS.md D33.
-- ═══════════════════════════════════════════════════════════════════════

create function public.agent_versions_reject_mutation() returns trigger as $$
begin
  raise exception using
    errcode = 'integrity_constraint_violation', -- 23000, distinguishable from 23505 (duplicate insert)
    message = format('agent_versions is immutable: %s on version_id %L is not permitted', TG_OP, coalesce(old.version_id, new.version_id));
  return null; -- unreachable; RAISE EXCEPTION always aborts the statement
end;
$$ language plpgsql;

comment on function public.agent_versions_reject_mutation is
  'Unconditionally rejects UPDATE and DELETE on agent_versions. INSERT is untouched — that remains the only way a version row comes into existence, exactly as src/agents.js and src/postgres-store.js already assume.';

create trigger agent_versions_immutable
  before update or delete on public.agent_versions
  for each row execute function public.agent_versions_reject_mutation();

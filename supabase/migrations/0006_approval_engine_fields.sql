-- ═══════════════════════════════════════════════════════════════════════
-- AI-HQ — Migration 0006: approval engine fields (Milestone 18)
--
-- src/approval-engine.js (M18) creates approval records carrying five
-- fields 0001-0003 never anticipated: a stable application-assigned
-- `approval_id` (distinct from this table's own `id uuid` primary key,
-- exactly the same relationship `tasks.id` has to nothing — tasks.id IS
-- already the application-assigned key; approvals took a different path
-- back in 0001 and this migration does not change that now, to avoid
-- rewriting how every existing row's identity works), `version_id` and
-- `registry_sha` (binding an approval to a specific agent version and
-- build, not just an agent), `approval_reference` (how a decision or a
-- revocation POINTS BACK to the record it decides or withdraws, without
-- ever mutating it — see approval-engine.js's header), and `reason` (the
-- human-supplied justification for a request, decision, or revocation).
--
-- Also widens the status check constraint to accept 'revoked' — see
-- broker.js's resolvePerItemApproval and DECISIONS.md D35 for why
-- revocation could not be made fail-closed without the Broker itself
-- recognising the status.
--
-- All five columns are nullable: every row from before this migration
-- (there are none in any real deployment yet, per 0002/0003's own notes,
-- but the schema itself must still be honest) has none of them, and nothing
-- in src/postgres-store.js's existing addApproval() call sites is broken
-- by their absence — approval-engine.js is additive, not a replacement
-- for the pre-M18 fixture shape approval-integrity.test.js still uses.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.approvals add column approval_id text;
alter table public.approvals add column version_id text;
alter table public.approvals add column registry_sha text;
alter table public.approvals add column approval_reference text;
alter table public.approvals add column reason text;

-- Partial: only enforced when an approval_id is actually set, so it
-- never conflicts with any pre-M18 row (all of which have none).
create unique index approvals_approval_id_idx on public.approvals (approval_id) where approval_id is not null;
create index approvals_reference_idx on public.approvals (approval_reference) where approval_reference is not null;

alter table public.approvals drop constraint approvals_status_check;
alter table public.approvals add constraint approvals_status_check
  check (status in ('pending', 'approved', 'rejected', 'revoked'));

-- 0003's approvals_decision_complete_check only ever allowed 'approved' or
-- 'rejected' to require decided_by/decided_at — a 'revoked' row (which,
-- per approval-engine.js, always carries both: who revoked it and when)
-- would violate BOTH branches of that constraint's OR and could never be
-- inserted at all. Widened the same way as the status check above.
alter table public.approvals drop constraint approvals_decision_complete_check;
alter table public.approvals add constraint approvals_decision_complete_check
  check (
    (status = 'pending' and decided_by is null and decided_at is null)
    or (status in ('approved', 'rejected', 'revoked') and decided_by is not null and decided_at is not null)
  );

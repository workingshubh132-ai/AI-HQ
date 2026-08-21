-- ═══════════════════════════════════════════════════════════════════════
-- AI-HQ — Migration 0002: approval payload integrity
--
-- Closes a critical security hole in the v0.1 approval design.
--
-- ── THE HOLE ───────────────────────────────────────────────────────────
--
-- Migration 0001 gave approvals a `summary` column written by the agent.
-- The human read the summary and approved. The Broker then executed the
-- `payload`. Nothing bound the two together:
--
--     agent writes  summary = "Send a polite follow-up to ABC Restaurant"
--     agent writes  payload = { ...something else entirely... }
--     human reads   the summary, approves
--     Broker runs   the PAYLOAD
--
-- Every other control held, and the human consented to one thing while
-- the system performed another. Consent that is not bound to bytes is
-- not consent.
--
-- ── THE FIX ────────────────────────────────────────────────────────────
--
-- 1. `summary` becomes `agent_intent` and is explicitly UNTRUSTED.
--    It is agent-authored text. It authorizes nothing.
--
-- 2. `rendered_description` is generated deterministically by system code
--    from the exact payload. It is exhaustive over the payload's fields,
--    so nothing can hide in an unrendered key. This is what the human
--    reads, and it is authoritative.
--
-- 3. `payload_hash` records what the agent proposed.
--    `approved_payload_hash` records what the human authorized.
--
--    Before execution the Broker computes the hash of the payload it is
--    about to run and compares it to `approved_payload_hash`.
--    Different → DENY. No exceptions.
--
-- Safe to run: table contains zero rows (never connected to a database).
-- ═══════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────
-- 1. summary → agent_intent, demoted to untrusted
-- ───────────────────────────────────────────────────────────────────────
alter table public.approvals rename column summary to agent_intent;

alter table public.approvals drop constraint approvals_summary_length_check;

-- No longer required: it is advisory text, not the human interface.
alter table public.approvals alter column agent_intent drop not null;

alter table public.approvals
  add constraint approvals_agent_intent_length_check
    check (agent_intent is null or char_length(agent_intent) <= 500);

comment on column public.approvals.agent_intent is
  'UNTRUSTED. Agent-authored. Display only, clearly marked. Authorizes nothing.';


-- ───────────────────────────────────────────────────────────────────────
-- 2. Integrity columns
-- ───────────────────────────────────────────────────────────────────────
alter table public.approvals
  add column tool_id               text,
  add column payload_hash          text not null,
  add column approved_payload_hash text,
  add column rendered_description  text not null;

comment on column public.approvals.payload_hash is
  'SHA-256 of the stable serialization of payload. What the agent proposed.';

comment on column public.approvals.approved_payload_hash is
  'SHA-256 of what the human authorized. The Broker compares execution against this.';

comment on column public.approvals.rendered_description is
  'AUTHORITATIVE. System-generated from the payload, exhaustive over its fields. What the human read.';


-- ───────────────────────────────────────────────────────────────────────
-- 3. Constraints
-- ───────────────────────────────────────────────────────────────────────
alter table public.approvals
  add constraint approvals_payload_hash_format_check
    check (payload_hash ~ '^[a-f0-9]{64}$'),

  add constraint approvals_approved_payload_hash_format_check
    check (approved_payload_hash is null or approved_payload_hash ~ '^[a-f0-9]{64}$'),

  add constraint approvals_rendered_description_length_check
    check (char_length(rendered_description) between 10 and 4000),

  -- An approval cannot be granted without recording exactly what was granted.
  -- Together with approvals_decision_complete_check from 0001, a granted
  -- approval must name who decided, when, and over which precise bytes.
  add constraint approvals_granted_requires_hash_check
    check (status <> 'approved' or approved_payload_hash is not null);


comment on table public.approvals is
  'Human approval queue. rendered_description is authoritative; agent_intent is untrusted. Execution is gated on approved_payload_hash.';

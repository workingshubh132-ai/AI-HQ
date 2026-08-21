-- ═══════════════════════════════════════════════════════════════════════
-- AI-HQ — Migration 0001: initial schema
--
-- Creates the four foundation tables:
--   agents       who is allowed to work here
--   tasks        what work exists and how it is going
--   approvals    what is waiting for a human decision
--   audit_logs   what actually happened, in order
--
-- Creates no application logic, no agents, no authentication.
--
-- ── SECURITY MODEL ─────────────────────────────────────────────────────
--
-- Row Level Security is ON for every table, with NO policies. That means
-- the public "anon" key can read and write nothing. Only the server-side
-- service-role key reaches this data, because service_role bypasses RLS.
--
-- The intended architecture is:
--
--     Browser / phone → authenticated AI-HQ backend → Supabase
--
-- and explicitly NOT:
--
--     Browser / phone → service-role key → Supabase
--
-- The service-role key is a full administrator. It must stay on the
-- server, never appear in browser or dashboard code, never be committed,
-- and never appear in documentation or examples as a real value.
--
-- ── AUDIT RULE ─────────────────────────────────────────────────────────
--
-- audit_logs is APPEND-ONLY, enforced by application code in v0.1.
-- AI-HQ code must never UPDATE or DELETE a row in audit_logs.
-- Database-level immutability is deliberately deferred.
-- ═══════════════════════════════════════════════════════════════════════

-- Note: gen_random_uuid() is built into PostgreSQL 13+ and needs no
-- extension on Supabase. Verified on first run.


-- ───────────────────────────────────────────────────────────────────────
-- 1. agents — the staff register
-- ───────────────────────────────────────────────────────────────────────
create table public.agents (
  id            uuid        primary key default gen_random_uuid(),

  -- Stable identifier used by code, e.g. 'echo-agent'. Never the uuid.
  slug          text        not null unique,

  name          text        not null,
  purpose       text        not null,
  version       text        not null default '0.1.0',

  -- The Guardian's off-switch. A paused agent takes no new work.
  status        text        not null default 'active',

  -- Declared capability boundaries. DOCUMENTATION ONLY in v0.1 —
  -- the real safety boundary is the approvals gate, not this column.
  permissions   jsonb       not null default '{}'::jsonb,

  -- Non-security configuration: model, department, capabilities,
  -- config version. Must never be treated as a security boundary.
  metadata      jsonb       not null default '{}'::jsonb,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint agents_status_check
    check (status in ('active', 'paused', 'disabled')),

  -- Forces lowercase-hyphenated slugs so they stay usable as code keys.
  constraint agents_slug_format_check
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

comment on table public.agents is
  'Registry of agents. permissions/metadata are descriptive, not enforcing.';


-- ───────────────────────────────────────────────────────────────────────
-- 2. tasks — the work list
-- ───────────────────────────────────────────────────────────────────────
create table public.tasks (
  id                uuid        primary key default gen_random_uuid(),

  title             text        not null,
  description       text,
  status            text        not null default 'pending',

  -- Agent removed → task survives, unassigned.
  assigned_agent_id uuid        references public.agents (id) on delete set null,

  -- Self-reference: links a subtask to the goal it was split from.
  -- SET NULL, not CASCADE: deleting one goal must never recursively
  -- destroy a whole task tree. Orphaned subtasks survive with no parent.
  -- Retire work with the 'cancelled' status rather than by deleting it.
  parent_task_id    uuid        references public.tasks (id) on delete set null,

  created_by        text        not null default 'human',

  input             jsonb       not null default '{}'::jsonb,
  output            jsonb,
  error             text,

  -- Retry limit. The CHECK below makes an infinite retry loop
  -- impossible to record.
  attempts          integer     not null default 0,
  max_attempts      integer     not null default 3,

  priority          integer     not null default 0,

  created_at        timestamptz not null default now(),
  started_at        timestamptz,
  completed_at      timestamptz,
  updated_at        timestamptz not null default now(),

  constraint tasks_status_check
    check (status in (
      'pending',            -- created, not yet assigned
      'assigned',           -- has an agent, not started
      'running',            -- agent is working
      'awaiting_approval',  -- blocked on a human decision
      'completed',          -- finished successfully
      'failed',             -- failed, may retry
      'paused',             -- retries exhausted, needs a human
      'cancelled'           -- abandoned or rejected
    )),

  constraint tasks_created_by_check
    check (created_by in ('human', 'ai_ceo', 'guardian', 'system')),

  constraint tasks_max_attempts_check
    check (max_attempts between 1 and 10),

  -- Cannot record more attempts than the limit allows.
  constraint tasks_attempts_check
    check (attempts >= 0 and attempts <= max_attempts),

  -- A task cannot be its own parent.
  constraint tasks_no_self_parent_check
    check (parent_task_id is null or parent_task_id <> id)
);

comment on table public.tasks is
  'All work. parent_task_id supports splitting a goal into subtasks.';


-- ───────────────────────────────────────────────────────────────────────
-- 3. approvals — the human decision gate
-- ───────────────────────────────────────────────────────────────────────
create table public.approvals (
  id               uuid        primary key default gen_random_uuid(),

  task_id          uuid        not null references public.tasks (id) on delete cascade,
  agent_id         uuid        references public.agents (id) on delete set null,

  action_type      text        not null,

  -- Plain-English statement of what is being approved. This is the
  -- text the human CEO reads on a phone. It must stand alone.
  summary          text        not null,

  -- Exactly what the agent proposed. Never modified after creation.
  payload          jsonb       not null,

  status           text        not null default 'pending',

  -- What the human actually approved, if they edited before approving.
  -- Kept separate so the original proposal is never lost.
  approved_payload jsonb,

  decided_by       text,
  decided_at       timestamptz,
  decision_note    text,

  created_at       timestamptz not null default now(),

  constraint approvals_status_check
    check (status in ('pending', 'approved', 'rejected')),

  -- A decision cannot exist without a decider and a timestamp,
  -- and a pending item cannot carry either.
  constraint approvals_decision_complete_check
    check (
      (status = 'pending'
        and decided_by is null
        and decided_at is null)
      or
      (status in ('approved', 'rejected')
        and decided_by is not null
        and decided_at is not null)
    ),

  -- Forces a real sentence, and keeps it readable on a phone.
  constraint approvals_summary_length_check
    check (char_length(summary) between 10 and 500)
);

comment on table public.approvals is
  'Human approval queue. payload is the proposal; approved_payload is what was authorised.';


-- ───────────────────────────────────────────────────────────────────────
-- 4. audit_logs — permanent history
--
-- APPEND-ONLY. Application code must never UPDATE or DELETE here.
-- Every foreign key uses ON DELETE SET NULL so history outlives the
-- rows it describes, and agent_slug keeps a readable copy of the name.
-- ───────────────────────────────────────────────────────────────────────
create table public.audit_logs (
  id           uuid        primary key default gen_random_uuid(),

  occurred_at  timestamptz not null default now(),

  actor_type   text        not null,
  actor_id     text,

  -- Dotted event name, e.g. 'task.created', 'approval.granted'.
  action       text        not null,

  task_id      uuid        references public.tasks (id)     on delete set null,
  approval_id  uuid        references public.approvals (id) on delete set null,
  agent_id     uuid        references public.agents (id)    on delete set null,

  -- Deliberate copy of agents.slug so the record stays readable
  -- even if the agent row is later removed.
  agent_slug   text,

  status       text        not null default 'success',
  details      jsonb       not null default '{}'::jsonb,
  error        text,

  constraint audit_logs_actor_type_check
    check (actor_type in ('human', 'agent', 'system')),

  constraint audit_logs_status_check
    check (status in ('success', 'failure'))
);

comment on table public.audit_logs is
  'Append-only history. Application code must never update or delete rows here.';


-- ───────────────────────────────────────────────────────────────────────
-- 5. Indexes for the queries v0.1 will actually run
-- ───────────────────────────────────────────────────────────────────────

-- The phone approval queue: pending items, oldest first.
create index approvals_pending_idx
  on public.approvals (created_at)
  where status = 'pending';

-- "What is running / paused / waiting?"
create index tasks_status_idx on public.tasks (status);

-- Walking a goal's subtasks.
create index tasks_parent_idx on public.tasks (parent_task_id);

-- Reading recent history newest-first.
create index audit_logs_occurred_at_idx on public.audit_logs (occurred_at desc);


-- ───────────────────────────────────────────────────────────────────────
-- 6. Row Level Security
--
-- Enabled with NO policies on every table. With RLS on and no policy,
-- PostgreSQL denies all access by default, so the public anon key can
-- read and write nothing.
--
-- The server-side service-role key bypasses RLS by design. It is the
-- only credential that may touch these tables in v0.1.
--
-- Policies get written when the dashboard gains real user logins.
-- ───────────────────────────────────────────────────────────────────────
alter table public.agents     enable row level security;
alter table public.tasks      enable row level security;
alter table public.approvals  enable row level security;
alter table public.audit_logs enable row level security;

-- ═══════════════════════════════════════════════════════════════════════
-- AI-HQ — Migration 0003: bring the schema current with the M5–M10
-- control-plane data model (agents/versions, workflow tasks, freezes,
-- budgets, idempotency, and a truthful audit_logs shape).
--
-- ── WHY THIS DROPS AND RECREATES, RATHER THAN ALTERS ─────────────────────
--
-- 0001/0002 modeled the v0.1 skeleton from Milestone 2 — before the
-- agents/agent_versions split (M5), before the workflow/task-tree engine
-- (M8), before budgets, freezes, and idempotency existed as first-class
-- concepts. Neither migration has ever run against a real database (see
-- 0002's own header: "table contains zero rows"). There is no production
-- data anywhere for any of these tables. Altering a schema that has never
-- been live, column by column, to simulate a real migration history that
-- does not exist, would be theater. Dropping and recreating is the honest
-- operation for a schema that was designed, then superseded by seven
-- milestones of real implementation work, before it was ever deployed.
--
-- ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────
--
-- Creates no RLS policies beyond re-enabling RLS with none, exactly as
-- 0001 did — every table still denies the public anon key everything.
-- Grants no application logic. Connects to nothing — this file only runs
-- when explicitly applied via scripts/migrate.mjs against a database URL
-- the operator supplies; it is never executed automatically.
-- ═══════════════════════════════════════════════════════════════════════

-- schema_migrations (the runner's own bootstrap tracking table) is
-- created by scripts/migrate.mjs before ANY migration file runs, this
-- one included — it cannot depend on this file to exist yet.

drop table if exists public.audit_logs cascade;
drop table if exists public.approvals cascade;
drop table if exists public.tasks cascade;
drop table if exists public.agents cascade;

-- ───────────────────────────────────────────────────────────────────────
-- 1. agents — mutable runtime state only (agents.js RUNTIME_STATE)
-- ───────────────────────────────────────────────────────────────────────
create table public.agents (
  -- The application always assigns its own readable id (e.g.
  -- 'agent-wordcount'), never a generated uuid — see makeAgent() in
  -- src/agents.js. text, not uuid, to match exactly what is written.
  id                text        primary key,
  slug              text        not null unique,
  name              text        not null,

  lifecycle_state   text        not null default 'active',
  active_version_id text,

  -- Router-only scheduling metadata (M9). NOT security-authoritative —
  -- the Broker never reads it. Null means "use the router's own default
  -- ceiling." See DECISIONS.md D26.
  concurrency_limit integer,

  created_at        bigint      not null,
  updated_at        bigint      not null,

  constraint agents_slug_format_check
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint agents_lifecycle_state_check
    check (lifecycle_state in ('active', 'paused', 'degraded', 'frozen', 'retired'))
);

comment on table public.agents is
  'Mutable runtime state (agents.js). Security-authoritative fields (clearance, allowed_tools) live on agent_versions, never here.';


-- ───────────────────────────────────────────────────────────────────────
-- 2. agent_versions — IMMUTABLE configuration (agents.js VERSION_STATE)
--
-- No updated_at. No UPDATE statement is ever issued against this table by
-- application code — the primary key on version_id is what makes
-- addAgentVersion() throw on a duplicate, mirroring the in-memory store's
-- own "throws on a version_id that already exists" invariant exactly.
-- ───────────────────────────────────────────────────────────────────────
create table public.agent_versions (
  version_id            text        primary key, -- `${agent_id}@${version}`
  -- Deliberately NO foreign key to agents.id. Every real call site in
  -- this codebase adds a version BEFORE the agent record exists yet —
  -- see storage-contract.test.js's own "addAgentVersion, then
  -- registerAgent" ordering, used everywhere — and storage-contract.test
  -- also registers an agent whose active_version_id points at a version
  -- that never exists at all, to exercise the fail-closed "unresolvable
  -- version" path. A referential constraint here would make both
  -- impossible and diverge from the in-memory store's real behavior.
  agent_id              text        not null,
  version               text        not null,
  purpose               text        not null,
  department            text,
  state                 text        not null default 'draft',

  -- security-authoritative — read by the Broker via resolveAgent()
  clearance             text        not null,
  allowed_tools         jsonb       not null default '[]'::jsonb,
  scopes                jsonb,
  limits                jsonb       not null default '{}'::jsonb,

  -- advisory — the Broker ignores these; router.js (M9) reads them
  capabilities          jsonb       not null default '[]'::jsonb,
  allowed_workflow_types jsonb      not null default '[]'::jsonb,
  input_contract        jsonb       not null default '{}'::jsonb,
  output_contract       jsonb       not null default '{}'::jsonb,
  quality_criteria      text,
  model_config          jsonb       not null default '{}'::jsonb,
  metadata              jsonb       not null default '{}'::jsonb,

  created_at            bigint      not null,
  approved_by            text,
  approved_at            bigint,

  constraint agent_versions_version_format_check
    check (version ~ '^\d+\.\d+\.\d+$'),
  constraint agent_versions_state_check
    check (state in ('draft', 'human_review', 'approved', 'superseded')),
  constraint agent_versions_clearance_check
    check (clearance in ('GREEN', 'YELLOW'))
);

comment on table public.agent_versions is
  'Immutable agent configuration. Never UPDATEd or DELETEd by application code — a new version is a new row.';


-- ───────────────────────────────────────────────────────────────────────
-- 3. tasks — the M8 task-tree shape (runtime.js / workflow.js)
-- ───────────────────────────────────────────────────────────────────────
create table public.tasks (
  id                  text        primary key,
  parent_task_id      text        references public.tasks (id) on delete set null,
  tree_id             text,
  workflow_id         text,
  depth               integer     not null default 0,

  -- taskSignature() output — 64 hex chars, the loop/duplicate-work detector
  signature           text,

  agent_slug          text        not null,
  agent_id            text        references public.agents (id) on delete set null,
  -- No FK, same reason as agent_versions.agent_id above: runtime.js
  -- creates a task record BEFORE its pre-flight checks run, so a task
  -- for an agent with a dangling/unresolvable active_version_id can be
  -- created with an agent_version_id that names a version which does
  -- not exist — that is the FAILING task the pre-flight is about to
  -- reject, and creating its record must not itself fail first.
  agent_version_id    text,
  required_capability text,

  -- ordered list of task ids this task depends on (workflow.js)
  depends_on          jsonb       not null default '[]'::jsonb,

  input               jsonb       not null default '{}'::jsonb,
  output              jsonb,
  status              text        not null default 'pending',

  attempt_number      integer     not null default 1,
  retry_of_task_id    text        references public.tasks (id) on delete set null,

  error               text,
  failure_reason_code text,

  created_at          bigint      not null,
  started_at          bigint,
  completed_at        bigint,
  registry_sha        text,

  constraint tasks_status_check
    check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  constraint tasks_no_self_parent_check
    check (parent_task_id is null or parent_task_id <> id),
  constraint tasks_signature_format_check
    check (signature is null or signature ~ '^[a-f0-9]{64}$')
);

comment on table public.tasks is
  'Task-tree records (M8). tree_id and workflow_id are the same value throughout — see DECISIONS.md D25.';


-- ───────────────────────────────────────────────────────────────────────
-- 4. approvals — the human decision gate, with payload/description
--    integrity (0002's fix, carried forward with the missing expires_at
--    column 0002 never added)
-- ───────────────────────────────────────────────────────────────────────
create table public.approvals (
  id                     uuid        primary key default gen_random_uuid(),

  task_id                text        not null references public.tasks (id) on delete cascade,
  agent_id               text        references public.agents (id) on delete set null,

  action_type            text        not null,
  tool_id                text,

  -- UNTRUSTED. Agent-authored. Display only. Authorizes nothing.
  agent_intent           text,

  -- Exactly what the agent proposed. Never modified after creation.
  payload                jsonb       not null,
  payload_hash           text        not null,

  status                 text        not null default 'pending',

  approved_payload       jsonb,
  approved_payload_hash  text,

  -- AUTHORITATIVE. System-generated from the payload, exhaustive over
  -- its fields. What the human actually read before deciding.
  rendered_description   text        not null,

  decided_by             text,
  decided_at             bigint,
  expires_at             bigint,

  created_at             bigint      not null,

  constraint approvals_status_check
    check (status in ('pending', 'approved', 'rejected')),
  constraint approvals_payload_hash_format_check
    check (payload_hash ~ '^[a-f0-9]{64}$'),
  constraint approvals_approved_payload_hash_format_check
    check (approved_payload_hash is null or approved_payload_hash ~ '^[a-f0-9]{64}$'),
  constraint approvals_granted_requires_hash_check
    check (status <> 'approved' or approved_payload_hash is not null),
  constraint approvals_decision_complete_check
    check (
      (status = 'pending' and decided_by is null and decided_at is null)
      or (status in ('approved', 'rejected') and decided_by is not null and decided_at is not null)
    )
);

comment on table public.approvals is
  'Human approval queue. rendered_description is authoritative; agent_intent is untrusted. Execution is gated on approved_payload_hash.';


-- ───────────────────────────────────────────────────────────────────────
-- 5. audit_logs — append-only, one row per audit.write() call
--
-- The old 0001 shape (actor_type/actor_id/action/details) never matched
-- what audit.js actually writes — event-specific field sets that vary by
-- event type (runtime.task, broker.decision, workflow.*, router.*,
-- guardian.*). `record` stores the complete object exactly as
-- audit.write() received it; `event`/`at` are pulled out as real columns
-- because every event type carries both, and they are what queries
-- filter and sort on.
-- ───────────────────────────────────────────────────────────────────────
create table public.audit_logs (
  id      uuid    primary key default gen_random_uuid(),
  event   text    not null,
  at      bigint  not null,
  record  jsonb   not null
);

comment on table public.audit_logs is
  'Append-only. Application code must never UPDATE or DELETE a row here. record is the complete audit.write() payload.';


-- ───────────────────────────────────────────────────────────────────────
-- 6. freezes — append-only. Soft freezes carry expires_at; hard freezes
--    (imposed_by = 'guardian' for a global emergency, or by a human) do
--    not, and there is deliberately no UPDATE/DELETE path — see
--    src/guardian.js's header and DECISIONS.md D27.
-- ───────────────────────────────────────────────────────────────────────
create table public.freezes (
  id          uuid    primary key default gen_random_uuid(),
  scope       text    not null,
  target_id   text,
  reason      text,
  imposed_by  text,
  imposed_at  bigint,
  expires_at  bigint,

  constraint freezes_scope_check
    check (scope in ('agent', 'workflow', 'ai_ceo', 'global'))
);

comment on table public.freezes is
  'Append-only. A soft freeze self-expires via expires_at; a hard freeze (expires_at null) has no lift mechanism yet — human release only.';


-- ───────────────────────────────────────────────────────────────────────
-- 7. budgets — task | tree | agent_day | global_month levels (store.js)
-- ───────────────────────────────────────────────────────────────────────
create table public.budgets (
  id         uuid     primary key default gen_random_uuid(),
  level      text     not null,
  target_id  text,
  "limit"    numeric  not null,
  spent      numeric  not null default 0,

  constraint budgets_level_check
    check (level in ('task', 'tree', 'agent_day', 'global_month'))
);

comment on table public.budgets is
  'COST_UNITS, a fictional unit — never real currency. numeric, not integer: model-runtime.js costs are fractional.';


-- ───────────────────────────────────────────────────────────────────────
-- 8. idempotency — the ONE table where the primary key IS the safety
--    mechanism. claimIdempotency() must INSERT, never UPSERT: a unique-
--    violation on this key is the concurrency-safe "someone already
--    claimed it" signal store.js's own header names as the missing piece
--    of the in-memory implementation. See src/postgres-store.js.
-- ───────────────────────────────────────────────────────────────────────
create table public.idempotency (
  key     text  primary key,
  state   text  not null,
  result  jsonb,
  error   text,

  constraint idempotency_state_check
    check (state in ('in_flight', 'completed', 'failed'))
);

comment on table public.idempotency is
  'The primary key on `key` is the concurrency-safety mechanism. Never upsert this table.';


-- ───────────────────────────────────────────────────────────────────────
-- 9. Indexes for the queries the current code actually runs
-- ───────────────────────────────────────────────────────────────────────
create index approvals_task_idx           on public.approvals (task_id);
create index approvals_pending_idx        on public.approvals (created_at) where status = 'pending';
create index tasks_status_idx             on public.tasks (status);
create index tasks_parent_idx             on public.tasks (parent_task_id);
create index tasks_tree_idx               on public.tasks (tree_id);
create index audit_logs_at_idx            on public.audit_logs (at desc);
create index audit_logs_event_idx         on public.audit_logs (event);
create index freezes_scope_target_idx     on public.freezes (scope, target_id);
create index budgets_level_target_idx     on public.budgets (level, target_id);
create index agent_versions_agent_idx     on public.agent_versions (agent_id);


-- ───────────────────────────────────────────────────────────────────────
-- 10. Row Level Security — enabled with NO policies, exactly as 0001.
--     The public anon key reads and writes nothing on any of these
--     tables. Only a server-side credential (never the anon key) may
--     reach this data, and that credential never appears in this repo.
-- ───────────────────────────────────────────────────────────────────────
alter table public.agents         enable row level security;
alter table public.agent_versions enable row level security;
alter table public.tasks          enable row level security;
alter table public.approvals      enable row level security;
alter table public.audit_logs     enable row level security;
alter table public.freezes        enable row level security;
alter table public.budgets        enable row level security;
alter table public.idempotency    enable row level security;

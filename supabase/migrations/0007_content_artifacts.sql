-- ═══════════════════════════════════════════════════════════════════════
-- AI-HQ — Migration 0007: content artifacts (Milestone 19)
--
-- A new table, `public.artifacts`, for src/artifact-service.js's
-- provider-neutral content records — research, scripts, audio, images,
-- video, captions, social packages, and whatever future artifact types
-- get added to src/artifacts.js's ARTIFACT_TYPE registry.
--
-- ── DELIBERATELY NOT PART OF THE EXISTING CONTROL-PLANE TABLES ──────────
--
-- This table is read and written only by artifact-store.js /
-- postgres-artifact-store.js's own small ARTIFACT_STORE_CONTRACT — never
-- by the Broker, Guardian, Approval Engine, or Resource Governor, none of
-- which reference it. Kept separate from agents/tasks/approvals/freezes/
-- budgets/idempotency for the same reason storage.js's own STORAGE_CONTRACT
-- comment gives for keeping concerns apart: mixing an authorization-
-- critical contract with an unrelated one invites exactly the kind of
-- confusion this project has repeatedly avoided. See DECISIONS.md D36.
--
-- ── WHY parent_artifact_ids IS A PLAIN jsonb ARRAY, NOT A JOIN TABLE ─────
--
-- A self-referencing many-to-many join table (`artifact_parents(child,
-- parent)`) would let Postgres enforce per-edge referential integrity —
-- more "correct" for a DAG in the abstract. But `public.tasks.depends_on`
-- already models an identical "this row references other rows in the
-- same table" relationship as a plain `jsonb` array with zero FK
-- enforcement (see migration 0003), and every actual integrity check for
-- artifact lineage (parent existence, same-workflow, no cycle) already
-- happens in artifact-service.js BEFORE a row is ever written — the
-- database does not need to re-derive them. Matching the existing
-- precedent was preferred over introducing a second, inconsistent way of
-- representing the same kind of relationship.
--
-- ── artifact_type HAS A CHECK CONSTRAINT, THE SAME TRADEOFF AS D34 ───────
--
-- src/artifacts.js documents ARTIFACT_TYPE as "extensible" — meaning new
-- types are added by a source change, not a runtime-supplied string.
-- migration 0005 already established the precedent for this exact
-- tradeoff (RUNTIME_STATE gained DISABLED, and the matching CHECK
-- constraint had to be widened by a migration): a listed CHECK constraint
-- costs a future migration when the registry grows, in exchange for the
-- database itself refusing a garbage type string. Following that
-- precedent rather than leaving the column unconstrained.
-- ═══════════════════════════════════════════════════════════════════════

create table public.artifacts (
  -- Application-assigned (`artifact-<clock>-<uuid>`, see
  -- artifact-service.js's generateArtifactId) — text, not a generated
  -- uuid, to match exactly what is written, same reasoning as
  -- agents.id and tasks.id.
  artifact_id           text        primary key,

  artifact_type         text        not null,
  status                text        not null default 'complete',

  -- tree_id IS workflow_id throughout this codebase (see workflow.js's
  -- own header comment) — no FK: workflows themselves are never
  -- persisted anywhere (workflow.js's in-memory `workflows` Map is
  -- process-local), so there is nothing here to reference.
  workflow_id           text        not null,
  -- Nullable: not every artifact belongs to exactly one task (a
  -- workflow-level rollup, e.g. a social package aggregating several
  -- tasks' outputs, legitimately has none). When present, it must
  -- resolve and belong to the declared workflow_id — enforced in
  -- artifact-service.js, not by this FK alone.
  task_id               text        references public.tasks (id) on delete set null,

  -- RE-DERIVED by artifact-service.js from store.getAgent(agent_slug) —
  -- never accepted from a creation request directly. See that file's
  -- header for why this is the anti-impersonation mechanism.
  agent_id              text        references public.agents (id) on delete set null,
  -- No FK, same reasoning as tasks.agent_version_id and
  -- approvals.version_id: an immutable historical fact about what WAS
  -- true at creation time, not a live reference required to keep
  -- resolving.
  version_id            text,
  registry_sha          text,

  parent_artifact_ids   jsonb       not null default '[]'::jsonb,

  -- Inline content OR an opaque out-of-band reference — never both, per
  -- artifact-service.js's validation. content_ref is NOT resolved,
  -- fetched, or validated as a real location by anything in this
  -- codebase; its interpretation belongs to a future storage/provider
  -- milestone.
  content               jsonb,
  content_ref           text,
  mime_type             text,
  size                  bigint,
  checksum              text,

  created_at            bigint      not null,

  -- provider_id / provider_version / model_id / generation_metadata are
  -- informational only — never read by the Broker, Guardian, or
  -- Approval Engine, and never a source of authorization.
  provider_id           text,
  provider_version      text,
  model_id              text,
  generation_metadata   jsonb,

  -- Descriptive only, reusing the Approval Engine's own status
  -- vocabulary plus 'not_required' — see artifacts.js's header. Setting
  -- this column approves nothing; the real decision, if any, is made by
  -- a human calling approval-engine.js's own decide().
  approval_status        text        not null default 'not_required',

  constraint artifacts_type_check
    check (artifact_type in (
      'RESEARCH', 'ARTICLE', 'TEXT', 'SCRIPT', 'AUDIO', 'IMAGE',
      'THUMBNAIL', 'VIDEO', 'SUBTITLE', 'EDIT_INSTRUCTION', 'SOCIAL_PACKAGE'
    )),
  constraint artifacts_status_check
    check (status in ('complete', 'failed')),
  constraint artifacts_approval_status_check
    check (approval_status in ('not_required', 'pending', 'approved', 'rejected', 'revoked')),
  constraint artifacts_checksum_format_check
    check (checksum is null or checksum ~ '^[a-f0-9]{64}$'),
  constraint artifacts_size_check
    check (size is null or size >= 0)
);

create index artifacts_workflow_idx on public.artifacts (workflow_id);
create index artifacts_task_idx on public.artifacts (task_id) where task_id is not null;
-- GIN index so childrenOf(artifact_id) — "every row whose
-- parent_artifact_ids contains this id" — is an indexed containment
-- query, not a sequential scan, once real data volume exists.
create index artifacts_parent_ids_gin_idx on public.artifacts using gin (parent_artifact_ids);

alter table public.artifacts enable row level security;

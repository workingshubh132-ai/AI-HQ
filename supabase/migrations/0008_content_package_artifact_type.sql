-- ═══════════════════════════════════════════════════════════════════════
-- AI-HQ — Migration 0008: allow 'CONTENT_PACKAGE' as an artifact_type
-- (Milestone 23)
--
-- src/artifacts.js's ARTIFACT_TYPE gained CONTENT_PACKAGE in M23 — a
-- final, governed package produced by the Content Factory's
-- publishing-package-agent that REFERENCES other immutable artifacts
-- (via parent_artifact_ids) rather than copying their content. 0007's
-- artifacts_type_check constraint predates this and would reject the
-- value outright — the same gap migration 0005 closed for
-- lifecycle_state, using the identical fix: a CHECK constraint cannot be
-- altered in place, so it is dropped and re-added with the wider value
-- set. This changes only the allowed value set; no column, no other
-- constraint, no existing row is touched.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.artifacts drop constraint artifacts_type_check;

alter table public.artifacts add constraint artifacts_type_check
  check (artifact_type in (
    'RESEARCH', 'ARTICLE', 'TEXT', 'SCRIPT', 'AUDIO', 'IMAGE',
    'THUMBNAIL', 'VIDEO', 'SUBTITLE', 'EDIT_INSTRUCTION', 'SOCIAL_PACKAGE',
    'CONTENT_PACKAGE'
  ));

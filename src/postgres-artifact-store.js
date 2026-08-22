/**
 * POSTGRES ARTIFACT STORE (Milestone 19)
 *
 * A real, durable implementation of `ARTIFACT_STORE_CONTRACT`
 * (artifact-store.js) — proven against the exact same assertions as the
 * in-memory implementation via tests/artifacts.test.js's gated Postgres
 * section, mirroring how postgres-store.js and the in-memory store share
 * tests/storage-contract.test.js's harness.
 *
 * NOT wired into artifact-service.js's default construction, and not on
 * the live synchronous security core's call path — same D28 boundary
 * postgres-store.js's own header documents, restated here because
 * artifact-service.js is itself async by design (see that file's
 * header), not because this adapter introduces a new boundary.
 *
 * Constitution: sections 6, 7, 25.
 */

/** Postgres returns bigint columns as strings by default. Every bigint
 * column here (created_at, size) is well inside JS's safe-integer
 * range — Number(...) is correct and safe. Same helper postgres-store.js
 * already uses, duplicated rather than imported: these are two
 * independent adapters over two independent, unrelated tables, and
 * sharing a five-line pure function is not worth a coupling between them. */
const num = (v) => (v === null || v === undefined ? v : Number(v));

function rowToArtifact(row) {
  if (!row) return null;
  const parent_artifact_ids = row.parent_artifact_ids ?? [];
  return {
    artifact_id: row.artifact_id,
    artifact_type: row.artifact_type,
    status: row.status,
    workflow_id: row.workflow_id,
    task_id: row.task_id,
    agent_id: row.agent_id,
    version_id: row.version_id,
    registry_sha: row.registry_sha,
    parent_artifact_ids,
    content: row.content,
    content_ref: row.content_ref,
    mime_type: row.mime_type,
    size: num(row.size),
    checksum: row.checksum,
    created_at: num(row.created_at),
    // Derived, exactly as artifact-service.js derives it for the
    // in-memory path — not its own column (see migration 0007's header).
    provenance: {
      agent_id: row.agent_id, version_id: row.version_id, workflow_id: row.workflow_id,
      task_id: row.task_id, registry_sha: row.registry_sha, parent_artifact_ids,
      provider_id: row.provider_id, provider_version: row.provider_version, model_id: row.model_id,
    },
    provider_id: row.provider_id,
    provider_version: row.provider_version,
    model_id: row.model_id,
    generation_metadata: row.generation_metadata,
    approval_status: row.approval_status,
  };
}

/**
 * @param {import('pg').Pool} pool
 */
export function createPostgresArtifactStore(pool) {
  return {
    async addArtifact(artifact) {
      try {
        const { rows } = await pool.query(
          `insert into public.artifacts
             (artifact_id, artifact_type, status, workflow_id, task_id, agent_id, version_id,
              registry_sha, parent_artifact_ids, content, content_ref, mime_type, size, checksum,
              created_at, provider_id, provider_version, model_id, generation_metadata, approval_status)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
           returning *`,
          [
            artifact.artifact_id, artifact.artifact_type, artifact.status, artifact.workflow_id,
            artifact.task_id ?? null, artifact.agent_id ?? null, artifact.version_id ?? null,
            artifact.registry_sha ?? null, JSON.stringify(artifact.parent_artifact_ids ?? []),
            artifact.content !== undefined && artifact.content !== null ? JSON.stringify(artifact.content) : null,
            artifact.content_ref ?? null, artifact.mime_type ?? null, artifact.size ?? null,
            artifact.checksum ?? null, artifact.created_at ?? 0, artifact.provider_id ?? null,
            artifact.provider_version ?? null, artifact.model_id ?? null,
            artifact.generation_metadata ? JSON.stringify(artifact.generation_metadata) : null,
            artifact.approval_status ?? 'not_required',
          ],
        );
        return rowToArtifact(rows[0]);
      } catch (err) {
        // Same immutability guarantee as the in-memory store: a
        // duplicate artifact_id must throw, not silently overwrite.
        // Postgres's own primary-key violation already provides this —
        // re-thrown with the same message shape the in-memory store
        // uses, so a caller cannot tell which backend rejected it.
        if (err.code === '23505') {
          throw new Error(`artifact ${artifact.artifact_id} already exists — artifacts are immutable`);
        }
        throw err;
      }
    },

    async getArtifact(artifactId) {
      const { rows } = await pool.query('select * from public.artifacts where artifact_id = $1', [artifactId]);
      return rows.length ? rowToArtifact(rows[0]) : null;
    },

    async artifactsForWorkflow(workflowId) {
      const { rows } = await pool.query('select * from public.artifacts where workflow_id = $1', [workflowId]);
      return rows.map(rowToArtifact);
    },

    async childrenOf(artifactId) {
      const { rows } = await pool.query(
        `select * from public.artifacts where parent_artifact_ids @> $1::jsonb`,
        [JSON.stringify([artifactId])],
      );
      return rows.map(rowToArtifact);
    },
  };
}

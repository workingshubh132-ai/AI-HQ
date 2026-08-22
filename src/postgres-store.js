/**
 * POSTGRES STORAGE ADAPTER (Milestone 11)
 *
 * A real, durable, async-native implementation of every method the
 * in-memory store (store.js) implements — proven against the exact same
 * assertions via tests/storage-contract.test.js's shared harness, which
 * has said "a future Postgres/Supabase adapter later, with no change to
 * this file beyond adding a second call at the bottom" since M6.
 *
 * ── READ THIS BEFORE ASSUMING THIS IS WIRED INTO THE LIVE SYSTEM ────────
 *
 * It is not. broker.js, runtime.js, workflow.js, router.js, and
 * guardian.js all call `store.<method>()` synchronously and use the
 * return value directly, with no `await` anywhere in any of them —
 * correct, given the in-memory store they were all built and tested
 * against never does real I/O. Every method here returns a Promise,
 * because a real network call to Postgres cannot be anything else in
 * Node.js. Swapping this adapter in as the live store would mean adding
 * `await` at every single store call site across the entire security
 * core — a materially larger, separate, higher-blast-radius change than
 * "add persistence," touching exactly the files this project has
 * repeatedly said not to modify casually. That rewrite is not done here,
 * is not silently implied, and is flagged as its own future milestone.
 * See DECISIONS.md D28.
 *
 * What IS real: this adapter genuinely reads and writes Postgres, tested
 * end-to-end against a live local database, including the one property
 * the in-memory store's own header admits it cannot prove —
 * concurrency-safe idempotency (see claimIdempotency below).
 *
 * Constitution: sections 6, 7, 12, 14, 25, 29.
 */

/** Postgres returns bigint columns as strings by default, to avoid
 * silently truncating values beyond JS's safe-integer range. Every
 * bigint column here is an epoch-millisecond timestamp, always well
 * inside that range — Number(...) is correct and safe. */
const num = (v) => (v === null || v === undefined ? v : Number(v));

function rowToAgent(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    lifecycle_state: row.lifecycle_state,
    active_version_id: row.active_version_id,
    concurrency_limit: row.concurrency_limit,
    created_at: num(row.created_at),
    updated_at: num(row.updated_at),
  };
}

function rowToVersion(row) {
  if (!row) return null;
  return {
    version_id: row.version_id,
    agent_id: row.agent_id,
    version: row.version,
    purpose: row.purpose,
    department: row.department,
    state: row.state,
    clearance: row.clearance,
    allowed_tools: row.allowed_tools,
    scopes: row.scopes,
    limits: row.limits,
    capabilities: row.capabilities,
    allowed_workflow_types: row.allowed_workflow_types,
    input_contract: row.input_contract,
    output_contract: row.output_contract,
    quality_criteria: row.quality_criteria,
    model_config: row.model_config,
    metadata: row.metadata,
    created_at: num(row.created_at),
    approved_by: row.approved_by,
    approved_at: num(row.approved_at),
  };
}

function rowToTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    parent_task_id: row.parent_task_id,
    tree_id: row.tree_id,
    workflow_id: row.workflow_id,
    depth: row.depth,
    signature: row.signature,
    agent_slug: row.agent_slug,
    agent_id: row.agent_id,
    agent_version_id: row.agent_version_id,
    required_capability: row.required_capability,
    depends_on: row.depends_on,
    input: row.input,
    output: row.output,
    status: row.status,
    attempt_number: row.attempt_number,
    retry_of_task_id: row.retry_of_task_id,
    error: row.error,
    failure_reason_code: row.failure_reason_code,
    created_at: num(row.created_at),
    started_at: num(row.started_at),
    completed_at: num(row.completed_at),
    registry_sha: row.registry_sha,
  };
}

function rowToApproval(row) {
  if (!row) return null;
  return {
    id: row.id,
    // M18 (approval-engine.js): the application-assigned identity a
    // decision/revocation's own approval_reference points back to —
    // distinct from this row's DB-generated `id` above, same relationship
    // tasks.id already has to nothing. Null for every pre-M18 record.
    approval_id: row.approval_id,
    task_id: row.task_id,
    agent_id: row.agent_id,
    version_id: row.version_id,
    registry_sha: row.registry_sha,
    action_type: row.action_type,
    tool_id: row.tool_id,
    agent_intent: row.agent_intent,
    payload: row.payload,
    payload_hash: row.payload_hash,
    status: row.status,
    reason: row.reason,
    approval_reference: row.approval_reference,
    approved_payload: row.approved_payload,
    approved_payload_hash: row.approved_payload_hash,
    rendered_description: row.rendered_description,
    decided_by: row.decided_by,
    decided_at: num(row.decided_at),
    // requested_at is approval-engine.js's own field name for "when this
    // record was created" — the same concept created_at already tracks
    // for every other table; aliased here rather than adding a redundant
    // column. Both names read the same underlying value.
    requested_at: num(row.created_at),
    expires_at: num(row.expires_at),
    created_at: num(row.created_at),
  };
}

function rowToFreeze(row) {
  if (!row) return null;
  return {
    scope: row.scope,
    target_id: row.target_id,
    reason: row.reason,
    imposed_by: row.imposed_by,
    imposed_at: num(row.imposed_at),
    expires_at: num(row.expires_at),
  };
}

function rowToBudget(row) {
  if (!row) return null;
  return { level: row.level, target_id: row.target_id, limit: Number(row.limit), spent: Number(row.spent) };
}

/**
 * @param {import('pg').Pool | import('pg').Client} pool a `pg` Pool or
 *   Client. A Pool is the normal choice — it manages a small connection
 *   set and hands each query whichever is free, which is what makes the
 *   concurrent idempotency test in tests/postgres-store.test.js meaningful:
 *   genuinely concurrent requests use genuinely different connections.
 */
export function createPostgresStore(pool) {
  return {
    // ── agents ────────────────────────────────────────────────────────
    async getAgent(slug) {
      const { rows } = await pool.query(
        `select a.*, v.clearance, v.allowed_tools, v.scopes, v.capabilities,
                v.allowed_workflow_types, v.limits, v.input_contract,
                v.output_contract, v.state as version_state, v.department
         from public.agents a
         left join public.agent_versions v on v.version_id = a.active_version_id
         where a.slug = $1`,
        [slug],
      );
      if (rows.length === 0) return null;
      const row = rows[0];
      const base = {
        slug: row.slug,
        agent_id: row.id,
        state: row.lifecycle_state,
        version_id: row.active_version_id,
        version_state: row.version_state ?? null,
        concurrency_limit: row.concurrency_limit ?? null,
      };
      if (row.active_version_id === null || row.version_state === null) return base;
      return {
        ...base,
        department: row.department,
        clearance: row.clearance,
        allowed_tools: row.allowed_tools,
        scopes: row.scopes ?? undefined,
        capabilities: row.capabilities,
        allowed_workflow_types: row.allowed_workflow_types,
        limits: row.limits,
        input_contract: row.input_contract,
        output_contract: row.output_contract,
      };
    },

    async listAgents() {
      const { rows } = await pool.query('select slug from public.agents order by slug');
      const agents = [];
      for (const { slug } of rows) agents.push(await this.getAgent(slug));
      return agents;
    },

    // ── agent versions (IMMUTABLE) ───────────────────────────────────
    async addAgentVersion(version) {
      try {
        await pool.query(
          `insert into public.agent_versions
             (version_id, agent_id, version, purpose, department, state, clearance,
              allowed_tools, scopes, limits, capabilities, allowed_workflow_types,
              input_contract, output_contract, quality_criteria, model_config,
              metadata, created_at, approved_by, approved_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [
            version.version_id, version.agent_id, version.version, version.purpose, version.department ?? null,
            version.state, version.clearance, JSON.stringify(version.allowed_tools ?? []),
            version.scopes ? JSON.stringify(version.scopes) : null, JSON.stringify(version.limits ?? {}),
            JSON.stringify(version.capabilities ?? []), JSON.stringify(version.allowed_workflow_types ?? []),
            JSON.stringify(version.input_contract ?? {}), JSON.stringify(version.output_contract ?? {}),
            version.quality_criteria ?? null, JSON.stringify(version.model_config ?? {}),
            JSON.stringify(version.metadata ?? {}), version.created_at ?? 0,
            version.approved_by ?? null, version.approved_at ?? null,
          ],
        );
      } catch (err) {
        if (err.code === '23505') throw new Error(`agent version ${version.version_id} already exists and is immutable`);
        throw err;
      }
      return version;
    },

    async getAgentVersion(versionId) {
      const { rows } = await pool.query('select * from public.agent_versions where version_id = $1', [versionId]);
      return rowToVersion(rows[0] ?? null);
    },

    // ── agent records ─────────────────────────────────────────────────
    async registerAgent(agentRecord) {
      await pool.query(
        `insert into public.agents (id, slug, name, lifecycle_state, active_version_id, concurrency_limit, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (id) do update set
           slug = excluded.slug, name = excluded.name, lifecycle_state = excluded.lifecycle_state,
           active_version_id = excluded.active_version_id, concurrency_limit = excluded.concurrency_limit,
           updated_at = excluded.updated_at`,
        [
          agentRecord.id, agentRecord.slug, agentRecord.name, agentRecord.lifecycle_state,
          agentRecord.active_version_id ?? null, agentRecord.concurrency_limit ?? null,
          agentRecord.created_at ?? 0, agentRecord.updated_at ?? 0,
        ],
      );
      return agentRecord;
    },

    async setActiveVersion(slug, versionId) {
      const { rows } = await pool.query(
        'update public.agents set active_version_id = $2 where slug = $1 returning *',
        [slug, versionId],
      );
      if (rows.length === 0) throw new Error(`unknown agent: ${slug}`);
      return rowToAgent(rows[0]);
    },

    async setLifecycleState(slug, state) {
      const { rows } = await pool.query(
        'update public.agents set lifecycle_state = $2 where slug = $1 returning *',
        [slug, state],
      );
      if (rows.length === 0) throw new Error(`unknown agent: ${slug}`);
      return rowToAgent(rows[0]);
    },

    // ── tasks ─────────────────────────────────────────────────────────
    async createTask(task) {
      await pool.query(
        `insert into public.tasks
           (id, parent_task_id, tree_id, workflow_id, depth, signature, agent_slug, agent_id,
            agent_version_id, required_capability, depends_on, input, output, status,
            attempt_number, retry_of_task_id, error, failure_reason_code, created_at,
            started_at, completed_at, registry_sha)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          task.id, task.parent_task_id ?? null, task.tree_id ?? null, task.workflow_id ?? null, task.depth ?? 0,
          task.signature ?? null, task.agent_slug, task.agent_id ?? null, task.agent_version_id ?? null,
          task.required_capability ?? null, JSON.stringify(task.depends_on ?? []), JSON.stringify(task.input ?? {}),
          task.output ? JSON.stringify(task.output) : null, task.status, task.attempt_number ?? 1,
          task.retry_of_task_id ?? null, task.error ?? null, task.failure_reason_code ?? null,
          task.created_at ?? 0, task.started_at ?? null, task.completed_at ?? null, task.registry_sha ?? null,
        ],
      );
      return task;
    },

    async getTask(id) {
      const { rows } = await pool.query('select * from public.tasks where id = $1', [id]);
      return rowToTask(rows[0] ?? null);
    },

    /**
     * A plain read-then-write here (getTask, merge in JS, then UPDATE)
     * would be a lost-update race: two concurrent updateTask() calls for
     * the same id could both read the same "existing" snapshot, merge
     * their own patch on top of it, and the second write would silently
     * discard the first patch's fields. "Transaction boundaries where
     * necessary" (M11) — this is exactly that boundary. Fixed with a
     * dedicated connection, `select ... for update` to lock the row for
     * the duration of this transaction, merge, then write — a second
     * concurrent caller blocks at the SELECT until this one commits, then
     * sees the merged result and merges again on top of it correctly.
     */
    async updateTask(id, patch) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const { rows } = await client.query('select * from public.tasks where id = $1 for update', [id]);
        if (rows.length === 0) throw new Error(`updateTask: unknown task id ${id}`);
        const merged = { ...rowToTask(rows[0]), ...patch };
        await client.query(
          `update public.tasks set
             parent_task_id=$2, tree_id=$3, workflow_id=$4, depth=$5, signature=$6, agent_slug=$7,
             agent_id=$8, agent_version_id=$9, required_capability=$10, depends_on=$11, input=$12,
             output=$13, status=$14, attempt_number=$15, retry_of_task_id=$16, error=$17,
             failure_reason_code=$18, started_at=$19, completed_at=$20, registry_sha=$21
           where id=$1`,
          [
            id, merged.parent_task_id, merged.tree_id, merged.workflow_id, merged.depth, merged.signature,
            merged.agent_slug, merged.agent_id, merged.agent_version_id, merged.required_capability,
            JSON.stringify(merged.depends_on ?? []), JSON.stringify(merged.input ?? {}),
            merged.output ? JSON.stringify(merged.output) : null, merged.status, merged.attempt_number,
            merged.retry_of_task_id, merged.error, merged.failure_reason_code, merged.started_at,
            merged.completed_at, merged.registry_sha,
          ],
        );
        await client.query('commit');
        return merged;
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    // ── approvals ─────────────────────────────────────────────────────
    async approvalsForTask(taskId) {
      const { rows } = await pool.query('select * from public.approvals where task_id = $1 order by created_at', [taskId]);
      return rows.map(rowToApproval);
    },

    async addApproval(approval) {
      await pool.query(
        `insert into public.approvals
           (approval_id, task_id, agent_id, version_id, registry_sha, action_type, tool_id, agent_intent,
            payload, payload_hash, status, reason, approval_reference, approved_payload,
            approved_payload_hash, rendered_description, decided_by, decided_at, expires_at, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          approval.approval_id ?? null, approval.task_id, approval.agent_id ?? null, approval.version_id ?? null,
          approval.registry_sha ?? null, approval.action_type, approval.tool_id ?? null,
          approval.agent_intent ?? null, JSON.stringify(approval.payload ?? {}), approval.payload_hash,
          approval.status, approval.reason ?? null, approval.approval_reference ?? null,
          approval.approved_payload ? JSON.stringify(approval.approved_payload) : null,
          approval.approved_payload_hash ?? null, approval.rendered_description, approval.decided_by ?? null,
          approval.decided_at ?? null, approval.expires_at ?? null, approval.requested_at ?? approval.created_at ?? 0,
        ],
      );
    },

    // ── freezes ───────────────────────────────────────────────────────
    async activeFreeze(scope, targetId, now) {
      const { rows } = await pool.query(
        `select * from public.freezes
         where scope = $1
           and (scope = 'global' or target_id = $2)
           and (expires_at is null or expires_at > $3)
         order by imposed_at desc nulls last
         limit 1`,
        [scope, targetId, now],
      );
      return rowToFreeze(rows[0] ?? null);
    },

    async addFreeze(freeze) {
      await pool.query(
        `insert into public.freezes (scope, target_id, reason, imposed_by, imposed_at, expires_at)
         values ($1,$2,$3,$4,$5,$6)`,
        [freeze.scope, freeze.target_id ?? null, freeze.reason ?? null, freeze.imposed_by ?? null,
          freeze.imposed_at ?? null, freeze.expires_at ?? null],
      );
    },

    // ── budgets ───────────────────────────────────────────────────────
    async budgetsFor({ task_id, tree_id, agent_slug }) {
      const { rows } = await pool.query(
        `select * from public.budgets where
           (level = 'task' and target_id = $1) or
           (level = 'tree' and target_id = $2) or
           (level = 'agent_day' and target_id = $3) or
           (level = 'global_month')`,
        [task_id ?? null, tree_id ?? null, agent_slug ?? null],
      );
      return rows.map(rowToBudget);
    },

    async createTaskBudgets({ task_id, tree_id, agent_slug, limit }) {
      const created = [
        { level: 'task', target_id: task_id, limit, spent: 0 },
        { level: 'tree', target_id: tree_id, limit, spent: 0 },
        { level: 'agent_day', target_id: agent_slug, limit, spent: 0 },
      ];
      const { rows: existingGlobal } = await pool.query("select 1 from public.budgets where level = 'global_month' limit 1");
      if (existingGlobal.length === 0) created.push({ level: 'global_month', target_id: null, limit: limit * 10, spent: 0 });
      for (const b of created) await this.addBudget(b);
      return created;
    },

    async chargeBudgets(applicable, cost) {
      for (const b of applicable) {
        await pool.query(
          `update public.budgets set spent = spent + $1
           where level = $2 and (target_id = $3 or (target_id is null and $3::text is null))`,
          [cost, b.level, b.target_id ?? null],
        );
      }
    },

    async addBudget(budget) {
      await pool.query(
        'insert into public.budgets (level, target_id, "limit", spent) values ($1,$2,$3,$4)',
        [budget.level, budget.target_id ?? null, budget.limit, budget.spent ?? 0],
      );
    },

    // ── idempotency — the concurrency-safe one ───────────────────────
    async getIdempotency(key) {
      const { rows } = await pool.query('select * from public.idempotency where key = $1', [key]);
      if (rows.length === 0) return null;
      return { state: rows[0].state, result: rows[0].result, error: rows[0].error ?? undefined };
    },

    /**
     * INSERT, never UPSERT. The primary key on `key` is what makes two
     * concurrent callers racing for the same key resolve safely: exactly
     * one INSERT succeeds, the other gets a real unique-violation (SQLSTATE
     * 23505) from Postgres itself — not a last-write-wins race the way the
     * in-memory store's Map.set() unavoidably is (see store.js's own
     * header). The loser's error is turned into the same outcome
     * broker.js already treats as "claim it yourself" would have
     * signaled, by throwing — callers must check getIdempotency() first,
     * exactly as broker.js already does, and treat a throw here as
     * "someone else claimed it first."
     */
    async claimIdempotency(key) {
      try {
        await pool.query("insert into public.idempotency (key, state) values ($1, 'in_flight')", [key]);
      } catch (err) {
        if (err.code === '23505') throw new Error(`idempotency key already claimed: ${key}`);
        throw err;
      }
    },

    async recordIdempotency(key, record) {
      await pool.query(
        'update public.idempotency set state=$2, result=$3, error=$4 where key=$1',
        [key, record.state, record.result !== undefined ? JSON.stringify(record.result) : null, record.error ?? null],
      );
    },
  };
}

/**
 * A cheap, real round-trip — not just "is the pool object truthy." Meant
 * to be called before accepting traffic and periodically afterward.
 * Never throws: a health check that can itself crash the process it is
 * protecting is worse than useless.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<{ok: boolean, latency_ms: number|null, error: string|null}>}
 */
export async function checkPersistenceHealth(pool) {
  const start = Date.now();
  try {
    await pool.query('select 1');
    return { ok: true, latency_ms: Date.now() - start, error: null };
  } catch (err) {
    return { ok: false, latency_ms: null, error: err.message };
  }
}

/**
 * Refuses to say "ready" for a database that has not been migrated to
 * match the code about to run against it — the schema-drift failure mode
 * "it connected fine" cannot catch on its own. Compares
 * schema_migrations against every .sql file actually on disk; any file
 * not yet applied is reported as a specific, named gap, not a generic
 * connection failure.
 *
 * @param {import('pg').Pool} pool
 * @param {string[]} expectedMigrationFiles  filenames, e.g. from
 *   readdirSync(MIGRATIONS_DIR) — passed in rather than read from disk
 *   here, so this function has no filesystem dependency of its own and
 *   is trivially testable with a fixed list.
 * @returns {Promise<{ok: boolean, errors: string[]}>}
 */
export async function validateStartup(pool, expectedMigrationFiles) {
  const errors = [];
  const health = await checkPersistenceHealth(pool);
  if (!health.ok) {
    return { ok: false, errors: [`cannot connect: ${health.error}`] };
  }
  try {
    const { rows } = await pool.query(
      "select to_regclass('public.schema_migrations') is not null as exists",
    );
    if (!rows[0].exists) {
      return { ok: false, errors: ['schema_migrations table does not exist — no migration has ever been run'] };
    }
    const applied = new Set((await pool.query('select version from public.schema_migrations')).rows.map((r) => r.version));
    for (const file of expectedMigrationFiles) {
      if (!applied.has(file)) errors.push(`pending migration not yet applied: ${file}`);
    }
  } catch (err) {
    errors.push(`could not verify schema_migrations: ${err.message}`);
  }
  return { ok: errors.length === 0, errors };
}

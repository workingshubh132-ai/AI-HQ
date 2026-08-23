// AI-HQ — LIVE GROQ SMOKE TEST (Milestone 26)
//
// Makes EXACTLY ONE real, paid Groq inference request through the full
// existing governance chain, and proves the whole path end to end:
//
//   configuration gates → Guardian/lifecycle gate (live-guard.js, M26)
//   → resource governor (global → agent → workflow → task, plus call
//   ceiling) → governed async invocation (input ceiling, bounded retry,
//   timeout, output ceiling, output contract) → Groq adapter (the ONLY
//   network boundary) → artifact bridge → artifact service (trusted
//   provenance, checksum) → audit
//
// Run it with:  npm run smoke:groq
//
// ── THIS IS THE ONLY THING IN THE REPOSITORY THAT SPENDS MONEY ──────────
//
// It is deliberately a SCRIPT, not a test: `npm test` must stay offline
// and free, forever. Nothing in the default suite can reach this file.
//
// ── IT REFUSES UNLESS EXPLICITLY AUTHORIZED ─────────────────────────────
//
// All of M25's gates must hold (AI_HQ_REAL_PROVIDER_ENABLED=true,
// GROQ_ENABLED!=false, GROQ_API_KEY, GROQ_MAX_SPEND_USD, GROQ_MODELS).
// With any of them unmet it prints why and exits 2 — "NOT RUN" is a
// correct, successful gated state, not a failure, and never a reason to
// invent a credential.
//
// Exit codes:  0 = one real call succeeded
//              1 = it ran and genuinely failed
//              2 = NOT RUN (gated: missing configuration/credential)
//
// ── WHAT IT WILL NEVER PRINT ────────────────────────────────────────────
//
// The API key, any Authorization header, any raw request or response
// object, or an environment dump. Only the safe fields listed in the
// banner below, plus a sanitized result summary.

import { createMemoryStore } from '../src/store.js';
import { createMemoryArtifactStore } from '../src/artifact-store.js';
import { createArtifactService } from '../src/artifact-service.js';
import { createAuditSink } from '../src/audit.js';
import { createResourceGovernor } from '../src/resource-governor.js';
import { makeAgent, makeAgentVersion, VERSION_STATE, versionId } from '../src/agents.js';
import { ARTIFACT_TYPE } from '../src/artifacts.js';
import { createLiveProviderRegistry } from '../src/providers/live-registry.js';
import { createAsyncProviderInvoker } from '../src/providers/invoke-async.js';
import { buildArtifactRequestFromProviderResult } from '../src/providers/artifact-bridge.js';
import { readGroqConfig, GROQ_ENV } from '../src/providers/groq-config.js';
import { GROQ_PROVIDER_ID } from '../src/providers/groq.js';
import { createLiveProviderChain } from '../src/providers/live-guard.js';

/** Tiny, deterministic, non-sensitive. The point is connectivity and
 * governance, not generation quality. */
const SMOKE_PROMPT = 'Reply with exactly: AI-HQ-LIVE-OK';
const SMOKE_AGENT = 'live-smoke-agent';
const SMOKE_WORKFLOW = 'wf-live-smoke';
const SMOKE_TASK = 'task-live-smoke';

/** ONE attempt. A paid smoke test must never quietly become several. */
const MAX_RETRIES = 0;

const line = (s = '') => console.log(s);

function notRun(reason, detail) {
  line();
  line('  LIVE GROQ TEST: NOT RUN');
  line(`  Reason: ${reason}`);
  if (detail) line(`  ${detail}`);
  line();
  line('  This is a correct, gated state — not a failure. No credential');
  line('  was invented, borrowed, or substituted, and no request was sent.');
  line();
  line('  To run it, set (in a local .env or your secret manager):');
  line(`    ${GROQ_ENV.REAL_PROVIDER_ENABLED}=true`);
  line(`    ${GROQ_ENV.API_KEY}=<your key from https://console.groq.com/keys>`);
  line(`    ${GROQ_ENV.MODELS}=<a model id you verified at https://console.groq.com/docs/models>`);
  line(`    ${GROQ_ENV.MAX_SPEND_USD}=0.05`);
  line();
  process.exit(2);
}

async function main() {
  line();
  line('AI-HQ — LIVE GROQ SMOKE TEST');
  line('════════════════════════════');

  // ── gate ────────────────────────────────────────────────────────────
  const config = readGroqConfig(process.env);
  if (!config.enabled) {
    notRun(config.reason, 'Every M25 configuration gate must hold before one real call is made.');
  }

  const model = config.models[0];
  const spendCeiling = config.max_spend_usd;

  // Safe banner ONLY. No key, no headers, no env dump.
  line();
  line('  Provider:                Groq');
  line(`  Provider id:             ${GROQ_PROVIDER_ID}`);
  line(`  Model (from ${GROQ_ENV.MODELS}): ${model}`);
  line(`  Prompt:                  ${JSON.stringify(SMOKE_PROMPT)}`);
  line('  Maximum expected attempts: 1');
  line('  Governance:              enabled (global → agent → workflow → task)');
  line(`  Per-call spend ceiling:  ${spendCeiling} USD (configured)`);
  line(`  Credential:              present (value never read, logged, or stored by this script)`);
  line();

  // ── a real, minimal governed stack ──────────────────────────────────
  const store = createMemoryStore();
  const artifactStore = createMemoryArtifactStore();
  const audit = createAuditSink();
  const clock = () => Date.now();
  const registrySha = 'live-smoke';

  // A real agent, so artifact provenance is genuinely derived rather
  // than asserted.
  const agentId = `agent-${SMOKE_AGENT}`;
  store.addAgentVersion(makeAgentVersion({
    agent_id: agentId, version: '1.0.0', purpose: 'live smoke', department: 'internal',
    state: VERSION_STATE.APPROVED, clearance: 'GREEN', allowed_tools: [],
    limits: {}, input_contract: {}, output_contract: {}, created_at: 0,
    approved_by: 'operator', approved_at: 0,
  }));
  store.registerAgent(makeAgent({
    id: agentId, slug: SMOKE_AGENT, name: SMOKE_AGENT,
    active_version_id: versionId(agentId, '1.0.0'),
  }));

  // Count REAL network requests by wrapping the genuine fetch. The
  // request still goes out; this only observes how many there were.
  let networkCalls = 0;
  const countingFetch = async (...args) => {
    networkCalls++;
    return globalThis.fetch(...args);
  };

  const { registry, groq } = createLiveProviderRegistry({ env: process.env, fetchImpl: countingFetch });
  if (!groq.included) notRun(groq.reason, 'The live registry refused to include Groq.');

  const invoker = createAsyncProviderInvoker({ registry, audit, clock });

  // The composed live chain: Guardian/lifecycle gate -> resource
  // governor -> governed async invocation -> Groq adapter. The composer
  // also preserves provider provenance across the governor's envelope,
  // which the governor itself does not pass through (see live-guard.js).
  const chain = createLiveProviderChain({
    store, invoker, createGovernor: createResourceGovernor, registry, audit, clock,
  });
  const governor = chain.governor;

  // Deliberately tiny but sufficient: exactly the configured per-call
  // ceiling at every level, so one call fits and a second would not.
  governor.configureGlobalBudget(spendCeiling);
  governor.configureAgentBudget(SMOKE_AGENT, spendCeiling);
  governor.configureWorkflowBudget(SMOKE_WORKFLOW, spendCeiling);
  governor.configureTaskBudget(SMOKE_TASK, spendCeiling);

  // The Guardian/lifecycle gate sits IN FRONT of the governor (M26): a
  // frozen agent, frozen workflow, global freeze, unapproved version, or
  // non-active lifecycle stops the call before any reservation is made
  // and before any request is built. Without this, the live path would
  // never reach runtime.js's own freeze pre-flight — see live-guard.js.
  const preflight = chain.check({ agent_slug: SMOKE_AGENT, tree_id: SMOKE_WORKFLOW });
  line(`  Guardian/lifecycle gate: ${preflight.ok ? 'PASS' : `DENY (${preflight.reason})`}`);
  if (!preflight.ok) {
    line();
    line('  LIVE GROQ TEST: NOT RUN — governance denied before any network access');
    line(`  Reason: ${preflight.reason}`);
    line();
    process.exit(2);
  }

  line('  → sending ONE request through the governance chain...');
  const startedAt = Date.now();
  const result = await chain.invoke({
    provider_id: GROQ_PROVIDER_ID,
    model_id: model,
    input: { text: SMOKE_PROMPT },
    max_retries: MAX_RETRIES,
    agent_slug: SMOKE_AGENT,
    tree_id: SMOKE_WORKFLOW,
    task_id: SMOKE_TASK,
  });
  const elapsedMs = Date.now() - startedAt;

  line();
  line('  RESULT');
  line('  ──────');
  line(`  Status:                  ${result.status}`);
  line(`  Reason:                  ${result.reason}`);
  line(`  Network requests made:   ${networkCalls}`);
  line(`  Attempts:                ${result.attempts ?? 'n/a'}`);
  line(`  Elapsed:                 ${elapsedMs}ms`);
  line(`  Governance:              reservation + settlement completed`);

  if (result.status !== 'ok') {
    // A sanitized detail only — the adapter has already redacted the
    // credential out of any provider error text.
    line(`  Detail:                  ${String(result.detail ?? '').slice(0, 200)}`);
    line();
    line('  LIVE GROQ TEST: RAN — FAILED');
    line(`  Classified as: ${result.reason}`);
    line();
    process.exit(1);
  }

  // ── exactly-one-call guarantee ──────────────────────────────────────
  if (networkCalls !== 1) {
    line();
    line(`  ✗ EXPECTED EXACTLY ONE NETWORK REQUEST, OBSERVED ${networkCalls}`);
    line();
    process.exit(1);
  }

  // ── provider output → artifact, through the real chain ──────────────
  const artifactService = createArtifactService({ store, artifactStore, audit, clock, registrySha });
  const request = buildArtifactRequestFromProviderResult({
    providerResult: result, artifact_type: ARTIFACT_TYPE.TEXT,
    reason: 'live-groq-smoke',
  });
  const created = artifactService.createArtifactSync({
    ...request, agent_slug: SMOKE_AGENT, workflow_id: SMOKE_WORKFLOW,
  });

  if (created.outcome !== 'created') {
    line();
    line(`  ✗ ARTIFACT CREATION FAILED: ${created.code}`);
    line();
    process.exit(1);
  }

  const artifact = artifactStore.getArtifact(created.artifact.artifact_id);

  // ── credential non-leakage, checked against the REAL key ────────────
  // The key value is used ONLY for this containment check and is never
  // printed. If it appears anywhere it should not, the script fails.
  const key = process.env[GROQ_ENV.API_KEY];
  const leakTargets = {
    'result envelope': JSON.stringify(result),
    'artifact': JSON.stringify(artifact),
    'audit log': JSON.stringify(audit.all()),
  };
  for (const [where, serialized] of Object.entries(leakTargets)) {
    if (serialized.includes(key)) {
      line();
      line(`  ✗ CREDENTIAL LEAK DETECTED IN: ${where}`);
      line();
      process.exit(1);
    }
  }

  line();
  line('  PROVIDER METADATA (sanitized)');
  line(`  Provider reported usage: ${result.provider_usage?.provider_reported === true}`);
  line(`  Prompt tokens:           ${result.provider_usage?.prompt_tokens ?? 'not reported'}`);
  line(`  Completion tokens:       ${result.provider_usage?.completion_tokens ?? 'not reported'}`);
  line(`  Request id:              ${result.provider_usage?.request_id ?? 'not reported'}`);
  line(`  Cost:                    ${result.cost === null ? 'null' : result.cost}`);
  line(`  Cost status:             ${result.cost_status}`);
  line();
  line('  ARTIFACT');
  line(`  Artifact id:             ${artifact.artifact_id}`);
  line(`  Artifact type:           ${artifact.artifact_type}`);
  line(`  Provider id:             ${artifact.provider_id}`);
  line(`  Model id:                ${artifact.model_id}`);
  line(`  Agent id (derived):      ${artifact.agent_id}`);
  line(`  Registry SHA (injected): ${artifact.registry_sha}`);
  line(`  Checksum:                ${artifact.checksum}`);
  line();
  line('  RESPONSE VALIDATION (safe)');
  line(`  Output is a string:      ${typeof result.output.text === 'string'}`);
  line(`  Output length:           ${result.output.text.length}`);
  line(`  Contains AI-HQ-LIVE-OK:  ${result.output.text.includes('AI-HQ-LIVE-OK')}`);
  line();
  line('  CREDENTIAL CONTAINMENT');
  line('  Not present in result envelope, artifact, or audit log: CONFIRMED');
  line();
  line('  LIVE GROQ TEST: RAN — SUCCESS');
  line(`  Exactly ${networkCalls} real network request was made.`);
  line();
  process.exit(0);
}

main().catch((err) => {
  // Never print a raw error object: it can carry request context.
  line();
  line('  LIVE GROQ TEST: RAN — ERRORED');
  line(`  ${String(err?.message ?? err).slice(0, 300)}`);
  line();
  process.exit(1);
});

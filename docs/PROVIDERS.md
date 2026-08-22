# Content Generation Providers

`src/providers/` (Milestone 21) is a provider-ready foundation for content
generation across five categories: text, image, audio, video, and
subtitle/transcription. It was built as a **standalone layer** — the
same "build the foundation, prove it, wire it in later" discipline
M19's artifact system followed before M20 wired it into `runtime.js` —
and, as of Milestone 22, is now genuinely wired into real task
execution via one additive closure on `runtime.js`. §1a below covers
the execution wiring; §1 below still describes the foundation itself,
unchanged since M21. `broker.js`, `validator.js`, `guardian.js`,
`approval-engine.js`, `router.js`, `workflow.js`, and
`execution-coordinator.js` remain unimported by, and do not import,
anything under `src/providers/` — only `runtime.js` now does, and only
through the one narrow `providerInvoker` dependency described below.

Today, every registered provider is **deterministic** — a pure function
producing clearly synthetic fixture output, never a real network call.
This document explains the architecture, what exists today, and exactly
where a real provider (starting with Groq, since that's the user's
stated future direction) would plug in later, without pretending that
integration exists yet.

## 1. Provider architecture

```
CONTENT INTENT
    ↓
PROVIDER CONTRACT     (src/providers/contracts.js)
    ↓
PROVIDER ADAPTER      (a plain object: provider_type, provider_version,
                        deterministic, enabled, capabilities, models)
    ↓
MODEL/MEDIA RESPONSE   (validated by contracts.js's per-category
                        output shape check, inside invoke.js)
    ↓
ARTIFACT CREATION      (src/providers/artifact-bridge.js builds a
                        request; artifact-service.js — M19/M20,
                        completely unchanged — creates the artifact)
    ↓
PROVENANCE             (agent_id/version_id/registry_sha/workflow_id/
                        task_id come ONLY from trusted execution
                        context, never from provider output)
```

Five files carry this:

- **`contracts.js`** — `PROVIDER_TYPE` (the five categories),
  `PROVIDER_REASON` (the typed failure vocabulary), per-category request
  and output shape validators, and `RETRYABLE_PROVIDER_REASONS` (which
  failures are safe to retry automatically — only transient ones:
  timeout, rate-limited, unavailable).
- **`registry.js`** — `createContentProviderRegistry(providerDefs)`.
  Immutable once built: validates every provider definition, then
  freezes the registry, every provider, and every model, three layers
  deep. No `register()`/`add()`/`set()` method exists on the returned
  object — there is no code path by which anything running after
  construction (an agent, a model's output, anything) could cause a new
  provider to come into existence.
- **`invoke.js`** — `createProviderInvoker({registry, audit, clock})`.
  The one governed call path: request shape → provider lookup (fail
  closed) → enabled check → model lookup (fail closed) → capability
  check → request contract validation → input size ceiling → bounded,
  retry-safety-aware retry loop → output size ceiling → output contract
  validation → audit. Mirrors `model-runtime.js`'s exact pipeline
  (M6/M7), generalized across all five categories instead of text alone.
- **`artifact-bridge.js`** — `buildArtifactRequestFromProviderResult(...)`.
  A pure, synchronous transform from a successful governed result into
  an artifact-creation request. Never sets `agent_id`, `version_id`,
  `registry_sha`, `workflow_id`, `task_id`, `artifact_id`, `created_at`,
  or `provenance` — those come only from a trusted caller (the same
  pattern `runtime.js`'s `createArtifact` closure already establishes,
  M20).
- **`default-registry.js`** — the five deterministic providers,
  registered, ready to use in tests or a future demo.

## 1a. Real execution (Milestone 22)

The full chain, now real end to end:

```
AGENT
  ↓
ROUTER              (router.js — unmodified)
  ↓
WORKFLOW             (workflow.js — unmodified)
  ↓
EXECUTION COORDINATOR (execution-coordinator.js — unmodified)
  ↓
RUNTIME              (runtime.js — ONE new optional dependency:
                       providerInvoker; ONE new closure: generateContent)
  ↓
PROVIDER INVOCATION   (src/providers/invoke.js — unmodified logic,
                       M21; two audit-only fields added, M22)
  ↓
CONTENT RESULT        (the provider's validated, governed output)
  ↓
ARTIFACT SERVICE      (src/providers/artifact-bridge.js extracts safe
                       content fields; artifact-service.js — M19/M20,
                       unmodified — creates the artifact)
  ↓
AUDIT                 (provider.invocation + artifact.created events,
                       both carrying real agent_slug/task_id/tree_id)
```

**`createRuntime({ ..., providerInvoker })`** — a new, optional
constructor dependency, alongside the existing `modelRuntime` and
`artifactService`. Omitted by any handler that never generates provider
content (calling `generateContent` without it throws a clear,
dedicated error — never a silent no-op). Must be a
`createProviderInvoker()` instance (`src/providers/invoke.js`, M21) —
already synchronous, already governed. `runtime.js` holds **no
reference to the provider registry itself** — only to the
already-governed invoker built over it, once, outside any handler's
reach (proven directly: test 557). There is no `providerRegistry`
parameter anywhere in `runtime.js`, and none is ever exposed to a
handler.

**`generateContent(request)`** — the one new capability a handler
receives, alongside the existing `callTool`/`callModel`/`createArtifact`
(the exact, complete, fixed set — test 527 reproduces the literal
handler-invocation line). It is not a fourth implementation of
anything: it is `providerInvoker.invoke()` (M21's full governed
pipeline — provider/model lookup, capability check, input/output size
ceilings, bounded retry, output shape validation) followed by the SAME
`createArtifact` closure M20 already built (trusted provenance,
checksum, lineage), called in exactly that order. A request names
`provider_id`/`model_id`/`required_capability`/`input`/`max_retries`/
`artifact_type`/`parent_artifact_ids`/`reason` — nothing else is ever
read from it, by construction, not merely by convention: even a request
carrying `agent_id`/`version_id`/`registry_sha`/`workflow_id`/`task_id`/
`provenance` has those fields simply never accessed at this layer
(tests 532–537), and `artifact-service.js`'s own M19 anti-impersonation
check would independently ignore them a second time even if they
somehow arrived.

Return shape mirrors `createArtifact`'s own `{outcome, code, artifact,
detail}` vocabulary exactly, plus the raw `provider_result`:

```js
// success
{ outcome: 'created', code: 'OK', artifact: {...}, provider_result: {...} }
// provider-side failure (unknown provider/model, timeout, retry
// ceiling, oversized input/output, malformed response, ...)
{ outcome: 'rejected', code: 'PROVIDER_NOT_FOUND', detail: '...', artifact: null, provider_result: {...} }
// artifact-side failure (unknown artifact_type, missing/cross-workflow
// parent, cycle, ...)
{ outcome: 'rejected', code: '...', detail: '...', artifact: null, provider_result: {...} }
```

A handler always gets DATA back, never a crash it cannot inspect —
though a handler that chooses to `throw` on a rejection (as every demo
agent in this milestone does, via a small `requireGenerated()` helper)
still fails the task safely through `runtime.js`'s existing
`HANDLER_ERROR` path, exactly as `createArtifact` rejections already do.

**Two new demo agents prove the wiring, end to end:**

- **`content-agent`** (`src/demo-content-agent.js`) — the smallest
  possible proof: one task, one `generateContent()` call, one real
  SCRIPT artifact from the deterministic text provider.
- **Six `media-*-agent`s** (`src/demo-media-pipeline-agents.js`) — a
  full `RESEARCH → SCRIPT → AUDIO → IMAGE → {VIDEO, SUBTITLE}` pipeline
  through the real, unmodified router/workflow/execution-coordinator
  chain, reusing M20's exact self-chaining (`proposed_child_tasks`) and
  diamond-lineage pattern (VIDEO converges on AUDIO+IMAGE) — no second
  orchestration or lineage mechanism was built. SUBTITLE is parented on
  AUDIO rather than SCRIPT (M20's choice): `deterministic-subtitle-v1`'s
  own contract requires `input.audio_artifact_id`, so parenting on audio
  is the honest, contract-driven choice once a real provider contract
  exists to defer to.

**What did not change to make this work:** `resource-governor.js` is
still not live-wired into `runtime.js` — it never was, even for
`callModel` (D28: the governor is async, the handler-execution path is
synchronous by design). A fresh test (554) proves `generateContent`-
shaped requests still compose correctly with the real, unmodified
governor, using the real default registry and the real demo agents'
own provider_id/model_id — not merely a synthetic example. Guardian
freezes required zero new code: they already block agent EXECUTION
before any handler runs (M4/M8), so they block `generateContent`
automatically, for free (test 552: zero provider invocations, zero
artifacts, when frozen). Approval policy is unchanged: GREEN-clearance
generation runs without approval per existing policy; a YELLOW-clearance
agent's separate tool call still needs real approval regardless of
whether it also generated content (test 528).

## 2. Deterministic providers

`deterministic-text.js`, `-image.js`, `-audio.js`, `-video.js`,
`-subtitle.js`. Each is a pure, synchronous function: same input, same
output, forever. No randomness, no clock read, no I/O, no network.

- **Text** reuses `providers.js`'s existing `MOCK_PROVIDER` transform
  (echo + word/length statistics, M6) rather than reimplementing the
  same idea — wrapped with an explicit `[SYNTHETIC FIXTURE — not real
  model output]` prefix.
- **Image/audio/video** produce an opaque `content_ref` (never a real
  file, never fetched by anything in this codebase — the same contract
  `artifacts.js` already documents for large media) plus a checksum and
  size computed deterministically over the fixture's own descriptive
  fields, using the exact `checksumOf`/`byteSizeOf` functions
  `artifact-service.js` already trusts.
- **Subtitle** produces small inline structured cue data (a caption list
  with timestamps), since it's naturally textual, not binary media.

Every deterministic provider declares `max_cost_per_call: 0` — genuinely
zero, because no real computation is billed — so that composing it with
the existing `resource-governor.js` (see §8) reserves and charges
nothing real. `invoke.js` itself reports `cost: 0, cost_status:
'DETERMINISTIC_NO_EXTERNAL_COST'` on every successful deterministic call.
**Never read this as a claim about what a real provider would cost.**

## 3. Future Groq adapter

**No Groq adapter exists in this repository today.** This section
documents where one would plug in — it is not a promise that it works,
and it must never be described as connected until an actual adapter
file exists and is tested.

The concrete precedent is `src/provider-anthropic.js` (M12): a real,
tested provider definition satisfying `providers.js`'s registry shape,
whose `invoke()` reads `process.env.ANTHROPIC_API_KEY` **only inside
itself, at call time** — never logged, never stored on an envelope,
never in an audit record. It is consumed exclusively through
`async-model-runtime.js` (M12), never the synchronous `model-runtime.js`,
because a real network call cannot be synchronous in Node.js.

A future Groq adapter would follow the identical shape, under
`src/providers/`:

```js
// src/providers/live-groq-text.js (DOES NOT EXIST YET)
export const GROQ_TEXT_PROVIDER = Object.freeze({
  provider_type: PROVIDER_TYPE.TEXT_GENERATION,
  provider_version: '<groq api version>',
  deterministic: false,
  enabled: true,
  models: {
    '<a real groq model id>': Object.freeze({
      max_input_units, max_output_units, timeout_ms, default_max_retries,
      async invoke({ input }) {
        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) throw new Error('GROQ_API_KEY is not configured — no real Groq call can be made');
        // ... call Groq's API here, return {status, output, usage} ...
      },
    }),
  },
});
```

Registering it would mean adding one entry to a `providerDefs` map
passed to `createContentProviderRegistry(...)` — additive, not a change
to `registry.js`, `invoke.js`, or `artifact-bridge.js`. Because
`invoke()` would be `async`, it would need an async-capable governed
invoker — the same `createAsyncModelRuntime` vs `model-runtime.js` split
M12 already established for text, mirrored for this layer, not built in
M21 because nothing async-capable is needed until a real adapter exists.

**Groq readiness today is structural, not proven by a working
integration**: nothing currently depends on `src/providers/` at all, so
adding a provider entry cannot possibly require touching `broker.js`,
`validator.js`, `guardian.js`, `approval-engine.js`, `router.js`,
`workflow.js`, or `execution-coordinator.js` — there is no dependency
edge from any of them to break. The real test of "readiness" is that
`provider-anthropic.js` already proves this exact pattern (credential
isolated inside `invoke()`, async, registered as one more entry) works
in this codebase, for a different real provider, today.

## 4. Future image provider

Same pattern as Groq: a new file under `src/providers/`, `provider_type:
IMAGE_GENERATION`, `deterministic: false`, credential read inside
`invoke()` only, registered as one more entry in a provider-defs map. No
specific vendor is chosen or implied by anything in this milestone.

## 5. Future audio provider

Same pattern, `provider_type: AUDIO_GENERATION`. A real text-to-speech
adapter would additionally need to actually store the returned audio
bytes somewhere real — `artifacts.js`'s `content_ref` is deliberately an
opaque, unresolved string today (M19); wiring a real blob store behind
it is an explicitly deferred, separate milestone (see DECISIONS.md D36),
not part of this one.

## 6. Future video provider

Same pattern, `provider_type: VIDEO_GENERATION`. Real video composition
providers are typically slow (minutes, not seconds) and asynchronous
(a job you poll rather than a request you await) — a real adapter would
likely need a genuinely different invocation shape (submit → poll →
retrieve) that `invoke.js`'s current synchronous-call pattern does not
model. Documented as a known gap for whenever a real video provider is
actually being connected, not solved speculatively here.

## 7. Credential handling

**No provider registered in this codebase today reads any credential.**
The five deterministic providers take no API key, connect to nothing,
and cannot be configured to. `src/providers/` contains no
`process.env` read, no `fetch`/`axios`/`http`/`https`/`child_process`
reference anywhere — swept and tested (`tests/providers.test.js`,
structural tests).

When a real provider is eventually added, the rule is the one
`provider-anthropic.js` already establishes and this milestone does not
change: a credential is read from `process.env` **only inside that
provider's own `invoke()`, at call time** — never passed through a
request object, never returned on an envelope, never written to an
audit record, never stored in `model_config` (which `validator.js`
already restricts to `provider_id`/`model_id` only — an agent version
declaring an API key field is rejected before it could ever reach a
provider file; unchanged by this milestone).

## 8. Testing strategy

- **Deterministic-first.** Every test in `tests/providers.test.js` runs
  fully offline, with no environment variable, no network stub, no
  timer-dependent flakiness (an injected `clock()` drives every
  timing-sensitive check, exactly like the rest of this codebase).
- **Composition over reinvention.** Budget/resource-limit behavior is
  proven by composing this milestone's new `invoke.js` with the
  EXISTING, completely unmodified `resource-governor.js` (M13) — not by
  building a second budget system. Checksum, lineage, and cross-workflow
  isolation are proven by composing `artifact-bridge.js`'s output with
  the EXISTING, unmodified `artifact-service.js` (M19/M20) — not by
  re-testing logic that milestone already proved.
  See `docs/DECISIONS.md` D38 for exactly what the resource-governor
  composition needed from a provider's model definition and why
  (a real, zero-value `max_cost_per_call` declaration was required, and
  why that's an honest number to declare rather than a fabricated one).
- **Adversarial by default.** A provider whose output is shaped exactly
  like an authorization decision (`approved`, `clearance`, `remove_freeze`,
  `budget_override`, `tool`, `approval_id`) is proven to grant nothing —
  the artifact is created (the DATA is valid), and the real agent's
  clearance, the real freeze state, and a real Broker call for the named
  tool are all independently confirmed unaffected.
- **Structural, not just behavioral.** `tests/providers.test.js` greps
  every file under `src/providers/` for references to the Broker,
  Guardian, the Approval Engine, store-mutation methods, and lifecycle
  methods, confirming none exist — the same discipline `model-runtime.js`
  and `execution-coordinator.js`'s own test files already established.
- **Mutation-tested.** Provider lookup, model lookup, capability check,
  output validation, provenance derivation, the input-size ceiling, the
  retry-ceiling clamp, artifact-type validation, registry immutability,
  and Broker isolation are each disabled or inverted in place, the test
  suite run to confirm a specific, expected failure, then the file
  restored — see `docs/DECISIONS.md` D38 for the full results.

**Milestone 22 additions** (`tests/provider-execution.test.js`, 44
tests): the same disciplines, extended through real execution rather
than direct invoker composition. 25 adversarial scenarios (forged
provider_id/agent_id/version_id/registry_sha/workflow_id/task_id/
provenance/budget/freeze/approval/clearance; a rogue provider attempting
tool execution; oversized input/output; invalid artifact_type; invalid
provider response; a frozen agent; insufficient budget) are each proven
through a REAL `runtime.runTask()` call, not a bare `invoke()`. Three
new mutations target `runtime.js`'s own new code specifically (the
provider-failure fail-closed gate, reuse of the trusted `createArtifact`
closure rather than a direct `artifactService` call, and the invalid-
artifact_type rejection path) — all 10 of M21's original mutations were
also re-run against the current files and the FULL test suite (not just
`tests/providers.test.js`) to confirm this milestone's `invoke.js` edit
(two audit-only fields) weakened nothing. All 13 mutations caught; see
`docs/DECISIONS.md` D39.

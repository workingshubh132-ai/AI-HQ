# Content Generation Providers

`src/providers/` (Milestone 21) is a provider-ready foundation for content
generation across five categories: text, image, audio, video, and
subtitle/transcription. It is a **standalone layer, not yet wired into
live task execution** — the same "build the foundation, prove it, wire
it in later" discipline M19's artifact system followed before M20 wired
it into `runtime.js`. Nothing in `broker.js`, `runtime.js`, `validator.js`,
`guardian.js`, `approval-engine.js`, `router.js`, `workflow.js`, or
`execution-coordinator.js` imports, or is imported by, anything under
`src/providers/`.

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

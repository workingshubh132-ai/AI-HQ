# Content Factory

`src/content-factory-agents.js` and `src/content-factory-orchestrator.js`
(Milestone 23) turn AI-HQ's provider-execution foundation (M20-M22) into a
real, executable multi-agent pipeline: twelve specialized agents that
together turn a single topic into a governed `CONTENT_PACKAGE` artifact
graph, running entirely through the existing router / workflow /
execution-coordinator / runtime / provider-invocation / artifact-service /
audit / Guardian chain — no new orchestration engine, no new authorization
mechanism, no live network provider.

## 1. The twelve agents, and their responsibilities

| Agent slug | Capability | Produces | Depends on (real artifact refs) |
|---|---|---|---|
| `cf-research-agent` | `cf-research` | RESEARCH | — |
| `cf-fact-check-agent` | `cf-fact-check` | TEXT | research |
| `cf-idea-agent` | `cf-idea` | TEXT | research + fact-check (2-parent) |
| `cf-script-agent` | `cf-script` | SCRIPT | idea |
| `cf-hook-agent` | `cf-hook` | TEXT | script |
| `cf-audio-agent` | `cf-audio` | AUDIO | script + hook |
| `cf-visual-agent` | `cf-visual` | IMAGE | script + hook |
| `cf-social-package-agent` | `cf-social` | SOCIAL_PACKAGE | script + hook |
| `cf-subtitle-agent` | `cf-subtitle` | SUBTITLE | audio (real `audio_artifact_id`) |
| `cf-video-plan-agent` | `cf-video-plan` | VIDEO | audio + visual + subtitle (3-parent) |
| `cf-quality-control-agent` | `cf-qc` | TEXT (report) | every stage above |
| `cf-publishing-package-agent` | `cf-publish` | CONTENT_PACKAGE | quality-control |

Every agent is DATA: an immutable `makeAgentVersion` record declaring
`clearance` (GREEN throughout — none of these agents call a tool),
`allowed_tools` (empty), `capabilities` (exactly one each — distinct,
non-overlapping responsibility, checked directly by test 561),
`allowed_workflow_types` (`['CONTENT_FACTORY']`), `limits` (within
`validator.js`'s POLICY ceilings, checked by test 562), `input_contract`/
`output_contract`, and `metadata.supported_artifact_types` (advisory,
descriptive — see §5). Handlers are separate functions (`src/content-factory-agents.js`,
never embedded in the version record — test 563), and never receive
anything beyond runtime.js's existing narrow closure set: `input`,
`callTool`, `callModel`, `createArtifact`, `generateContent`, `DECISION`.
A handler cannot become an authorization mechanism because it has no
reference to anything that could authorize.

A thirteenth, adversarial fixture — `cf-rogue-agent` — is exported
separately and never registered by `registerContentFactoryAgents()`. It
forges identity fields in a `generateContent` request and emits
authorization-shaped output as inert data, proving both are ignored (tests
594-605).

## 2. Routing: capability, not hardcoded slug

Every stage is proposed via `execution-coordinator.js`'s unmodified
`proposeTask()`, which resolves `required_capability` (e.g. `cf-script`)
to a concrete agent through `router.js`'s real, unmodified
`route()` — the same deterministic, advisory-only selection every other
milestone already relies on. Nothing in this milestone hardcodes an
`agent_slug` for dispatch. Proven directly:

- correct specialist selected by capability alone (test 564)
- capability mismatch rejected (test 565)
- frozen agent excluded from routing candidacy (test 566)
- disabled agent excluded from routing candidacy (test 567)
- insufficient budget blocks admission (test 568)
- unsupported `allowed_workflow_types` rejected (test 569)

## 3. The workflow graph — and the depth problem this milestone actually hit

The Content Factory's true data-dependency critical path (research →
fact-check → idea → script → hook → audio → subtitle → video-plan →
quality-control → publishing-package) is **nine sequential hops long**.
`limits.js`'s `MAX_DEPTH` is 4. M20's and M22's self-chaining pattern
(`proposed_child_tasks`, each hop deepening the task tree by exactly one
level) cannot express a critical path longer than `MAX_DEPTH` — a hard
limit, not a preference, and no amount of clever fan-out changes a
critical path's own length.

**The fix does not touch `MAX_DEPTH`, `MAX_FANOUT`, or `MAX_TOTAL_NODES`.**
`content-factory-orchestrator.js` proposes every stage with
`parent_task_id: null` (every task sits at depth 0) and uses
`workflow.js`'s existing, previously-underused `depends_on` array —
orthogonal to `parent_task_id`/depth — to express the real dependency
graph, including genuine parallel branches (audio/visual/social-package
all depend on script+hook and run independently of each other) and
genuine joins (video-plan depends on all three of audio, visual, and
subtitle). See DECISIONS.md D40 for the full reasoning, including the
second gap this exposed in `workflow.step()`'s completion detection and
how it was fixed without any core-file change.

```
research
   ↓
fact-check
   ↓
idea  (2-parent: research + fact-check)
   ↓
script
   ↓
hook
   ↓
   ├── audio ──────┐
   ├── visual ─────┤
   └── social-pkg  │
        ↓          │
   subtitle (needs real audio_artifact_id)
        ↓
   video-plan (3-parent: audio + visual + subtitle)
        ↓
   quality-control (needs every stage above)
        ↓
   publishing-package (CONTENT_PACKAGE; refuses to run if QC failed)
```

Every task in a real run sits at depth 0 (test 576); `MAX_TOTAL_NODES`
(32) is never approached (12 tasks per run); `MAX_FANOUT` is not
applicable at all, since no task in this design has a `parent_task_id`.

## 4. The artifact graph

While the task tree is shallow, the ARTIFACT graph these same twelve
tasks build is genuinely deep — nine-plus distinct ancestor levels (test
576) — because artifact lineage (`parent_artifact_ids`, validated by
`artifact-service.js`'s unmodified M19 checks: existence, same-workflow,
no cycle) is completely independent of task-tree shape, the same
principle M20's own header states. Every artifact carries real,
trusted-execution-context provenance (`agent_id`/`version_id`/
`registry_sha`/`workflow_id`/`task_id`, test 580) and a real,
content-derived 64-character checksum (test 573).

`CONTENT_PACKAGE` (a new artifact type, this milestone — `artifacts.js`
gained one enum entry, and migration 0008 widens the matching Postgres
CHECK constraint, mirroring migration 0005's identical fix) is the final
governed package: it **references**, never copies, every upstream
artifact. Its `content` holds only small, package-native fields (title,
description, hashtags, thumbnail concept, publishing metadata — each a
simple, explicitly-labeled synthetic derivation) plus a `references`
object of artifact ids; the SAME ids are also recorded in the artifact's
real `parent_artifact_ids`, so lineage is never just a content field a
handler could get wrong (test 574).

## 5. Provider abstraction: synthetic today, provider-layer-swappable later

Every artifact-producing stage calls `generateContent()` (M22) —
composing M21's governed provider invocation with M20's `createArtifact`
— against one of the five DETERMINISTIC providers registered in
`src/providers/default-registry.js`. No live network call, no paid API,
no credential, anywhere in this milestone. Every deterministic provider's
`[SYNTHETIC FIXTURE]` marker (text) or `fixture://` content_ref scheme
(media) survives unmodified into the real artifact record — never
described, in code, tests, or this document, as real AI generation.

`metadata.supported_artifact_types` on each agent version is
**advisory, descriptive metadata** — the same status `capabilities` and
`allowed_workflow_types` already have (`agents.js`'s own header: "Empty
means 'no stated restriction'... nothing here is a security decision").
It is not a new security-relevant field, and `validator.js`/`broker.js`
never read it.

Replacing a deterministic provider with a real one (Groq, first, per the
user's stated direction — see `docs/PROVIDERS.md` §3) is a **provider-layer
change**: a new file under `src/providers/`, registered in the provider
registry, with the same `provider_id`/`model_id` a content-factory
handler's `generateContent()` call already names. No content-factory
agent, no handler, no orchestrator code, and no core file
(`runtime.js` included) needs to change for that swap — the exact
property the M23 directive required.

## 6. Security boundaries

- **The Broker remains the sole tool-authorization authority.** No
  content-factory agent holds a tool (`allowed_tools: []` throughout);
  the one adversarial test exercising a downstream tool call through a
  generateContent-using agent (test 600) proves approval is unaffected by
  content generation.
- **Provenance is re-derived, never accepted from a handler's request.**
  Forged `agent_id`/`version_id`/`registry_sha` in a `generateContent`
  request are simply never read at that layer (tests 595-597) — and even
  if they somehow reached `artifact-service.js`, its own M19
  anti-impersonation check would independently ignore them a second time.
- **Guardian freezes are structurally unavoidable, not merely checked.**
  `router.js`'s own candidate-eligibility check excludes a frozen or
  disabled agent from being selected at all — no task record is even
  created (tests 586, 588, 607, 608). A genuine Guardian AUTO-freeze
  (three real repeated `HANDLER_ERROR` failures) was proven end to end,
  through the exact propose-run-release-evaluate pattern the orchestrator
  itself uses (test 589b).
- **Quality control is deterministic structural validation, labeled as
  such.** `runQualityControlChecks()` — a pure function, no store, no
  clock, no randomness — checks presence, artifact type, and length
  bounds against a summary of real artifact facts. Its report artifact
  carries an explicit `check_type: 'DETERMINISTIC_STRUCTURAL_CHECK'`
  field. It is never described as semantic AI quality evaluation, because
  it is not one.
- **`publishing-package-agent` fails closed on a failed quality-control
  result** (`input.qc_passed !== true` throws before any package is
  built) — mutation-tested directly (test 585; see DECISIONS.md D40 for
  a real mutation-testing gap this exposed and fixed).
- **The CEO-preparation interface is read-only and structurally
  incapable of granting authority.** `inspectWorkflowState`,
  `listFailures`, `listCompletedArtifacts`, `listAvailableSpecialists`
  hold no reference to the Broker, Guardian's freeze-imposing methods,
  the Approval Engine's `decide`/`revoke`, or any lifecycle/registry
  mutation method (test 593). No CEO agent exists in this milestone.

## 7. What this milestone does not do

No real network provider (Groq, Claude, OpenAI, or otherwise). No
relaxation of `MAX_DEPTH`, `MAX_FANOUT`, or `MAX_TOTAL_NODES`. No change
to `broker.js`, `validator.js`, `guardian.js`, `approval-engine.js`,
`router.js`, `workflow.js`, or `execution-coordinator.js`. No second
artifact-lineage or approval mechanism. No CEO agent. No persistence
redesign — the live execution path still runs only against the
synchronous in-memory store (D28); see DECISIONS.md D40 for exactly what
was and was not proven against a real Postgres database. No new
dependency, credential, network primitive, paid API call, or
quota-bypass mechanism of any kind.

---

## One live stage (Milestone 28)

Exactly ONE Content Factory stage can reach the real Groq boundary. The
other eleven, the orchestrator, and the CEO are unchanged and entirely
deterministic.

```
research (deterministic)
    ↓
idea (deterministic)
    ↓
cf-script-live-agent  ──►  capability admission
                           live-guard (Guardian, lifecycle, approval)
                           resource governor (budget, call ceiling)
                           invoke-async (timeout, retries = 0)
                           groq adapter  ──►  the one network egress
    ↓
SCRIPT artifact (provenance from trusted execution context)
    ↓
hook / audio / visual / subtitle / video / package  (all deterministic)
```

### It is opt-in, and off by default

`registerContentFactoryAgents()` does **not** register the live stage —
the same treatment the adversarial rogue fixture has always had. An
operator calls `registerContentFactoryLiveScriptAgent(store)`
explicitly. Even then, nothing is spent unless the M25 configuration
gates, live-guard, the resource governor, and the stage configuration all
agree.

### The live stage has its own capability

`cf-script-live`, deliberately distinct from `cf-script`. If the two
shared a capability, the router would be free to send an ordinary
deterministic run to the agent that spends real money.

### A handler cannot choose a provider

The live handler names a sentinel, `cf-live-text`, which is **not a
registered provider**. Writing `provider_id: 'groq'` reaches nothing —
no registry the Content Factory holds contains Groq. What the sentinel
resolves to comes from operator configuration; the request's own
`provider_id` and `model_id` are ignored.

### Governance runs before the handler, not inside it

`runtime.js` is synchronous and the live provider is not, so the network
call happens in an async phase BEFORE the task runs. That phase performs
every check and produces a sealed ticket. The handler then calls
`generateContent()` exactly as every other stage does, and the ticket is
honoured only if the caller is the admitted agent, the request matches
what was approved, and the ticket has not already been used.

Because runtime.js builds the artifact itself, provenance —
`agent_id`, `version_id`, `registry_sha`, `workflow_id`, `task_id` —
comes from the task record. A handler forging those fields changes
nothing.

### Failure fails closed

A provider failure never falls back to the deterministic provider. A
stage that quietly stops being live is a stage nobody can reason about,
so the task fails instead.

See DECISIONS.md D45 for the full rationale, the four new reason codes,
and the two real gaps mutation testing found.

---

## Four live stages, one pipeline (Milestone 29)

M28's single live stage is now four: `cf-research-live-agent`,
`cf-script-live-agent`, `cf-hook-live-agent`, and
`cf-social-package-live-agent`. Every other specialist — fact-check,
idea, audio, image, video, subtitle, quality control, publishing —
remains deterministic.

```
TOPIC
  -> RESEARCH (live)
  -> FACT_CHECK, IDEA (deterministic — QC/publishing require them)
  -> SCRIPT (live)
  -> HOOK (live)
  -> AUDIO, VISUAL, SUBTITLE, VIDEO_PLAN (deterministic)
  -> SOCIAL_PACKAGE (live)
  -> QUALITY_CONTROL, PUBLISHING_PACKAGE (deterministic, unmodified)
  -> CONTENT_PACKAGE
```

Each live stage is opt-in individually
(`registerContentFactoryLiveResearchAgent`, etc.) or all at once
(`registerAllContentFactoryLiveTextAgents`) — never by
`registerContentFactoryAgents()`.

### One invoker, several tickets

`content-factory-orchestrator.js` (unmodified) drives a whole workflow
through one long-lived runtime. `createMultiStageLiveInvoker` extends
M28's single-ticket primitive to hold several: `installTicket(agentSlug,
ticket)` is called by trusted orchestration code just before each live
stage's task runs, and lookup at consumption time uses the request's
TRUSTED `agent_slug` — so a ticket installed for research is not merely
refused if presented as script, it is structurally absent from the map
under script's key. An agent may be ticketed at most once per run;
re-installing throws, so a bug can never reset a stage's single-use
guarantee.

### Ticket scope

A ticket now carries the task and workflow it was resolved for, checked
again at consumption. Presenting a genuine ticket under the wrong task
id or the wrong workflow id fails `LIVE_TICKET_SCOPE_MISMATCH` — a
gap M28 never needed to close, since it only ever ran one ticket at a
time.

### What was proven, not assumed

Eight explicit ticket-transfer attacks (research→script, script→hook,
hook→social-package, cross-workflow, replay, tampered payload, tampered
task id, tampered artifact type) each deny with zero network calls.
Every Guardian freeze and lifecycle state is tested against each of the
four live stages independently, plus a mid-pipeline freeze that leaves
a completed stage's artifact valid while the next stage never runs.
Concurrent live calls are proven not to cross-contaminate provenance or
content, including the adversarial case of two calls sharing one
request object. See DECISIONS.md D46 for the full design and the two
mutation-testing findings it produced.

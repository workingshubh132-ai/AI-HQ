# Architecture Decisions

A running record of choices made and why. Read this first after a break —
it is here so we never re-argue a settled question, and so a decision can
be reversed deliberately rather than by accident.

Governing documents:

- [`CONSTITUTION.md`](CONSTITUTION.md) — the rules. Human CEO amends it.
- [`OPERATING_MODEL.md`](OPERATING_MODEL.md) — the machinery that enforces them.
- This file — why individual choices were made, in the order they were made.

---

## D1 — Where each part of the system lives

Decided 2026-08-21.

| Machine | Role | Permanent? |
| --- | --- | --- |
| Founder's laptop | Development. Writing and running code. | Yes |
| GitHub | Source of truth and backup. | Yes |
| Supabase | The database. | Yes |
| Claude cloud container | Temporary workbench for the AI engineer. | **No — erased each session** |
| Phone / iPad | CEO control panel and research. | Yes |
| Deployment host | Where the dashboard will run. Not chosen yet. | Later |

**Why it matters:** the Claude container is not backup. Work that is not
pushed to GitHub does not exist. Everything flows
Claude container → GitHub → laptop.

---

## D2 — Approvals must work from a phone

Decided 2026-08-21.

The founder is the approval authority and is often away from a desk.
Therefore:

- the dashboard is a **web page**, not a desktop program
- the approval queue must be usable one-handed on a small screen
- approving something must never require a terminal

**Why it matters:** a human-approval gate that is only reachable from a
desk is not a real safety control. This rules out any design where
approvals happen through a command line.

---

## D3 — Zero dependencies until one is proven necessary

Decided 2026-08-21.

The project currently installs **no** external packages. Before any
dependency is added we answer: do we actually need this, and what does it
cost to maintain?

**Why it matters:** every dependency is code we did not write, cannot
fully review, and must keep updated. A beginner-run project with fifty
packages is not maintainable.

---

## D4 — Modern JavaScript modules (ESM)

Decided 2026-08-21.

`package.json` sets `"type": "module"`, so the project uses `import`
syntax rather than the older `require`.

**Why it matters:** it is the current standard and matches what Supabase
and modern tooling expect. Switching later is painful; choosing now is free.

---

## D5 — The Constitution governs

Decided 2026-08-21.

`CONSTITUTION.md` is the governing document of AI-HQ. Where any plan,
prompt, document, or piece of code conflicts with it, the Constitution
wins. Only the human CEO may amend it.

**Why it matters:** without a single authority, "what are the rules"
becomes whatever the most recent conversation said. Rules that drift are
not rules.

---

## D6 — A prompt is not a security boundary

Decided 2026-08-21.

Every safety guarantee is enforced by deterministic code the agent cannot
reach: database constraints, the Tool Broker, and credential separation.
Prompts describe intent; they never authorize.

**Why it matters:** an agent instructed "never send email without
approval" will usually comply. Usually is not a safety property. Under an
unusual input, a confusing task, or text it read from a website, it may
not. This is the single most important principle in the project.

---

## D7 — Approval granularity: per-item now, batch and policy later

Decided 2026-08-21.

Three granularities are recognised: per-item, batch, and standing policy.
**v0.1 implements per-item only.** The Broker's authorization interface is
designed so the other two become additional resolution strategies behind
an unchanged signature.

A standing policy can never authorize a RED action for autonomous
execution.

**Why it matters:** at Phase 2 volumes, per-item approval makes system
throughput a function of the founder's free time — the exact outcome the
project exists to avoid. Changing the *unit* of human decision preserves
every safety property while letting human minutes scale with number of
workflow types rather than number of actions.

---

## D8 — Soft and hard freezes

Decided 2026-08-21.

**Soft:** reliability failures, retry storms, cost pacing. Auto-lifts after
a cooling period at reduced rate. A re-trip escalates to hard.

**Hard:** permission violation, approval bypass, budget breach, unknown
action, security boundary violation. **Human release only.**

Always freeze the narrowest scope that stops the problem.

**Why it matters:** the founder is available mainly at weekends. If every
freeze required a human, one flaky agent tripping a threshold on Tuesday
would stop the company until Saturday. This keeps absolute human authority
exactly where it matters — anything touching the permission boundary — and
nowhere it merely costs four days of output.

---

## D9 — One unified freeze mechanism

Decided 2026-08-21.

A single freeze record with `scope` (agent / workflow / ai_ceo / global),
`class` (soft / hard), `imposed_by`, `reason`, `created_at`, and optional
`expires_at`. Global emergency stop is the same record at the widest scope,
not a separate system.

**Why it matters:** two freeze systems can disagree about whether something
is frozen. One of them will be wrong at the worst moment.

---

## D10 — Idempotency before any external tool

Decided 2026-08-21.

Every externally side-effecting action carries an idempotency key. The
Broker refuses duplicate execution and returns the prior result.

**Why it matters:** if the Broker sends an approved email and crashes
before recording success, a retry sends it twice. Two identical pitches to
one prospect is real business harm and exactly what destroys trust in an
automated system.

---

## D11 — Revenue belongs to workflows, not agents

Decided 2026-08-21.

Agents are measured on quality, cost, latency, correction rate, human edit
rate, success rate, and permission violations. Workflows are measured on
leads, conversions, revenue, profit, acquisition cost, and human time.

**Why it matters:** in a chain of research → audit → pitch → outreach, no
principled split assigns a closed sale to one agent. Per-agent revenue
attribution produces numbers that look precise and mean nothing.

---

## D12 — Evaluation cost is proportionate to stakes

Decided 2026-08-21.

GREEN internal work is evaluated by deterministic checks only. Model-based
quality judgement runs only when deterministic checks pass and the task is
YELLOW or above a value threshold.

**Why it matters:** evaluating every task with a model roughly doubles LLM
spend against a ₹1,000–2,000/month ceiling. Deterministic checks are also
cheaper to trust: they cannot be argued out of a verdict.

---

## D13 — Data protection gates the first outbound tool

Decided 2026-08-21.

Before any real outbound tool exists, the outreach system must include
applicable legal and privacy requirements, platform terms, truthful
communication, opt-out handling, suppression lists, rate limiting, data
minimization, retention and deletion controls, and auditability.

**Why it matters:** lead generation means holding other people's data and
contacting them. "Do not spam" is an instinct; these are controls. Getting
this wrong is a legal and reputational problem, not a technical one.

---

## D14 — Revenue Intelligence is a GREEN agent (future scope)

Decided 2026-08-21. **Not built. Recorded so it is built correctly.**

`revenue-intelligence` will be a discovery, research and scoring agent with
**GREEN clearance**.

**It may:** discover opportunities · research public information · analyze
demand and competition · estimate economics · recommend experiments.

**It must not:** contact prospects · spend money · purchase paid APIs ·
publish externally · perform financial actions.

**Why it matters:** every prohibition above is enforced by its GREEN
clearance, not by its prompt. Contacting, spending, and publishing are
YELLOW or RED action types, and the Broker refuses them before any
handler is reached. The restriction is arithmetic, not instruction.

Two things to settle when it is built:

- **"Continuously discover" is a runaway-workflow risk.** Continuous means
  unbounded. It must run on a schedule with a per-run budget, not a loop.
- **Paid research data is YELLOW plus a budget line**, not a quiet
  upgrade. It stays fully GREEN only while its tools are free and
  read-only.

That this agent requires no new security architecture is the test of
whether the Broker was designed correctly.

---

## D15 — RED is refused before clearance is considered

Decided 2026-08-21, during implementation. **Deviates from the approved
Milestone 4 plan**, which had test 5 expecting `CLEARANCE_INSUFFICIENT`.

The Broker checks `tier === RED` *before* comparing tier to agent
clearance, so any agent attempting a RED action is refused with
`RED_REQUIRES_HUMAN` regardless of its clearance.

**Why it matters:** RED is human-only by definition, so no clearance value
can make it executable. Checking clearance first would mean
`RED_REQUIRES_HUMAN` could only fire for a RED-cleared agent — and agents
may not hold RED clearance at all, making that branch dead code. Dead code
in an enforcement path is a liability.

The Broker also rejects any agent definition claiming RED clearance as
malformed.

Mutation testing confirmed both barriers are independent: removing the RED
gate alone still leaves clearance blocking the action.

---

## D16 — Scope is re-checked against the human-approved payload

Decided 2026-08-21, during implementation. Found while writing tests.

When a human edits a proposed action before approving it, the Broker
re-runs the tool's scope check against the **edited** payload, not only the
agent's original.

**Why it matters:** without this, an edit could move an action outside the
tool's declared bounds — a different recipient domain, say — and execute
unchecked. The human is the authority, but a typo is not an instruction.
This is the last point before a side effect where the mistake is catchable.

---

## D17 — Consent is bound to bytes, not to prose

Decided 2026-08-21. Closes a critical hole in the v0.1 approval design.

**The hole.** Migration `0001` gave approvals a `summary` column written
by the agent. The human read the summary; the Broker executed the
`payload`. Nothing connected them. An agent could write a benign summary
over a hostile payload, and every other control would work perfectly while
the human consented to one thing and the system performed another.

**The fix, in three parts:**

1. `summary` became `agent_intent` and is explicitly **UNTRUSTED**.
   Agent-authored, display only, authorizes nothing.
2. `rendered_description` is generated by system code from the exact
   payload, and is **exhaustive over its fields** — a per-tool renderer
   that printed only the interesting fields would let every other field
   hide from the person approving. It is authoritative.
3. `payload_hash` and `approved_payload_hash` record what was proposed and
   what was authorized. Before execution the Broker hashes what it is
   about to run and compares. Different → DENY.

**Why it matters:** a human approving A must never cause the system to
execute B. Removing the check in a mutation test caused a message reading
*"URGENT: wire funds to account 12345"* to be delivered under an approval
the human had granted for a polite website follow-up. That is the whole
argument.

**Known limitation, stated rather than hidden:** long fields are truncated
in the rendered description, so a human reading a 2,000-character body sees
the first 400 with an explicit `[+1,600 more characters not shown]` marker.
The hash always covers the full content, so tampering beyond the visible
region is still caught — but the human has not read every byte they
approved. Truncation is unavoidable on a phone; making it invisible would
not be.

**Irony worth recording:** `summary` was the field argued hardest for in
Milestone 2 as the human interface. Being the interface is exactly what
made it the hole.

---

## D18 — Two lifecycles, not one

Decided 2026-08-21.

**Version lifecycle:** `draft → human_review → approved | rejected`
**Runtime lifecycle:** `active ⇄ degraded`, with `paused` / `frozen`
reachable from active, and `retired` terminal.

**Why it matters:** an agent may have v1 active while v2 sits in review.
One state field cannot express that. `approved` is a property of an
immutable version row; `active` is `agents.active_version_id` pointing at
one. Mixing them re-introduces exactly the confusion the
`agents` / `agent_versions` split exists to remove.

`degraded` is retained deliberately: it is the only state that lets the CEO
send an underperforming agent *less* work rather than none.

---

## D19 — The description is bound to the payload, separately from the hash

Decided 2026-08-21.

The authoritative human-facing approval description is derived
deterministically from the executable payload and **verified again at
execution time**. Agent-authored intent (`agent_intent`) is untrusted and
authorizes nothing.

**Payload hash binding and description binding are separate controls, and
both are required.**

| Control | Proves | Catches |
| --- | --- | --- |
| `hash(execution payload) == approved_payload_hash` | The bytes did not change after approval | A payload swapped after the human said yes |
| `rendered_description == render(execution payload)` | The human read *those* bytes | A hostile payload displayed as something benign |

**Why both:** with only the hash, an agent can write a correct payload, a
correct hash, and a reassuring description. Everything is internally
consistent and the human still consents to the wrong thing. With only the
description, the payload can be swapped afterwards. Neither control implies
the other.

Verified by mutation: removing the description binding causes an approval
displayed as *"Polite website follow-up"* to deliver a message reading
*"URGENT: wire funds to account 12345"*. Five tests fail when it is removed.

A side effect worth naming: because the renderer includes the tool id, the
description binding also **binds the tool**. An approval created against one
tool cannot authorize another, even with a matching action type and payload.

A granted approval with no `rendered_description` fails closed.

---

## D20 — Two execution boundaries, not one

Decided 2026-08-21 (Milestone 5).

The **Broker gates tool calls. The runtime gates agent execution.** Both
must hold.

**Why a second boundary exists:** the Broker never sees an agent being
invoked — it only sees requests for tools. A handler that computes without
calling a tool would run even for a paused agent or an unapproved version,
because nothing was ever asked of the Broker for it to refuse. The runtime
therefore performs its own pre-flight: agent resolvable, version approved,
lifecycle active, not frozen, budget present, input contract satisfied.

**This is not authorization moving out of the Broker.** Every tool call
still goes through it unchanged, and the runtime cannot permit anything the
Broker would refuse. The overlap is deliberate defence in depth.

Mutation-tested in three configurations: removing the Broker check alone
fails one test, removing the runtime check alone fails a different one, and
removing both allows a version that no human ever approved to execute and
produce output.

---

## D21 — `model_config` must be empty until a provider is approved

Decided 2026-08-21 (Milestone 5).

The validator rejects any agent version declaring a non-empty
`model_config`.

**Why it matters:** no model provider exists, is budgeted, or is reviewed. A
version naming one is either a mistake or an attempt to reach capability
that has not been approved. Failing closed at definition time is cheaper
than discovering it at runtime, and it means Milestone 5.3 must explicitly
relax this rule rather than silently inherit permission.

---

## D22 — The agent resolver keeps the Broker version-blind

Decided 2026-08-21 (Milestone 5).

`store.getAgent(slug)` returns a **resolved** flat view — runtime state
merged with the active version's security fields — so `broker.js` never
learns that versions exist.

**Why it matters:** it kept the enforcement boundary almost untouched while
adding the whole agent model. One check was added and nothing else changed,
so all 73 prior tests passed unmodified. A Broker that had to understand
version storage would have doubled in size and carried real regression risk
for no security benefit.

---

## D23 — Storage is a formal, tested contract; persistence is a separate decision

Decided 2026-08-21 (Milestone 6).

`src/storage.js` defines `STORAGE_CONTRACT` — the 19 methods actually
called from `src/` or `tests/` — and a structural checker,
`assertStorageContract()`. `createMemoryStore()` self-checks against it
before returning, so a method renamed or removed there without updating
the contract throws immediately at construction, not somewhere downstream
in the Broker.

`tests/storage-contract.test.js` is written as a reusable function,
`runStorageContractTests(label, createStore)`, run once today against
`createMemoryStore`. A future Postgres/Supabase adapter is exercised by
calling the same function against its factory — no test is rewritten, one
call is added.

**What this milestone explicitly does NOT do:** connect to a real
database. No project was created, no credential exists, no network call
was added, no dependency was installed. `createMemoryStore` remains the
only implementation and remains process-local and non-durable — state is
lost on exit, exactly as before. Pointing a real Postgres/Supabase
adapter at this contract is a separate decision requiring explicit
authorization: it introduces the project's first credential and its
first outbound network call, neither of which existed before and both of
which cross a boundary this contract does not.

**A finding surfaced while writing the contract.** `store.js` exposed
`putAgent(agent)` — a direct write into the flat `agents` map the Broker
reads clearance and tool access from, with no `resolveAgent()` step.
Nothing called it. Had something called it with a hand-built object
(`{clearance: 'RED', version_state: 'approved'}`), the Broker would have
trusted it completely, because the Broker never learns that version
storage exists — that is the whole point of D22. Removed rather than
formalized into the contract, and guarded by a regression test so it
cannot return unnoticed.

Three other unused methods — `listAgentVersions`, `listTasks`,
`getAgentRecord` — were read-only and posed no equivalent risk, so they
were left in place as documented non-contract introspection helpers
rather than removed. `addBudget` joins them for the same reason: nothing
calls it, but as a write it is structurally identical in risk to
`createTaskBudgets`, which is in the contract — it grants spending
capacity, not authorization.

**Why it matters:** the storage layer must never become an authorization
bypass (Constitution §13, §15). Formalizing the contract was the moment
that risk became visible, because writing down "what the Broker actually
needs from storage" made "what storage additionally, silently exposes"
visible by contrast.

---

## D24 — The model boundary is a second gate, structurally unable to reach the Broker

Decided 2026-08-21 (Milestone 7).

`src/providers.js` (an explicit, closed registry — no `register()` method,
so nothing can add a provider at runtime) and `src/model-runtime.js` (the
governed path from a request to a provider's response) give agents a
`callModel()` capability alongside the existing `callTool()`.

**The structural guarantee, not just a convention:** `createModelRuntime`
takes no `store`, no `broker`, no reference to `agents.js`'s mutation
functions. It cannot grant clearance, approve a version, modify a freeze,
or call a tool, because none of those are reachable from its scope — not
because it declines to use them. Mutation-tested: giving `invokeModel` a
`broker.execute` reference and exposing it fails test 138 immediately,
proving the test actually depends on the absence, not merely asserts it.

**The stronger claim, proven adversarially (test 139):** a handler that
*blindly forwards* a model's output straight into `callTool()` — including
output engineered to look like `{approved: true, proposed_tool: ...}` — is
still denied by the Broker on the agent's actual clearance and allowlist.
The model's word changes nothing, because the Broker's `authorize()`
signature has no field for it to occupy.

**Retry ceiling is clamped, not merely configured.** A request cannot ask
for unlimited retries: `MAX_RETRY_CEILING = 3` bounds it regardless of
what the request or the model's own config claims. Mutation-tested:
removing the clamp turns a `max_retries: 999` request into 1,000 real
provider calls.

**On "timeout," stated honestly.** The mock provider is synchronous. This
milestone measures elapsed time via the injected clock and classifies a
call that exceeded its ceiling as `TIMEOUT` *after* it returns — it does
not preemptively cancel a call in progress. Real cancellation needs a
genuinely asynchronous, abortable provider, which does not exist yet.
Described this way deliberately, not left to be assumed.

**Budget covers one dimension only.** `modelBudgets` enforces a spend
ceiling per `(provider_id, model_id)` pair, in a fictional `COST_UNITS` —
explicitly not ₹, not $, and not derived from any real provider's
pricing. Per-task and per-agent model-spend accounting are not wired to
this layer; a model call does not yet draw against the same task/tree
budgets the Broker already enforces for tools. Flagged as a real gap, not
implied as covered by the parameter's name.

**`checkContract` was extracted, not duplicated.** `src/contracts.js`
holds the exact logic `runtime.js` already had; `runtime.js` now imports
it instead of defining it locally. Pure mechanical extraction — proven by
the full prior suite passing unchanged immediately after.

**The validator's `model_config` rule is now opt-in, not overridden.**
`validateAgentVersion(version, { tools, providers })` — `providers` is
optional. Omitted, the exact pre-M7 message and behavior apply
unchanged (test 84 passes byte-identical, unmodified). Supplied, a
`model_config` naming a registered provider and model is accepted; an
unregistered one is still rejected, now with a more specific reason.
Mutation-tested: disabling the registered-provider check fails test 133,
and a version naming `totally-fake-provider` validates as `valid: true`
with the check off — proof the check does real work.

**A real bug found by the demo agent, not invented for the report.**
`runtime.js` checks `envelope.result` against `output_contract`
regardless of `envelope.status` — a contract describes `result`'s shape in
every state a handler returns, including a reported failure. The first
version of `echo-agent`'s failure branch returned `result: {}`, which
does not satisfy its own contract, so a legitimate business failure was
reported as `OUTPUT_CONTRACT_VIOLATION` instead of the more informative
`model call failed: BUDGET_EXCEEDED`. Fixed at the handler — both demo
handlers now return contract-satisfying placeholder values on failure —
deliberately not by loosening `runtime.js`'s check, which is correct as
it stands and was left untouched.

---

## D25 — The workflow engine is an orchestrator that reuses runtime.js, never a second execution path

Decided 2026-08-21 (Milestone 8).

`src/workflow.js` turns the single-task runtime into a bounded,
multi-task, dependency-aware engine. It calls `runtime.runTask()`
unmodified for every task it runs — there is exactly one execution path
from "a task exists" to "a handler ran," and the Broker sees exactly the
same tool calls it always did. Enforced tree limits for the first time
(`MAX_DEPTH=4`, `MAX_FANOUT=8`, `MAX_TOTAL_NODES=32`, all from
`limits.js`, none reimplemented) and deterministic loop detection
(`taskSignature`, also reused, not reimplemented).

**Workflow records live in `workflow.js`'s own closure, not `store.js`.**
Same call M7 made for model-call budgets: a workflow's state, node count,
and task ordering are orchestration bookkeeping the Broker never queries
and no future audit needs as a separately durable entity. `tree_id` IS
`workflow_id` throughout, which lets the existing tree-level budget
dimension (already in `store.js`, already tested since M4) serve as the
workflow's shared spending ceiling with zero new storage primitives.

**Two boundaries, both real, same pattern as D20.** `addTask()` runs the
full admission gauntlet at proposal time — shape, total-node ceiling,
depth, fan-out, dependency existence, loop detection, agent/version
validity, budget — and `runtime.js`'s pre-flight re-checks agent/version
validity and depth *again*, authoritatively, the moment a task actually
executes. Neither replaces the other: admission-time checks reject fast
and audit why; execution-time checks hold even if something about the
agent changed between admission and execution (paused, frozen, version
superseded).

**Untrusted model-proposed children get no shortcut.** A completed task's
envelope may carry `proposed_child_tasks`. `step()` passes every single
proposal through the *exact same* `addTask()` gauntlet used for
human-created tasks — a model proposing 20 children gets the first 8
admitted and the rest explicitly rejected and audited (never silently
truncated); a model proposing enough children across multiple parents to
exceed the total-node ceiling is stopped by that ceiling even though each
individual parent's fan-out was within limit; a model proposing the same
`(agent, input)` pair twice is stopped by the same loop detector a human
would be.

**Retries create new task records; they never resurrect the original.**
`retryTask()` mints a fresh task with `attempt_number` incremented and
`retry_of_task_id` pointing at the original, bounded by
`MAX_TASK_RETRY_CEILING = 3` regardless of configuration. Only
`RETRYABLE_REASONS = {HANDLER_ERROR}` auto-retries; every other failure
reason — unknown agent, unapproved version, policy violation, malformed
input, budget — never retries, because retrying a fact that will be
exactly as true on the second attempt turns one alarming event into a
tolerated pattern. Retries deliberately bypass loop detection (repeating
identical work on purpose is the entire point of a retry) but nothing
else — not the retry ceiling, not the total-node ceiling, not agent
validity.

**`addBudget` promoted from unused introspection to the formal storage
contract.** It existed on the in-memory store since M4.5 but had no real
caller and was explicitly excluded from `STORAGE_CONTRACT` (D23) as
"cheap to write, not needed." M8 gives it a genuine first caller:
`workflow.js` needs to add exactly one task-level budget row per child
task, and one `agent_day` row per agent slug encountered, without
re-triggering `createTaskBudgets`' tree-level row creation a second time.
Moved in `store.js` from the "introspection — NOT part of the storage
contract" block into the formal budgets section; added to
`STORAGE_CONTRACT` in `storage.js` with the same arity it always had. No
behavior changed, only where the method is documented to live.

**`failure_reason_code` added to task records.** The pre-existing `error`
field conflates a prose detail string with the bare reason code once a
detail exists (`error: detail ?? reason`) — useless for a retry policy
that needs to classify a failure exactly, not parse free text.
`failure_reason_code` is always the precise `RUNTIME_REASON`, set
alongside `error` in `runtime.js`'s `fail()` helper. Purely additive: no
existing test reads this field, and none needed to change.

**A workflow-freeze gap found during inspection, closed here.**
`broker.js` has checked `store.activeFreeze('workflow', tree_id, now)`
for every tool call since Milestone 4. `runtime.js`'s pre-flight — which
gates *agent execution*, a separate boundary from the Broker's *tool
execution* gate (see the file's own header, D20) — never checked the
`'workflow'` freeze scope, only `'agent'` and `'global'`. Invisible while
every tree was exactly one task; real the moment M8 makes multi-task
trees real, because a frozen workflow could otherwise still run agent
logic and spend model budget on tasks that could never successfully call
a tool. Added: `if (tree_id && store.activeFreeze('workflow', tree_id,
now)) return fail(...)`, placed alongside the existing agent/global freeze
checks.

**The one real bug this milestone found: `runtime.js` was silently
discarding the orchestrator's task record.** Before this fix, every call
to `runTask()` unconditionally called `store.createTask(...)` — correct
when `runtime.js` owns task creation (every M5–M7 caller), wrong now that
`workflow.js` pre-creates a richer record (carrying `depends_on`,
`workflow_id`, `attempt_number`, `retry_of_task_id`) before calling
`runTask()`. The unconditional create silently overwrote that record with
a plain one lacking those fields — surfaced as retries that never
terminated, because every `retryTask()` call read back `attempt_number:
undefined` (defaulting to `1`) and computed the same "next attempt: 2"
forever. Fixed by checking `store.getTask(task_id)` first: if a record
already exists, `runTask()` reuses it via `updateTask`, re-deriving only
the facts that are its own job to establish fresh at execution time
(`agent_id`, `agent_version_id`, `registry_sha`) — the same
"authorization is evaluated at execution time, not trusted from an
earlier snapshot" principle its pre-flight checks already apply. If no
record exists, behavior is byte-for-byte what it always was. Considered
and rejected the alternative of having `workflow.js` keep a wholly
separate bookkeeping structure instead of using `store.createTask` at
all — one source of truth in the store was judged safer than two
structures that could drift out of sync. Verified with the full 176-test
pre-M8 suite unchanged, plus a corrected retry trace showing exactly 3
handler calls and a clean `FAILED` termination.

**The diamond simulation is a reusable fixture, not a one-off demo.**
`src/demo-workflow.js` wires four deterministic, network-free,
credential-free agents into `research → {analysis, validation} → final`,
where `final` depends on both branches — the smallest shape that
exercises fan-out and convergence in the same workflow. Exported for
future milestones' tests to import directly, the same role
`demo-agent.js` has played since M5.

**What is not built here.** No CEO, no Guardian, no capability-based
routing, no real external tool, no real model provider, no real network
access, no Supabase connection, no production credential. `step()` is
synchronous and non-preemptible: "cancel" means "prevent not-yet-started
work from starting," not "interrupt work in progress" — honest given
nothing in this codebase is asynchronous yet, not a limitation hidden
behind the word "cancel."

---

## D26 — Multi-agent control plane: the router selects, it never authorizes

Decided 2026-08-21 (Milestone 9).

`src/router.js` answers exactly one question — "which eligible agent
should handle this?" — and structurally cannot answer "is this agent
allowed to do it?" It has no reference to the Broker, cannot call a tool,
and cannot mutate clearance, scopes, budget authorization semantics,
version approval, or a freeze. A caller still calls `engine.addTask()`
with whatever `agent_slug` the router selected, exactly as before M9, and
`addTask()`/`runtime.js` re-derive and re-check agent/version validity
from scratch regardless of what the router said. Delete the router
entirely, or bypass it and hand-type an agent_slug, and nothing
downstream would notice — the same gauntlet applies either way.

**Capabilities are advisory, never authorization — proven adversarially.**
`agent.capabilities` (declared on the immutable version since M5) is
router-matching metadata, nothing more. Test 182 constructs exactly the
attack this claim invites: `misleading-research-agent` declares
`capabilities: ['research']` but is authorized only for the harmless
`text.wordcount` tool. The router selects it purely on the label match —
that is correct, expected behavior, not a bug — and then its handler
tries to call `lead.score`, a tool never on its `allowed_tools`. The
Broker denies `TOOL_NOT_ALLOWED`. A capability string never became
allowlist membership, because there is no code path by which it could.

**Deterministic selection: no LLM, no randomness, no hidden heuristic.**
Eligible candidates are filtered by a fixed, ordered rule list — agent
resolvable, version approved, lifecycle active, not frozen, capability
declared, workflow type supported (if required), concurrency available,
budget not exhausted — then the first eligible candidate by ascending
`agent_slug` wins. Same task, same store contents, same
`ROUTING_POLICY_VERSION` → same decision, always. Mutation-tested:
disabling `evaluateCandidate` entirely (every candidate reads as
eligible) fails 22 of 36 router tests; each individual check
(capability, concurrency, budget, agent freeze, global freeze, workflow
freeze) was also mutated separately and each produces its own specific
test failures, not just the broad one.

**Health reuses `RUNTIME_STATE` — it is not a new field.**
`RUNTIME_STATE` already has ACTIVE / PAUSED / DEGRADED / FROZEN / RETIRED,
and the Broker and runtime.js already refuse to run anything for a
non-`'active'` agent. Directed to add "health metadata," the actual
addition is `setAgentHealth()` — a thin, audited wrapper over the
*existing* `store.setLifecycleState` that records a reason and timestamp
for a transition that was previously silent. No parallel `health_state`
field was created. Two representations of the same fact is exactly the
mistake D23 and D25 already rejected once each; a third instance would
have made it a pattern.

**Concurrency is reservation accounting, not real concurrency.**
Nothing in this codebase is asynchronous — `runtime.runTask()` runs a
task to completion synchronously within one call, so two tasks for one
agent cannot actually overlap in wall-clock time today, and pretending
otherwise would be dishonest. `route()` reserves a slot in its own
in-memory `Map` when it selects an agent; a caller releases it via
`release()` once the task reaches a terminal state. This is bookkeeping a
future asynchronous runtime could rely on for real — tested as exactly
that, not oversold as concurrent execution that does not exist yet.

**Two genuinely new, minimal, justified additions — everything else
reuses what already existed.** `store.listAgents()` (arity 0, read-only,
returns the same resolved shape `getAgent` already returns) was added to
`STORAGE_CONTRACT` because the router cannot select among candidates it
cannot enumerate, and nothing before M9 ever needed to list every agent
at once. `allowed_workflow_types` (an array on the immutable version,
default empty) and `concurrency_limit` (an optional field on the mutable
agent record, default null → the router's own ceiling) were added
because no existing field represented either concept — checked first,
against `git grep`, not assumed. Both are advisory: the Broker never
reads them, `validator.js` was not touched to accommodate them, and
`concurrency_limit` deliberately sits outside `validator.js`'s
POLICY-checked `limits` object because it is a scheduling concern, not a
security one. `department` and `capabilities` were requested again in
this milestone's spec but already existed on the version since M5 — not
duplicated, only newly exposed on `resolveAgent`'s flattened view where
useful. A `registry_sha` field on the version was considered and
rejected: that provenance concept already exists, per-task, in
`runtime.js`'s task records, and duplicating it onto the version would
create two sources of truth for the same fact.

**`broker.js`, `validator.js`, and `runtime.js` were not touched at all
this milestone.** Every M9 change lives in a new file (`router.js`,
`demo-router-agents.js`) or is a strictly additive change to
`agents.js`/`storage.js`/`store.js` — new optional fields with safe
defaults, one new read-only method. No existing test needed to change
for any of it; the entire 208-test suite from M8 passed unmodified
before a single M9 test was added.

**Deferred, deliberately.** Guardian does not exist yet — nothing here
automatically freezes or pauses an agent; `setAgentHealth()` is a manual,
explicitly-called API, exposed for a future Guardian to call, not
wired to any automatic trigger. No agent-to-agent messaging of any kind
exists; delegation, if it is ever needed, goes through the existing
task/workflow mechanism, not a new channel. No external tool, no real
model provider, no real network access, no production credential.

---

## D27 — Guardian: an automated caller of a freeze primitive that already existed

Decided 2026-08-21 (Milestone 10).

`src/guardian.js` observes and freezes. It never authorizes. Its entire
write surface is one call — `store.addFreeze(...)` — the exact primitive
the Broker (M4), runtime.js (M8), and router.js (M9) already check via
`store.activeFreeze(...)`. Before this milestone, `addFreeze` had never
been called from `src/` at all — only from tests. Guardian is the first
real caller of an enforcement point that has existed since the beginning;
it does not add a new one.

**Structurally incapable of granting authority, not just instructed not
to.** `createGuardian({ store, audit, clock, policy })` holds no
reference to the Broker, runtime.js, workflow.js, or router.js. It cannot
call a tool, execute a task, approve a version, raise a budget limit, or
change clearance/allowed_tools — there is no code path by which it could,
the same "isolation by construction, not convention" property M7
established for the model boundary (D24) and M9 established for the
router (D26). Test 213 sweeps the source for every store mutation method
belonging to another boundary (`setActiveVersion`, `registerAgent`,
`addApproval`, `chargeBudgets`, `addAgentVersion`, `setLifecycleState`,
`createTask`, `updateTask`, the idempotency writers) and asserts none of
them appear — only `addFreeze` does.

**Guardian cannot lift what it freezes, and that is not an oversight.**
There is no "remove freeze" method on the storage contract for Guardian
to call even if it wanted to — freezes are append-only. A soft freeze
self-expires via `expires_at`; a hard freeze (global budget exhaustion —
the one condition serious enough to be called a "global emergency" in
the M10 directive) carries none, exactly matching store.js's own
long-standing freeze comment: "hard freezes... human release only."
Guardian imposing a freeze and Guardian removing one were never meant to
be symmetric powers, and test 219 confirms the returned object exposes
no method — `liftFreeze`, `unfreeze`, `approve`, `execute` — that could
make them so.

**Six deterministic, threshold-counting policies, no ML, no LLM, no
wall-clock window.** Every check filters the audit log for a fixed event
type, takes the most recent `N` matching records (a bounded recent
window over observed events, not a real-time window this system has no
background clock to measure), and compares a count against a named
constant in `GUARDIAN_POLICY`: agent failure rate, workflow failure rate,
repeated authorization denials, retry spikes, global budget exhaustion,
and per-agent spending warnings. This is the moment
OPERATING_MODEL.md's open-questions table named for deciding these
numbers ("Numeric thresholds for soft-freeze triggers and cooling
period | First Guardian implementation") — `AGENT_FAILURE_THRESHOLD:
3` of `AGENT_FAILURE_WINDOW: 5`, `SOFT_FREEZE_COOLDOWN_MS: 15 minutes`,
and the rest are recorded as placeholders chosen for a working first
implementation, explicitly not tuned against real traffic that does not
exist yet. Mutation-tested individually: disabling any one of the six
threshold comparisons, or the idempotency guard inside `impose()`, each
produces its own distinct, specific test failures — not one shared
symptom.

**Evidence is the existing audit log, not a new observation channel.**
Guardian requires zero new instrumentation anywhere else in the
codebase — `runtime.task`, `broker.decision`, and `workflow.retry` audit
events, plus the existing `agent_day`/`global_month` budget rows, already
carried everything every policy needs. It discovers which workflows to
check by scanning `tree_id`/`workflow_id` fields already present on audit
records, because (per D25) workflow records live in workflow.js's own
closure and Guardian was deliberately not given a reference to the
workflow engine to query them directly — one less coupling, one less way
Guardian's reach could quietly grow.

**Idempotent by construction, not by convention.** `impose()` checks
`store.activeFreeze` before adding a new freeze row; a condition that is
still breaching an already-frozen scope is recorded as
`guardian.condition_persists`, not as a second freeze. Without this,
calling `evaluate()` repeatedly (its natural usage pattern, since nothing
in this codebase runs it on a real timer) would silently accumulate
duplicate freeze rows — harmless to `activeFreeze`'s `.find()`
semantics, but audit noise masquerading as new incidents. Mutation-tested
directly: removing the guard makes test 208 fail.

**What this milestone deliberately does not do.** `setAgentHealth()`
(M9, router.js) remains a manual, human-directed API — Guardian was not
wired to call it, preserving D26's own statement that it is "not wired
to any automatic trigger." No alerting, no health summaries, no reports
(M28 territory). No new storage primitive, no schema change, no
dependency. `broker.js`, `validator.js`, `runtime.js`, `router.js`, and
`workflow.js` are byte-for-byte untouched by this milestone — the
cleanest diff of any milestone so far: two new files, zero modified
lines anywhere else.

---

## D28 — Durable persistence is real and tested, deliberately not yet live

Decided 2026-08-21 (Milestone 11).

`src/postgres-store.js` is a genuine, working Postgres implementation of
every method `store.js` implements, proven against the *exact same*
assertions in `tests/storage-contract.test.js` — the shared harness that
has said "a future Postgres/Supabase adapter later, with no change to
this file beyond adding a second call at the bottom" since M6. That
promise held: the file gained one `beforeEach` parameter (a no-op for the
in-memory store) and one more call at the bottom. It is genuinely tested
against a real, local PostgreSQL 16 instance, including the two
properties the in-memory store's own header admits it cannot prove:
concurrency-safe idempotency (25 truly parallel `claimIdempotency` calls
for one key, proven to produce exactly one winner) and `updateTask`'s
row-locked read-modify-write (two concurrent patches to different fields
of the same task, proven that neither is lost).

**The one deliberate, load-bearing limitation: this is not wired into the
live system.** `broker.js`, `runtime.js`, `workflow.js`, `router.js`, and
`guardian.js` all call `store.<method>()` and `audit.write(...)`
synchronously and use the return value directly — zero `await` anywhere
in any of them, correct for the in-memory store they were built and
tested against, which does no real I/O. A real network call to Postgres
cannot be synchronous in Node.js; every method on the Postgres adapter
necessarily returns a Promise. Making it the live store would mean adding
`await` at every single call site across the entire security core —
touching precisely the files this project has repeatedly said not to
modify casually, for a change with a blast radius far larger than "add
persistence" implies. That rewrite is not started here, is not silently
implied by "the adapter exists," and is named as its own future
milestone rather than attempted at the end of this one under time
pressure. The M11 directive's own fallback — "build and fully test the
adapter locally" when a live credential boundary isn't the actual next
step — is exactly what this is.

**The schema had to be rebuilt, not incrementally altered.** Migrations
0001/0002 modeled the v0.1 skeleton from Milestone 2, before the
agents/agent_versions split (M5), the workflow/task-tree engine (M8),
budgets, freezes, or idempotency existed. Neither had ever run against a
real database (0002's own header: "table contains zero rows"). Migration
0003 drops and recreates every table rather than pretending an ALTER
path onto a schema that was never live — the honest operation for a
design that was superseded by seven milestones of real implementation
before it was ever deployed. Two real integrity bugs were found and
fixed during this rebuild, before they ever reached production: a
foreign key from `agent_versions.agent_id` to `agents.id` would have
rejected the exact "add the version before the agent record exists yet"
ordering every real call site in this codebase uses (confirmed by
`git grep` across every test and demo-agent file, not assumed); the same
was true for `tasks.agent_version_id`, which `runtime.js` populates
*before* its own pre-flight checks reject an unresolvable version. Both
constraints were removed, with the reasoning recorded in the migration
file itself, not silently dropped.

**`pg` is the first runtime dependency this project has ever taken.**
Zero dependencies was correct for ten milestones that did no real I/O.
Speaking the Postgres wire protocol from Node.js without it is not a
serious option. `pg` is the de facto standard client, minimal in its own
dependency tree (`pg-connection-string`, `pg-pool`, `pg-protocol`,
`pg-types`; `pg-native` is an unmet *optional* dependency, correctly
never installed). Added for exactly the purpose that made it
unavoidable, not preemptively.

**`AI_HQ_DATABASE_URL` and `AI_HQ_TEST_DATABASE_URL` are deliberately
separate variables.** The test suite creates and drops databases and
truncates tables freely — exactly the behavior that must never be
possible against a real, configured project by accident. No code path in
this repository reads `AI_HQ_DATABASE_URL`; nothing but a human running
`npm run migrate` does. `.env` remains untracked (`.gitignore` already
covered it); no real connection string was ever written to a committed
file. All testing in this milestone ran against a local, disposable
PostgreSQL 16 instance with a role granted `CREATEDB` for test isolation
only — a grant this repository's own `.env.example` never suggests
applying to a real deployment's credential.

**A genuine concurrency bug was found in the test suite itself, not in
the adapter.** `node:test` runs separate test *files* concurrently by
default. `tests/storage-contract.test.js`'s Postgres block and
`tests/postgres-store.test.js` both originally pointed at the same
`AI_HQ_TEST_DATABASE_URL` database directly — truncating and asserting
row counts while the other file's tests ran at the same time against the
same tables, producing real, intermittent cross-file failures the first
full-suite run surfaced immediately. Fixed with
`tests/helpers/pg-test-db.mjs`: each file that needs a live, mutable
database creates and migrates its own uniquely-named one at load time
and drops it afterward — the same isolation a real CI matrix job would
have, not achieved by serializing the whole suite (which would have
slowed down every future Postgres-backed test file for everyone, in
exchange for a problem that was actually about resource sharing, not
about needing to run one test at a time).

**Migration runner, health check, and startup validation are real and
independently tested.** `scripts/migrate.mjs` tracks applied files in a
`schema_migrations` table it creates itself (never relying on a
migration file to bootstrap its own tracking, which no migration file
here does), applies pending files in filename order inside a transaction
each, and is idempotent. `checkPersistenceHealth` and `validateStartup`
(`postgres-store.js`) never throw — a health check able to crash the
process it protects would be worse than none — and `validateStartup`
names the *specific* migration file missing rather than a generic
connection failure, tested against a genuinely unmigrated fresh database,
not a mock.

---

## Deliberately deferred

Not decided yet, and not needed yet. Listed so they are not forgotten.

| Question | Decide when |
| --- | --- |
| Split into `packages/` and `apps/` (npm workspaces) | A second package actually exists |
| TypeScript configuration | The first real code is written |
| Dashboard framework | The dashboard is started |
| Deployment host | There is something worth hosting |
| Supabase free-tier inactivity pausing | Connecting Supabase |
| Soft-freeze thresholds and cooling period | Guardian milestone |
| Approval queue maximum | Approval mechanism milestone |
| Where the freeze record lives (table vs columns) | Guardian milestone |
| Concrete budget figures | Before the first paid API call |
| Approval staleness handling | v0.2 |

Empty folders are not created ahead of need. Git cannot store an empty
folder, and structure with nothing in it is a guess about the future
dressed up as a plan.

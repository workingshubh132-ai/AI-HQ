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

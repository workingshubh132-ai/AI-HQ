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

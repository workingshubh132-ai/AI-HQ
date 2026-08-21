# AI-HQ Operating Model

**Status:** Approved 2026-08-21 · **Governed by:** [`CONSTITUTION.md`](CONSTITUTION.md)

How AI-HQ works mechanically. The Constitution states the rules; this document
states the machinery that enforces them. Where the two conflict, the
Constitution wins.

---

## 1. The enforcement map

Every guarantee traced to the deterministic thing that enforces it. If a row's
enforcement column fails, the guarantee is gone — no prompt compensates.

| Guarantee | Enforced by | **Not** by |
| --- | --- | --- |
| Retry limit cannot be exceeded | `tasks_attempts_check` DB constraint | Agent counting |
| Unauthorized tool cannot be called | Broker allowlist | Agent instructions |
| Nothing sends externally unapproved | Agent holds no credentials | Agent restraint |
| No agent approves its own action | Only a human writes `decided_by` | Agent honesty |
| Budget cannot be exceeded | Broker checks before spending | Agent estimate |
| Decision always has an owner | `approvals_decision_complete_check` | Convention |
| History cannot be quietly rewritten | Append-only discipline + audit review | Trust |

The first, sixth, and part of the seventh are already built and tested
(migration `0001`, commit `3efe088`).

---

## 2. Component responsibilities

| Component | Owns | Never does |
| --- | --- | --- |
| **Human CEO** | Goals, YELLOW approvals, RED execution, freeze release, version promotion, budgets | — |
| **Guardian** | Threshold monitoring, freezes, alerts | Business work; anything requiring judgement |
| **AI CEO** | Decomposition, routing, evaluation, prioritization, reporting | Approve YELLOW, execute RED, lift freezes, bypass Broker |
| **Agent runtime** | Executing one agent config against one task | Hold credentials, call tools directly |
| **Tool Broker** | All authorization, all credentials, all execution of tool calls | Judge quality or business value |
| **Database** | All durable state and history | — |

**One runtime, many configurations.** Adding an agent means inserting a row,
not deploying software. This is what makes 1 → 100 agents possible without
changing the security model, and what lets the Guardian freeze an agent by
writing a column.

---

## 3. Agent output envelope

Every agent returns this shape. No exceptions.

```
status            ok | partial | failed
result            payload matching the agent's output_contract
confidence        low | medium | high
assumptions       [ ... ]   what it guessed at
evidence          [ ... ]   sources for factual claims
proposed_actions  [ { action_type, payload, summary, idempotency_key } ]
cost              { tokens, calls, currency }
errors            [ ... ]
```

Two properties carry the weight:

**An agent never reports having acted externally**, because it never can. It
returns *proposals*. Execution belongs to the Broker.

**`summary` is the human interface.** It becomes the `summary` column in
`approvals` — the sentence read on a phone. The column already exists with a
10–500 character constraint, which forces a real sentence and keeps it
readable on a small screen. An approval that cannot be understood is not
consent.

---

## 4. State machines

### Agent lifecycle

```
draft ──► testing ──► active ⇄ degraded ──► retired
                        │         │
                        ▼         ▼
                     paused    frozen
```

| Transition | Who may perform it |
| --- | --- |
| `draft → testing` | Human or AI CEO |
| `testing → active` | **Human only** (version promotion) |
| `active ⇄ degraded` | AI CEO, on measured performance |
| `→ paused` | AI CEO or human |
| `paused →` | AI CEO or human |
| `→ frozen` | Guardian or human |
| `frozen →` (soft) | Automatic, after cooling period, at reduced rate |
| `frozen →` (hard) | **Human only** |
| `→ retired` | **Human only** |

The asymmetry is the point: the AI CEO can pause but cannot unfreeze a hard
freeze. Oversight that the overseen party can reverse is not oversight.

### Task lifecycle

The eight states in migration `0001`:

```
pending → assigned → running ──────────────► completed
                        │
                        ├──► awaiting_approval ──► completed | cancelled
                        │
                        └──► failed ──► running   (retry, attempts < max)
                                   └──► paused    (attempts exhausted → human)
```

`paused` means *waiting for a human*, not *retrying more slowly*.

### Approval lifecycle

```
pending ──► approved | rejected     (terminal)
```

`approvals_decision_complete_check` makes it impossible to leave `pending`
without recording who decided and when.

### Freeze lifecycle

One mechanism, four scopes, two classes.

```
active ──► soft   ──► cooling ──► lifted (reduced rate)
                          └─────► hard    (re-trip escalates)
active ──► hard   ──────────────► lifted  (human only)
```

| Field | Values |
| --- | --- |
| `scope` | `agent` · `workflow` · `ai_ceo` · `global` |
| `class` | `soft` · `hard` |
| `imposed_by` | `guardian` · `human` |
| `reason` | Free text |
| `created_at` | Timestamp |
| `expires_at` | Optional; soft freezes only |

Global emergency stop is `scope=global, class=hard, imposed_by=human`. Not a
separate system — the same record with the widest scope.

---

## 5. Key data flows

### Flow 1 — GREEN, fully autonomous

```
Human goal → AI CEO decomposes (depth ≤ 4, fan-out ≤ 8, tree budget claimed)
  → task assigned → agent runs → agent requests tool
  → BROKER: 9 checks → ALLOW → execute → log
  → agent returns envelope → CEO evaluates → PASS → completed
```

### Flow 2 — YELLOW, the safety path

```
Agent returns proposed_action { action_type, payload, summary, idempotency_key }
  → CEO: is action_type within this agent's clearance?
       no  → VIOLATION → Guardian, no retry
       yes → approvals row created (status=pending, payload frozen)
  → task → awaiting_approval, execution suspended
  → 📱 HUMAN: approve / edit / reject
       approved → approved_payload stored → Broker re-checks all 9
                → idempotency key checked → execute → log
       rejected → task cancelled, reason recorded
```

The original `payload` is never mutated. That is what makes human edit rate
measurable, which is the metric that reveals whether an agent's judgement
matches the founder's.

### Flow 3 — Failure and escalation

```
Failure → classify
  transient          → backoff, retry            (attempts++)
  invalid shape      → CORRECT once              (attempts++)
  quality shortfall  → CORRECT with feedback     (attempts++)
  permission violation → NO RETRY → Guardian → hard freeze candidate
  budget breach        → NO RETRY → Guardian
  unknown              → escalate

attempts = max_attempts → task PAUSED → human notified
```

### Flow 4 — Guardian

```
Guardian reads event stream → threshold breached
  → observe → warn → throttle → freeze (narrowest scope) → alert human
  → in-flight work in scope pauses; no new assignments
  → soft: auto-lift after cooling, reduced rate; re-trip → hard
  → hard: waits for human
```

---

## 6. The Tool Broker

The keystone. Everything else can be wrong without a breach; if the Broker is
wrong, the rest is decoration.

```
Agent: "call tool T with arguments X"
                  ↓
          ┌───────────────┐
          │  TOOL BROKER  │   owns every credential
          └───────────────┘

  authorize() — decides, executes nothing
   0. Request well-formed?                    → DENY  INVALID_REQUEST
   1. Global freeze active (any class)?       → DENY  GLOBAL_FREEZE
   2. Agent exists?                           → DENY  UNKNOWN_AGENT
      Agent definition well-formed?           → DENY  INVALID_AGENT
   3. Agent frozen?                           → DENY  AGENT_FROZEN
      Agent lifecycle state == active?        → DENY  AGENT_NOT_ACTIVE
   4. Workflow frozen?                        → DENY  WORKFLOW_FROZEN
   5. Tool registered?                        → DENY  UNKNOWN_TOOL
   6. Tool on this agent's allowlist?         → DENY  TOOL_NOT_ALLOWED
   7. Action type known?                      → DENY  UNKNOWN_ACTION (resolves to RED)
   8. Action tier is RED?                     → DENY  RED_REQUIRES_HUMAN
   9. Action tier ≤ agent clearance?          → DENY  CLEARANCE_INSUFFICIENT
  10. Scope constraints satisfied?            → DENY  SCOPE_VIOLATION
  11. Budget exists at every level?           → DENY  BUDGET_MISSING
  12. Budget sufficient at every level?       → DENY  BUDGET_EXCEEDED
  13. Tier gate
        GREEN  → ALLOW
        YELLOW → resolve approval:
                   no approval          → NEEDS_APPROVAL  APPROVAL_MISSING
                   malformed            → DENY  INVALID_APPROVAL
                   wrong action/payload → DENY  APPROVAL_MISMATCH
                   pending or rejected  → DENY  APPROVAL_NOT_GRANTED
                   expired              → DENY  APPROVAL_EXPIRED
                 then, on a granted approval:
                   hash(execution payload) ≠ approved_payload_hash
                                        → DENY  APPROVAL_PAYLOAD_MISMATCH
                   rendered_description ≠ render(execution payload)
                                        → DENY  APPROVAL_DESCRIPTION_MISMATCH
                   approved payload out of scope
                                        → DENY  SCOPE_VIOLATION
                                        → otherwise ALLOW

  execute() — runs only on ALLOW
  14. External action without an idempotency key?
                                        → DENY  IDEMPOTENCY_KEY_REQUIRED
  15. Key already claimed and in flight? → DENY  IDEMPOTENCY_IN_FLIGHT
  16. Key already completed?            → replay prior result, invoke nothing,
                                          charge nothing
      otherwise → claim key → INVOKE HANDLER → charge budgets → record result
                  handler threw?           → HANDLER_ERROR, key recorded failed,
                                             no budget charged. A retry needs a
                                             NEW key: a retry is a new attempt
                                             and the caller must decide it is safe
```

**Ordering is deliberate.** A global freeze short-circuits before any budget
arithmetic. RED is refused before clearance is consulted, because no clearance
value can make a RED action executable — checking clearance first would leave
`RED_REQUIRES_HUMAN` reachable only by an agent holding RED clearance, which
the validator forbids, making it dead code in the enforcement path.

**The two approval integrity checks are independent and both required.** The
hash proves the bytes did not change after approval; the description proves the
human read those bytes. With only the first, a hostile payload displayed as a
polite follow-up executes faithfully.

Every decision is logged, **allow and deny alike**. There is exactly one call
site in `broker.js` where a handler is invoked, guarded by a single ALLOW
check. **The agent's prompt is consulted at no point in this sequence.**

Every decision is logged, **allow and deny alike**. Checks are ordered cheapest
and most absolute first: a global freeze short-circuits before any budget
arithmetic.

**The agent's prompt is consulted at no point in this sequence.**

### Designed for later extension

Check 9 is the only step that changes when batch and standing-policy approvals
arrive. Its interface is therefore defined now as:

```
authorize(agent, action_type, payload, idempotency_key) → ALLOW | DENY | NEEDS_APPROVAL
```

v0.1 answers this by looking for a matching per-item `approvals` row. Batch and
policy approvals become additional resolution strategies behind the same
signature — the calling code never changes. This is what "designed so it can be
added without rebuilding the authorization architecture" means concretely.

### Tool registry entry

| Field | Purpose |
| --- | --- |
| `tool_id` | Stable identifier |
| `action_type` | Maps into the action registry |
| `tier` | GREEN / YELLOW / RED — **static, never runtime-decided** |
| `side_effect` | `none` · `internal` · `external` |
| `reversible` | Boolean |
| `cost_estimate` | For pre-flight budget checks |
| `requires_idempotency` | True for anything externally side-effecting |

Unknown `action_type` → RED. Unlisted tool → DENY. Missing budget → DENY.

---

## 7. CEO evaluation

Ordered so the cheapest, least arguable checks run first:

| # | Check | Kind | Failure |
| --- | --- | --- | --- |
| 1 | Schema valid | Deterministic | CORRECT |
| 2 | Permission valid | Deterministic | **VIOLATION** |
| 3 | Action clearance valid | Deterministic | **VIOLATION** |
| 4 | Scope valid | Deterministic | CORRECT |
| 5 | Budget valid | Deterministic | ESCALATE |
| 6 | Task scope valid | Deterministic | CORRECT |
| 7 | Evidence present | Deterministic | CORRECT |
| 8 | Quality criteria satisfied | **Model judgement** | CORRECT / ESCALATE |

Verdicts: **PASS · CORRECT · RETRY · ESCALATE**

Step 8 is the only model call, and it runs only when 1–7 pass **and** the task
is YELLOW or above a value threshold. GREEN internal work stops at step 7.
This keeps evaluation cost proportionate to what is at stake.

**A model verdict may never overturn a deterministic failure.** Steps 2 and 3
are security checks: their failure is a violation, never a retry, never
something step 8 can excuse.

---

## 8. Failure model

| Class | Response | Retry |
| --- | --- | --- |
| Transient (network, rate limit) | Backoff | Within limit |
| Invalid output shape | CORRECT once | Once |
| Quality shortfall | CORRECT with feedback | Within limit |
| **Permission violation** | Guardian event, hard-freeze candidate | **Never** |
| **Budget breach** | Stop, Guardian event | **Never** |
| Unknown / unclassified | Escalate | Never |

**Retrying a permission violation turns one alarming event into a pattern the
system tolerates.** That is why the answer is never.

**Fail closed.** Any uncertainty stops the workflow rather than proceeding on a
guess.

### Three independent counters

| Counter | Question | At threshold |
| --- | --- | --- |
| Task attempts | Is this task stuck? | Pause → human |
| Agent failure rate (rolling window) | Is this agent broken? | Degrade → soft freeze |
| Violation count | Is something breaching boundaries? | Hard freeze |

One task failing three times is normal. An agent failing 30% of everything is a
different problem, and only the second counter sees it.

### Runaway prevention

| Guard | v0.1 value |
| --- | --- |
| Tree depth | 4 |
| Fan-out per task | 8 |
| Tree budget | Shared, inherited — not per-node |
| Wall-clock per tree | Bounded |
| Loop signature detection | Guardian |

---

## 9. Memory

| Layer | Lifetime | v0.1 |
| --- | --- | --- |
| Task context — one task's input and output | Ephemeral | ✅ |
| Workflow memory — artifacts across a task tree | Tree lifetime | ✅ |
| Durable records — Postgres | Permanent | ✅ |
| Knowledge base — retrieval over past work | Permanent | ❌ |

**No agent has private memory.** All state is in the database, readable and
auditable.

---

## 10. Measurement

Computed from `audit_logs`. Not stored — do not store what can be derived.

**Per agent:** first-attempt PASS rate · correction rate · **human edit rate** ·
human rejection rate · attempts · cost · latency · permission violations (must
be zero).

**Per workflow:** leads · conversions · revenue · profit · acquisition cost ·
human time.

**Human attention:** approvals/day · approval time · interventions/day · human
minutes per successful outcome · human minutes per rupee.

Revenue attaches to workflows. Attempting to split a closed sale across
research, audit, pitch, and outreach agents produces numbers that look precise
and mean nothing.

---

## 11. v0.1 scope

### Build, in order

| # | Component | Why here |
| --- | --- | --- |
| 1 | Action registry | Everything consults it |
| 2 | **Tool Broker** + denial test suite | The enforcement point. Prove DENY before anything can ALLOW |
| 3 | Agent loader | Makes agents data |
| 4 | Shared agent runtime | One runtime, many configs |
| 5 | Task runner | The execution loop |
| 6 | Deterministic CEO evaluator | Steps 1–7 only |
| 7 | Approval mechanism | Per-item only |
| 8 | Audit writer | Nothing is trustworthy without it |
| 9 | Basic Guardian | Counters + freeze |
| 10 | One test agent | GREEN clearance, **zero tools** |
| 11 | End-to-end workflow test | Proves §41 of the Constitution |

### Zero external side effects

v0.1 ships with **no tool that touches the outside world.** All three tiers are
exercised with fake, local, and deterministic tools. YELLOW blocking, RED
refusal, Guardian freezing, and Broker denial can all be proven with nothing at
stake.

### Deliberately not built

Department managers · more than one agent · model-based quality evaluation ·
Guardian anomaly detection beyond counters · vector memory · dashboards · batch
and policy approvals · any external tool · agent self-modification · Instagram,
SaaS, payments, outreach, content.

---

## 12. Known open questions

Recorded so they are decided deliberately rather than by accident.

| Question | Decide by |
| --- | --- |
| Numeric thresholds for soft-freeze triggers and cooling period | First Guardian implementation |
| Approval staleness — does a 6-day-old proposal need re-confirmation? | v0.2, computable from `created_at` |
| Concrete budget figures against the ₹1,000–2,000/month ceiling | Before the first paid API call |
| Where the freeze record lives — new table or agent/task columns | Guardian milestone; requires §23 justification |
| Approval queue maximum — the actual number | Approval mechanism milestone |

---

## 13. What v0.1 is for

v0.1 will not generate revenue, and that is not a failure.

Phase 1 — ₹0 to ₹5,000/month — is one or two B2B clients, reachable faster by
writing three good pitches by hand than by building any of this. The
foundation's value appears at Phase 2 and beyond, where doing it manually stops
being possible.

**v0.1's deliverable is a trustworthy machine, not revenue.** Which is the
strongest argument for keeping it small.

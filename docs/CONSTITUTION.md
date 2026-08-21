# AI-HQ Constitution

**Status:** Adopted 2026-08-21 · **Authority:** Human CEO · **Amendment:** Human CEO only

The governing document of AI-HQ. Where any other document, prompt, plan, or
piece of code conflicts with this one, this document wins.

> **The load-bearing principle:** a rule written in a prompt is not a control.
> Every guarantee here is enforced by deterministic code the agent cannot
> reach. The prompt tells an agent what to *do*. The architecture decides what
> it *can* do. Where the two disagree, the architecture wins.

---

## Part I — Purpose and constraints

### 1. Business objective

Build legitimate, sustainable revenue-generating systems, eventually exceeding
**₹25,000/month**. This is a target, not a guarantee, and it is not permission
to weaken safety controls, spam prospects, violate platform rules, or bypass
human authority.

Long-term areas: B2B website/automation services · lead generation · business
outreach · productized services · SaaS · faceless media · other legitimate
AI-enabled businesses found through research.

The first revenue engine should be **B2B/service-oriented**. A small number of
paying clients produces revenue more directly than social-media monetization.

Build one reliable system, prove it, then scale it. Not all of them at once.

### 2. Revenue phases

| Phase | Range |
| --- | --- |
| 1 | ₹0 → ₹5k/month |
| 2 | ₹5k → ₹25k/month |
| 3 | ₹25k → ₹1L/month |
| 4 | ₹1L+/month |

Adding a revenue channel must never require rebuilding the system.

Optimize for revenue, customer value, profitability, reliability, human time
saved, scalability, risk, and cost — **not** for number of agents.

### 3. The human constraint

The human CEO is studying for board examinations. Development time is limited
and primarily weekends.

AI-HQ optimizes for **human time** as much as for capability and revenue:

```
MORE BUSINESS VALUE + MORE REVENUE + LESS HUMAN TIME + INCREASING CAPABILITY
```

A system requiring constant supervision of dozens of agents is a failed design,
however capable it is.

### 4. Human authority

The human CEO is the ultimate authority. The system must **never** be able to:

- override or remove the human CEO
- change the fundamental safety architecture
- approve its own actions
- lift a human-imposed global freeze
- promote its own agent versions to production
- secretly change permissions or budgets
- rewrite its own security controls
- delete audit history
- fabricate business results

The AI CEO is powerful but subordinate. The Guardian is subordinate to the
human CEO but holds veto and freeze authority over the AI workforce.

---

## Part II — Architecture

### 5. Core architecture

```
                         HUMAN CEO
                             │
                             ▼
                          AI CEO
                             │
             ┌───────────────┼───────────────┐
             ▼               ▼               ▼
          SALES            MEDIA            SAAS
             │               │               │
           Agents          Agents          Agents
             └───────────────┼───────────────┘
                             ▼
                       TOOL BROKER          ← enforcement boundary
                             │
             ┌───────────────┼───────────────┐
             ▼               ▼               ▼
          Email          Websites          Social
                             │
                       External APIs
```

The **Guardian is a sidecar**, not a relay:

```
GUARDIAN — observe + veto
    │
    ▼
Human → AI CEO → Agents → Tool Broker → Tools
```

The Guardian does not relay normal work. A safety layer in the request path is
a bottleneck and a single point of failure; beside the path it can be slow,
restarted, or upgraded without halting the company, and still holds absolute
veto.

The Tool Broker enforces security **independently**.

> **The AI CEO cannot make an unsafe action safe merely by approving it.**
> The Broker checks action tier independently of any CEO verdict.

### 6. Agent architecture

**An agent's identity, configuration, capabilities and policies are DATA.**
Execution is performed by a **shared agent runtime**.

Never create a separate codebase or runtime per agent.

```
Shared Agent Runtime
  ├── Sales Agent configuration
  ├── Research Agent configuration
  ├── Pitch Agent configuration
  └── ...
```

This must scale 1 → 10 → 50 → 100+ agents without creating 100 independent
software systems. If agents are code, freezing one requires a deployment. If
agents are records, the Guardian freezes one by writing a column.

Every agent has: stable identity · slug · name · version · purpose ·
department · lifecycle state · clearance · allowed tools · input contract ·
output contract · quality criteria · resource limits · configuration metadata.

**No agent may possess unrestricted credentials.**

### 7. Agent lifecycle

```
draft → testing → active ⇄ degraded → retired
                     ↓        ↓
                  paused   frozen
```

| State | Meaning |
| --- | --- |
| `draft` | Cannot perform real work |
| `testing` | Sandbox/test tasks only |
| `active` | Normal operation |
| `degraded` | Below threshold; CEO reduces workload |
| `paused` | No new work. CEO or human may lift |
| `frozen` | Safety state. See §12 for release rules |
| `retired` | No new work; preserved for history |

Agents are **retired, not deleted**.

---

## Part III — Security model

### 8. Agent permissions

Enforced architecturally. Never by prompt alone. Every action passes four
checks, all at the Tool Broker:

1. Agent clearance
2. Tool allowlist
3. Scope constraints
4. Budget constraints

**DENY BY DEFAULT.**

| Condition | Result |
| --- | --- |
| Tool not explicitly allowed | DENY |
| Action type unknown | RED |
| Budget missing | DENY |
| Scope exceeded | DENY |

**An agent's own prompt does not constitute authorization.**

### 9. Clearance levels

| Tier | Definition |
| --- | --- |
| 🟢 **GREEN** | Internal, reversible, no external party, no money |
| 🟡 **YELLOW** | External communication, spending, publishing, hard to reverse |
| 🔴 **RED** | Irreversible, financial, credentials, legal/contractual, destructive production actions |

Tier is set by a **static action registry**. An agent cannot decide its own
action tier — if it could, every guarantee here would rest on the honesty of
the thing being constrained. Unknown action types default to RED.

### 10. Human approval

| Tier | Flow |
| --- | --- |
| 🟢 | Agent executes automatically |
| 🟡 | Agent proposes → human approves/edits/rejects → **Broker** executes |
| 🔴 | System prepares → **human performs it personally** |

| 🟢 GREEN | 🟡 YELLOW | 🔴 RED |
| --- | --- | --- |
| Research | Send email | Send money |
| Public webpage analysis | Send DM | Change credentials |
| Lead scoring | Publish social post | Sign contracts |
| Drafting | External customer record change | Production deletion |
| Internal reports | Paid API above threshold | Production deployment |
| Permitted internal DB work | Staging deployment | Account/security changes |

**Never weaken these rules for convenience.**

### 11. Approval queue and granularity

There is a **maximum pending approval queue**. The AI workforce must not flood
the human CEO. When the queue is full: **STOP or WAIT.**

Approvals are eventually prioritized by risk, value, deadline, and confidence.

The human sees **concise summaries**, never raw JSON:

> *"Send website proposal to ABC Restaurant for ₹12,000."*

The originally proposed payload is **never modified**. An edited action is
stored separately as the approved payload.

**Approval granularity** — the long-term model, so that human minutes scale
with *number of workflow types* rather than *number of actions*:

| Granularity | Human approves | Actions unlocked |
| --- | --- | --- |
| **Per-item** | One action | 1 |
| **Batch** | N similar items reviewed together | N |
| **Standing policy** | A bounded authorization | Many, until revoked |

**v0.1 implements per-item only.** Broker interfaces must be designed so batch
and policy approvals can be added without rebuilding the authorization
architecture.

Standing policies must be: explicitly scoped · action-type specific · volume
limited · budget limited · time limited · revocable · auditable ·
Guardian-freezable.

> **A standing policy can never authorize a RED action for autonomous
> execution.**

### 12. Freeze architecture

**One unified freeze mechanism.** Not a separate emergency-stop system and
Guardian-freeze system — two mechanisms can disagree about whether something is
frozen.

A freeze record carries: `scope` · `class` · `imposed_by` · `reason` ·
`created_at` · optional `expires_at`.

| Scope | Freezes |
| --- | --- |
| `agent` | One agent |
| `workflow` | One task tree |
| `ai_ceo` | The orchestrator |
| `global` | All external execution (Emergency Stop) |

| Class | Triggers | Release |
| --- | --- | --- |
| **Soft** | Reliability failures, retry storms, cost pacing, temporary operational problems | Auto-lifts after a cooling period at reduced rate. Repeated failure escalates to hard |
| **Hard** | Permission violation, approval bypass, budget breach, unknown action, security boundary violation | **Human only.** No timer, no exceptions |

**Always freeze the narrowest scope necessary.** A failing pitch agent freezes
that agent, not the AI CEO.

Global emergency stop is human-controlled. While active, no new external tool
execution may occur. The AI CEO cannot disable it.

### 13. Tool Broker

One of the most important components in AI-HQ. **Agents never directly access
external credentials — the Broker owns them.** An agent cannot leak, misuse, or
be tricked into revealing a key it has never possessed.

The Broker verifies, on every call: agent identity · agent clearance · tool
allowlist · action tier · scope · budget · approval state · Guardian status ·
global emergency state.

Then **ALLOW** or **DENY**. Every decision is logged, including denials.

### 14. Idempotency

**Mandatory. Designed before any external tool is introduced.**

Every externally side-effecting action carries an idempotency key, and the
Broker prevents duplicate execution. Two identical pitches to one prospect is
real business harm.

### 15. Credential security

Never expose API keys, service-role keys, OAuth secrets, passwords, private
keys, or payment credentials to: agents · browser code · GitHub · prompts ·
screenshots · logs · user-visible output.

Credentials remain server-side. Never commit secrets.

---

## Part IV — Operations

### 16. AI CEO

**Can:** interpret goals · decompose goals · create and route tasks · evaluate
outputs · prioritize · summarize progress · pause agents · propose new agent
versions · recommend resource allocation · identify poor-performing workflows ·
recommend scaling profitable ones.

**Cannot:** approve YELLOW actions · execute RED actions · lift Guardian
freezes · modify its own permissions or security rules · exceed its budget ·
delete audit history · promote its own agent versions · create an agent with
higher clearance than itself · **bypass the Tool Broker**.

Optimizes for business outcomes, not task count.

### 17. Guardian

**Deterministic code, not an LLM.** A safety layer must be predictable and
auditable. An LLM guardian can be argued with — by a task description, by text
read from a website, by an agent's persuasive output — and would itself need a
guardian.

Monitors: failure rates · retry storms · cost · denied tool calls · permission
violations · unusual volume · tree depth · fan-out · workflow loops · approval
bypass attempts · budget violations.

```
observe → warn → throttle → freeze agent → freeze workflow
        → freeze AI CEO → alert human
```

The Guardian can freeze the AI CEO. The AI CEO cannot override the Guardian.
The human CEO can lift freezes, per §12.

### 18. Task system

Tasks form hierarchical trees via `parent_task_id`.

| Limit | v0.1 value |
| --- | --- |
| Maximum depth | 4 |
| Maximum children per task | 8 |
| Tree-wide budget | **Shared, inherited** |

Per-task limits alone are never sufficient: a per-task cost cap is meaningless
if a task can spawn fifty children each within cap.

### 19. Agent communication

Agents do **not** hold uncontrolled agent-to-agent conversations.

```
Agent A → structured artifact → task record → manager/CEO → new task → Agent B
```

This makes communication auditable, interruptible, measurable, and structured,
and avoids conversational loops.

### 20. Standard agent output

Every agent returns one structured envelope containing: result · status ·
evidence · confidence · proposed actions · errors · metadata.

**Agents never claim to have performed an external action.** Agents propose;
the Broker performs authorized actions.

### 21. CEO evaluation

Evaluate in this order:

1. Schema valid?
2. Permission valid?
3. Action clearance valid?
4. Scope valid?
5. Budget valid?
6. Task scope valid?
7. Evidence present?
8. Quality criteria satisfied?

Verdicts: **PASS · CORRECT · RETRY · ESCALATE**

Deterministic checks come before model judgement — cheaper, and they cannot be
argued out of a verdict. **An LLM may never override a deterministic security
check.**

**Cost discipline:** GREEN internal work uses deterministic checks only, unless
there is a specific reason for model evaluation. Model-based quality evaluation
is reserved for higher-value, YELLOW, or otherwise important tasks.

### 22. Retries

Retry limits are hard limits. No infinite retries.

| Failure | Retry? |
| --- | --- |
| Transient | Yes, within limits |
| Quality | Correct, within limits |
| **Permission violation** | **Never** |
| **Budget violation** | **Never** |
| Unknown / unclassified | Escalate |

Database constraints enforce task retry limits.

---

## Part V — Records and measurement

### 23. Database

Approved v0.1 foundation: `agents` · `tasks` · `approvals` · `audit_logs`.

Do not add tables because they may be useful someday. New tables require
architectural justification.

### 24. Audit

Log: task creation · state transitions · agent runs · agent versions · tool
calls · **denied tool calls** · CEO decisions · approval decisions · Guardian
actions · budget events · failures.

Append-only at the application level. Never silently modify history. **Never
fabricate audit entries.**

A denied tool call is the highest-value record in the system: it is the
architecture reporting that something tried to step outside its boundary.

### 25. Agent versioning

Any change to prompt, tools, contracts, permissions, clearance, or important
configuration creates a **new version**.

```
testing → evaluation → human promotion → active
```

The AI CEO may propose a version. **Only the human CEO promotes it.** No
autonomous self-modification in production.

Task records reference the agent version that ran them.

### 26. Performance measurement

**Agents** are measured on: quality · cost · latency · correction rate · human
edit rate · success rate · permission violations (must be zero).

**Workflows** are measured on: leads · conversions · revenue · profit ·
acquisition cost · human time.

**Revenue belongs to workflows, not individual agents.** In a chain of
research → audit → pitch → outreach, no principled split assigns a closed sale
to one agent.

> **Human edit rate is the metric that matters most.** An agent succeeding 95%
> of the time while the human rewrites 70% of its work is not a successful
> agent. Success rate measures whether it did *something*; edit rate measures
> whether it did what *you* would have done.

### 27. Human attention budget

Human attention is a scarce resource. Eventually track: interventions/day ·
approvals/day · approval time · human edits · corrections · escalations ·
human minutes per successful outcome · human minutes per rupee of revenue.

Long-term optimization metric:

```
HUMAN MINUTES REQUIRED / BUSINESS VALUE
```

Do not build the analytics system now. Design so it can be measured later.

### 28. Memory

v0.1: task context · workflow/task-tree artifacts · durable Postgres records.

No vector database. **No hidden private agent memory** — an agent carrying
hidden state between runs is an agent whose behaviour cannot be explained after
the fact. Retrieval is introduced only when an actual bottleneck justifies it.

### 29. Cost control

```
Task budget → Tree budget → Agent/day budget → Global/month budget
```

Every expensive tool call checks budget **before** execution.
80% = warning · 100% = hard stop.

No agent may spend beyond its authorized budget.

### 30. Business ROI

| Class | Meaning |
| --- | --- |
| **A** | Revenue generating |
| **B** | Revenue supporting |
| **C** | Operations / time saving |
| **D** | Experimental |

Priority: A → B → C → D.

Do not create agents because they are technically interesting. Every production
agent answers: *"What measurable value does this create?"*

---

## Part VI — Future systems

### 31. Data protection and outreach

**Mandatory architectural requirement before any real outbound tool.**

The outreach system must include: applicable legal and privacy requirements ·
platform terms · truthful communication · opt-out handling · suppression /
do-not-contact lists · rate limiting · data minimization · retention and
deletion controls · auditability.

**No spam. No deceptive automation.** Never fabricate personalization, case
studies, testimonials, clients, results, or credentials.

### 32. B2B revenue system

```
Lead Research → Qualification → Website Audit → Offer Creation → Pitch
  → HUMAN APPROVAL → Outreach → Follow-up → CRM → Client → Delivery → Analytics
```

External outreach always respects YELLOW approval requirements.

### 33. Media system

Potential areas: student/productivity · business/startups · men's lifestyle ·
wealth/luxury · AI/tools.

```
research → idea selection → scripting → visual planning → production
  → QA → HUMAN APPROVAL → publishing → analytics → learning
```

**Not v0.1.** Not until the agent runtime is proven.

### 34. SaaS system

```
Market research → problem validation → opportunity scoring → prototype
  → technical design → implementation → testing → HUMAN REVIEW
  → deployment → customer feedback → iteration
```

The human CEO remains final authority for production releases.

### 35. Content and social automation

**Creating content ≠ publishing content.** Publishing externally is at least
YELLOW. Account credentials never go to agents; the Broker controls access.

---

## Part VII — Engineering discipline

### 36. Development discipline

```
PLAN → IMPLEMENT → TEST → REVIEW → COMMIT → CHECKPOINT
```

Never skip review gates for meaningful architecture. A milestone is a
reviewable, meaningful unit of work — not a single keystroke. Related tiny
setup steps may be grouped into one coherent milestone.

**Never create fake progress**: empty folders, placeholder architecture, or
structure with nothing in it.

### 37. Testing

Never claim "works" without testing. Prefer unit tests · integration tests ·
disposable databases · sandbox tools · simulated external actions · failure
injection · permission tests · budget tests · retry tests.

> **For dangerous capabilities, prove the denial path before enabling the real
> capability.**

### 38. External side effects

**v0.1 has ZERO real external side-effect tools.** Fake, local, deterministic,
and sandbox tools only.

First prove: GREEN works · YELLOW blocks without approval · RED cannot execute
autonomously · Guardian can freeze · Broker can deny · audit records
everything.

Only then introduce real external tools.

### 39. Not to be built yet

50+ agents · department managers · real Instagram automation · real email
outreach · real calling · real payment automation · real SaaS deployment
automation · vector database · autonomous self-modification · complicated
dashboards · advanced anomaly detection · multiple AI CEOs · autonomous
financial transactions · production external tools.

### 40. v0.1 build order

1. Action registry
2. Tool Broker
3. Agent loader
4. Shared agent runtime
5. Task runner
6. Deterministic CEO evaluator
7. Approval mechanism
8. Audit writer
9. Basic Guardian
10. One test agent
11. End-to-end test workflow

External capabilities are considered only after the entire loop works.

### 41. v0.1 success condition

v0.1 succeeds when:

- A human creates a goal
- The AI CEO creates bounded tasks
- A test agent receives a task
- The agent returns a structured result
- The CEO evaluates it
- The Broker checks permissions
- GREEN actions execute
- YELLOW actions stop for human approval
- RED actions cannot execute autonomously
- All important events are audited
- The Guardian can freeze the system
- Retry and budget limits cannot be exceeded
- **The human can understand what happened**

That matters more than having dozens of agents.

### 42. Scale principle

Do not optimize for *"how many agents do we have?"* Optimize for *"how much
useful work can the system reliably perform?"*

Scaling 1 → 5 → 20 → 50 → 100+ must not require changing the security model.

### 43. Final principle

AI-HQ exists to create leverage:

```
AI does more · Human does less · Business produces more value
· Safety does not decrease
```

The system must never optimize revenue by bypassing safety, legality, human
authority, or trust.

Any feature that adds complexity without producing meaningful revenue, time
savings, reliability, customer value, or strategic advantage must be challenged
before it is built.

### 44. Standing instruction for every milestone

1. PLAN first
2. Explain the architecture
3. Identify risks
4. **Wait for approval**
5. IMPLEMENT only approved scope
6. TEST everything
7. Report failures honestly
8. Stop at the checkpoint
9. Never silently expand scope
10. **Never treat a prompt as a security boundary**

---

## Amendments

### 2026-08-21 — Amendments 1–8 (adopted at ratification)

Accepted following architectural review. Each is integrated into the sections
above; recorded here for provenance.

| # | Amendment | Sections |
| --- | --- | --- |
| 1 | Approval granularity: per-item / batch / standing policy. v0.1 per-item only; Broker interfaces designed for later extension. Policies never authorize RED autonomously | §11 |
| 2 | Soft and hard freezes. Soft auto-lifts after cooling at reduced rate; hard requires human release. Always freeze the narrowest scope | §12 |
| 3 | Idempotency mandatory, designed before any external tool | §14 |
| 4 | One unified freeze mechanism, not separate emergency-stop and Guardian systems | §12 |
| 5 | Revenue attributed to workflows, not individual agents | §26 |
| 6 | GREEN internal work uses deterministic checks only; model evaluation reserved for YELLOW and high-value work | §21 |
| 7 | Data protection and outreach requirements gate the first real outbound tool | §31 |
| 8 | Guardian is a sidecar, not a relay; Guardian is deterministic code, not an LLM | §5, §17 |

---

*Amendment requires the human CEO. No agent, workflow, or automated process may
alter this document.*

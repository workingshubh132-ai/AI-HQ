# AI-HQ CEO / Executive Orchestrator

The CEO turns a high-level goal into governed executable work. It is not a
chatbot and not a privileged supervisor — it is the component with the
**least authority in the system**, whose only power is to *request* work
that the existing governance then decides on.

Added in Milestone 24. **No existing file was modified**: `broker.js`,
`router.js`, `workflow.js`, `runtime.js`, `guardian.js`,
`approval-engine.js`, `execution-coordinator.js`, and `validator.js` are
byte-for-byte untouched and contain no CEO-specific branch.

## 1. What runs, end to end

```
GOAL  "Create a complete short-form video package about India's UPI growth."
  ↓
plan          (src/ceo/planner.js)      deterministic; executes nothing
  ↓
discover      listAvailableSpecialists  (M23, read-only)
  ↓
propose       coordinator.proposeTask   → router selects BY CAPABILITY
  ↓
execute       runtime.runTask           → provider → artifact-service → audit
  ↓
monitor       real task records
  ↓
recover       (src/ceo/recovery.js)     bounded; request-or-stop only
  ↓
evaluate      (src/ceo/completion.js)   deterministic structural checks
  ↓
EXECUTIVE REPORT
```

A real run of the goal above selects all twelve M23 content-factory
specialists by capability, executes twelve tasks, produces thirteen
artifacts (including the final `CONTENT_PACKAGE`), reaches
`completion_status: COMPLETE`, and spends 13 of its 64-decision budget.

## 2. The CEO has no special authorization

| It can | It cannot |
|---|---|
| Plan a goal into stages | Execute a tool (`allowed_tools: []`, clearance GREEN — Broker returns DENY) |
| Ask the router for a specialist | Name or force a specialist |
| Propose tasks through the coordinator | Insert a task into storage, or bypass workflow admission |
| Read workflow/task/artifact/budget state | Mutate any of it |
| **Request** an approval | Approve anything — it never holds `decide()`/`revoke()` |
| Observe a freeze and stop | Impose or lift a freeze |
| Report a budget failure | Raise a budget |

Three structural guarantees, each mutation-tested:

1. **Read-only store facade** — `readOnlyStore()` exposes only
   `getAgent`/`listAgents`/`getTask`/`activeFreeze`/`budgetsFor`. The
   CEO's logic holds the facade, never the store, so mutation methods are
   absent from the object it actually has.
2. **`requestApproval` is a bare function**, never the Approval Engine —
   `decide()` and `revoke()` are not reachable from any CEO file.
3. **`RECOVERY_ACTION` contains no bypass** — the recovery policy can only
   return "ask again, differently" or "stop." There is no `UNFREEZE`,
   `OVERRIDE`, `FORCE`, or `SELF_APPROVE` to return.

## 3. The CEO is itself governed

`ceoGovernanceCheck()` re-reads the CEO's own agent record from the real
store **before every decision cycle** — never cached — and halts on:

- CEO not registered / version not approved / lifecycle not active
- an agent freeze on the CEO
- a global freeze
- a freeze on the workflow it is running

A frozen CEO orchestrates nothing. A freeze imposed *mid-run* stops the
next stage while every already-created artifact survives untouched.

## 4. Planning

Plan templates are **data**. Each stage declares:

| Field | Meaning |
|---|---|
| `stage_id` | stable name; also its key in the stage summary |
| `required_capability` | what the router must find an agent for — **never a slug** |
| `depends_on` | stage_ids that must complete first |
| `expected_artifact_type` | what completion evaluation looks for |
| `output_artifact_field` | which result field carries the produced artifact_id |
| `input_binding` | declaratively: goal field, upstream stage output, or stage summary |

Goal parsing (`parseGoal`) is **deterministic string matching** — literal
keywords select a template, `about X` / `on X` lifts a topic. It is not
semantic comprehension, and an unparseable goal yields
`MALFORMED_GOAL`/`NO_TEMPLATE_FOR_GOAL`, never a guess.

If a required capability has no eligible specialist, planning fails with
`CAPABILITY_UNAVAILABLE` naming exactly what is missing. **Nothing is
ever substituted.**

## 5. Recovery policy

| Failure | Action |
|---|---|
| `HANDLER_ERROR` | `RETRY_STAGE` — a fresh proposal through the full gauntlet, while under the ceiling |
| `AGENT_FROZEN` | `REROUTE_STAGE` — ask the router again; the freeze is untouched |
| `NO_ELIGIBLE_AGENT`, `AGENT_NOT_ACTIVE`, capability/workflow-type mismatch | `STOP_BLOCKED` |
| any budget failure | `STOP_BUDGET` — never a request to raise it |
| `NEEDS_APPROVAL` | `REQUEST_APPROVAL` — a human decides |
| `GLOBAL_FREEZE`, `WORKFLOW_FROZEN` | `STOP_FROZEN`, unconditionally |
| over the per-stage ceiling | `STOP_LIMIT` |
| anything unrecognised | `STOP_UNRECOVERABLE` — fail closed |

## 6. Limits

| Limit | Value | Bounds |
|---|---|---|
| `MAX_PLANNING_ITERATIONS` | 3 | planning passes |
| `MAX_RECOVERY_ATTEMPTS_PER_STAGE` | 2 | recovery per stage |
| `MAX_REPLAN_CYCLES` | 1 | full replans |
| `MAX_CEO_DECISIONS_PER_WORKFLOW` | 64 | **every** CEO decision, combined |

The aggregate budget is the backstop: no combination of the others can
compose into an unbounded run. All are frozen source constants — nothing
the CEO reads at runtime can raise them.

## 7. The executive report

Contains: goal, workflow_id, plan, agents used, tasks executed, artifacts
produced, failures, retries, Guardian interventions, approvals, resource
usage (real budget rows + CEO decisions spent), completion status with
findings, workflow state, and an explicit `limitations` list. It is swept
in tests for anything credential-shaped.

## 8. Real vs synthetic vs gated

- **REAL** — orchestration, capability-based routing, workflow admission,
  runtime execution, artifact creation with provenance and checksums,
  audit, Guardian enforcement, budget accounting, completion checks.
- **SYNTHETIC** — all generated content, from M21's deterministic fixture
  providers. Never real AI output, and never described as such.
- **GATED** — real AI providers, real publishing, real business
  communication, real credentials. None connected.

The CEO never names a provider. Replacing a deterministic provider with
Groq later is a provider-layer change requiring **no CEO governance
change**.

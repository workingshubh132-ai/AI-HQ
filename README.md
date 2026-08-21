# AI-HQ

An AI-operated business operating system. The human founder is the CEO and
holds final authority over every decision the system makes.

> **Status: v0.1 — Milestone 4.6. A deterministic security core.**
>
> The current system is a deterministic security core. It does **not** yet
> contain a production runtime, external tools, model calls, persistent
> execution, or autonomous agents.
>
> Put plainly: **it can refuse things. It cannot yet do anything.**
> That is deliberate — the denial paths are proven before anything is
> allowed to act.

---

## What this will become

A layered system where AI agents do repetitive work and a human approves
anything that touches the outside world:

```
HUMAN CEO          final authority
    ↓
GUARDIAN           safety and oversight
    ↓
AI CEO             breaks goals into tasks, assigns them
    ↓
DEPARTMENTS        sales, websites, media, SaaS, support
    ↓
AGENTS             individual specialists
    ↓
DATABASE           memory and audit trail
```

Anything affecting money, external people, publishing, or production goes
through a human approval queue first. That rule is not optional.

Anything affecting money, external people, publishing, or production goes
through a human approval queue first, and the human approves the exact
executable payload — never an agent's description of it.

## What actually exists today

| Component | Status |
| --- | --- |
| Action Registry — action → risk tier, static, unknown → RED | ✅ Implemented, tested |
| Tool Registry — 4 **fake** tools, no real ones | ✅ Implemented, tested |
| Tool Broker — the security boundary, 14 ordered checks | ✅ Implemented, tested |
| Approval integrity — payload hash + description binding | ✅ Implemented, tested |
| Budgets, scopes, clearance, freezes, idempotency | ✅ Implemented, tested |
| Audit sink — append-only | ✅ Implemented, tested (in memory) |
| Database migrations | 📝 Written, verified on a throwaway database, **never run for real** |
| Agent runtime, task runner, AI CEO, Guardian, routing | ❌ **Documented only. No code.** |
| Model calls, external tools, network access, credentials | ❌ **None. By design.** |
| Persistence | ❌ In-memory only. Process exit loses everything |

**73 tests, zero dependencies, zero network capability.**

See [`docs/DECISIONS.md`](docs/DECISIONS.md) for why things are built this
way, [`docs/CONSTITUTION.md`](docs/CONSTITUTION.md) for the governing rules,
and [`docs/OPERATING_MODEL.md`](docs/OPERATING_MODEL.md) for how the
machinery works.

---

## How the machines fit together

```
Claude cloud container  →  GitHub  →  Founder's laptop
   (temporary)          (backup)      (development)
                            ↓
                        Supabase
                        (database)
```

**GitHub is the backup.** The cloud container is erased after every
session — work that is not pushed does not exist.

---

## Setup on your development laptop

You need these installed first:

| Tool | Why | Where |
| --- | --- | --- |
| **Node.js** (version 20 or newer) | Runs the project | <https://nodejs.org> — choose the **LTS** version |
| **Git** | Downloads and uploads code | <https://git-scm.com/downloads> |
| **VS Code** | Reading and editing the code | <https://code.visualstudio.com> |

After installing, **close your terminal and open a new one**, or the
commands below will not be found.

### Steps

**1. Download the project**

```
git clone https://github.com/workingshubh132-ai/AI-HQ.git
cd AI-HQ
```

**2. Create your private settings file**

```
cp .env.example .env
```

This copies the example file to `.env`, which is where your real keys will
go. `.env` is blocked from GitHub by `.gitignore` and must stay that way.

*(`cp` works in Windows PowerShell as well as on macOS and Linux.)*

**3. Confirm it works**

```
npm run check
```

Expected output:

```
AI-HQ environment check

  OK    Node.js 22.22.2
  OK    .env file found

Ready.
```

If you see `FAIL`, the line underneath tells you how to fix it.
`WARN` about a missing `.env` just means step 2 was skipped.

There is no `npm install` step — the project has no dependencies.

**4. Run the test suite**

```
npm test
```

Expected: **73 tests, 73 passing.** These are the security tests. Every
denial test asserts not only that the Broker said no, but that nothing
executed — empty outbox, zero handler invocations.

---

## Project layout

```
AI-HQ/
├── src/                       the security core
│   ├── actions.js             action → risk tier. Static. Unknown → RED
│   ├── tools.js               tool registry. Four FAKE handlers only
│   ├── broker.js              the Tool Broker — every check lives here
│   ├── payload.js             payload hashing and deterministic rendering
│   ├── store.js               in-memory state (agents, approvals, budgets…)
│   └── audit.js               append-only audit sink
├── tests/                     73 tests, mostly security
│   ├── deny.test.js           every denial path
│   ├── approval-integrity.test.js   consent bound to executed bytes
│   ├── allow.test.js          positive path, idempotency, budgets
│   ├── audit.test.js          auditability
│   ├── registry.test.js       structural invariants
│   └── fixtures.js            shared test setup
├── supabase/migrations/       schema. Written, never run for real
├── docs/
│   ├── CONSTITUTION.md        the governing rules
│   ├── OPERATING_MODEL.md     how the machinery works
│   └── DECISIONS.md           why each choice was made
├── scripts/check-env.mjs      confirms this computer can run the project
├── .env.example               template for settings (safe, committed)
├── .gitignore                 what must never be uploaded
└── package.json               project definition. Zero dependencies
```

Folders are added when something needs to go in them, not before.

## What is deliberately not built

No agent runtime · no AI CEO · no Guardian · no routing · no task trees ·
no scheduling · no model calls · no external tools · no network access ·
no credentials · no Supabase connection · no persistence · no dashboard.

Each of those is designed in `docs/`, and none of it is code. **Nothing in
this repository is described as implemented unless it has a passing test.**

---

## Safety rules

1. **Never commit `.env`.** It holds real keys. `.gitignore` blocks it —
   do not override that.
2. **Never paste a key directly into a code file.** Read it from `.env`.
3. **Never put the Supabase service-role key in dashboard or browser
   code.** It is an admin key that ignores all database security rules.
4. **If a key is ever exposed, replace it** rather than deleting the file.
   Anything pushed to GitHub stays in the history.

---

## Working rhythm

Every change follows: **plan → build → test → review → commit.**

Milestones stay small enough to review in one sitting. Nothing is
described as working unless it has actually been run.

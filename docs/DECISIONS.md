# Architecture Decisions

A running record of choices made and why. Read this first after a break —
it is here so we never re-argue a settled question, and so a decision can
be reversed deliberately rather than by accident.

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

## Deliberately deferred

Not decided yet, and not needed yet. Listed so they are not forgotten.

| Question | Decide when |
| --- | --- |
| Split into `packages/` and `apps/` (npm workspaces) | A second package actually exists |
| TypeScript configuration | The first real code is written |
| Dashboard framework | The dashboard is started |
| Deployment host | There is something worth hosting |
| Supabase free-tier inactivity pausing | Setting up Supabase (next milestone) |

Empty folders are not created ahead of need. Git cannot store an empty
folder, and structure with nothing in it is a guess about the future
dressed up as a plan.

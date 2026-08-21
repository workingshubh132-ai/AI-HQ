# AI-HQ

An AI-operated business operating system. The human founder is the CEO and
holds final authority over every decision the system makes.

> **Status: v0.1 — project skeleton.**
> There is no application yet. This repository currently holds configuration
> and documentation only. The one thing that runs is an environment check.

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

None of the above is built yet. See [`docs/DECISIONS.md`](docs/DECISIONS.md)
for choices made so far.

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

There is no `npm install` step yet — the project has no dependencies.

---

## Project layout

```
AI-HQ/
├── docs/
│   └── DECISIONS.md      why things are built the way they are
├── scripts/
│   └── check-env.mjs     confirms this computer can run the project
├── .env.example          template for settings (safe, committed)
├── .env                  your real settings (private, never committed)
├── .gitignore            what must never be uploaded
├── package.json          project definition
└── README.md             this file
```

Folders are added when something needs to go in them, not before.

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

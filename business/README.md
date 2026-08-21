# AI-HQ Business Layer

**This is not AI-HQ production architecture.** Nothing here touches
`src/`, `tests/`, `supabase/`, or the security core. This folder holds the
templates, trackers, and scripts a human uses to run Experiment 001 by
hand — Google searches, walk-ins, a notebook, a spreadsheet.

Governed by [`docs/EXPERIMENT-001.md`](../docs/EXPERIMENT-001.md), which
remains the source of truth for objectives, qualification criteria,
outcome states, and the data integrity rule. This folder does not repeat
that reasoning — it operationalizes it into things you fill in.

**Nothing in this folder automates outreach, research, or delivery.**
There is no script that fetches a URL or sends a message. Every file here
is either a template a human fills in, or a spreadsheet a human updates by
hand. If that ever changes — if research or outreach becomes automated —
that is an AI-HQ architecture change, not a business-layer one, and it
goes through the frozen security core, not this folder.

## The funnel

```
PROSPECT → QUALIFY → AUDIT → OFFER → PROPOSAL → DELIVERY → PAYMENT → TRACKING
```

| Stage | File |
|---|---|
| Prospect | `prospects/tracker.csv` |
| Qualify | `prospects/qualification-checklist.md` |
| Audit | `audit/audit-template.md` (worked example: `audit/demo-audit-EXAMPLE.md`) |
| Offer | `offer/offer-definitions.md` |
| Proposal / outreach | `outreach/walkin-script.md`, `outreach/email-template.md`, `outreach/objection-handling.md` |
| Delivery | `delivery/delivery-sop.md` |
| Payment / tracking | `economics/unit-economics-tracker.csv` |

## Day 1 — how to actually use this

1. Open `prospects/tracker.csv` in a spreadsheet app.
2. Pick 5 prospects for the H1 vertical from `EXPERIMENT-001.md` §2–4.
   Qualify each with `prospects/qualification-checklist.md` before adding
   them to the tracker — do not add a prospect you haven't qualified.
3. For each qualified prospect, fill in `audit/audit-template.md` — this
   is the document you hand over. Use `demo-audit-EXAMPLE.md` as a
   reference for what "done" looks like; it uses a fictional business, not
   a real one.
4. Rewrite `outreach/walkin-script.md` or `email-template.md` in your own
   words before using it. A message that sounds like a template is worse
   than no message — see the DRAFT warning in each file.
5. Approach the 5. Record every outcome in the tracker, using the exact
   outcome states from `EXPERIMENT-001.md` §8. Record objections verbatim.
6. Before the next 5: read what happened, adjust the audit and the
   opening line, then continue.
7. If anyone pays, follow `delivery/delivery-sop.md` and log hours and
   cost in `economics/unit-economics-tracker.csv` — real delivery cost is
   as valuable as the sale itself, per `EXPERIMENT-001.md` §13.
8. After each batch of 5, append an entry to the Decision Log in
   `EXPERIMENT-001.md` §16 — not here. That file is the durable record;
   this folder is the working set.

## What NOT to do with this folder

- Do not fabricate a prospect, an objection, or an outcome to fill a gap.
  An empty cell is data; a guessed cell is contamination (`EXPERIMENT-001.md` §14).
- Do not send anything automatically. You are the sender.
- Do not add a script that searches, scrapes, or contacts anyone. That is
  automation, and automation is gated behind evidence and the frozen
  security core, not behind convenience.
- Do not vary the ₹8,000 anchor price across the first 20 prospects
  (`EXPERIMENT-001.md` §9).

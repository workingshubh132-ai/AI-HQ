# Delivery SOP — O1 (Audit → Fixed-Price Fix)

Runs after a prospect says yes. The point of tracking this precisely: the
first-automation gate in `docs/EXPERIMENT-001.md` §12 needs a real,
measured, step-by-step delivery process — not a guess — to identify which
step is disproportionately slow.

**Start a stopwatch (or note start time) at step 1 of every job. Log
total hours in `economics/unit-economics-tracker.csv` when done — this
is not optional, it's the actual data the automation decision depends
on.**

## Steps

1. **Confirm scope in writing.** Even a WhatsApp message restating what
   was agreed (after they've engaged — see `docs/EXPERIMENT-001.md` §6 on
   why this isn't a first-contact channel). Avoids disputes later.
2. **Take payment, or the agreed portion.** See the payment note below.
3. **Gather access.** Google Business Profile login, website CMS login if
   applicable, any existing brand assets.
4. **Do the work**, scoped exactly to what was agreed in
   `offer/offer-definitions.md` — no silent scope expansion.
5. **Review before handoff.** Check every fix against the audit's "What
   I'd fix" list — nothing more, nothing less than what was promised.
6. **Deliver and confirm.** Show the client the specific before/after for
   each item. Ask if it matches what they expected.
7. **Log the job.** Fill in `economics/unit-economics-tracker.csv`: hours
   actually spent (broken down by step if a step stood out as slow),
   direct costs, final price, and any deviation from the standard scope.
8. **Note anything that recurred.** Did they ask about ongoing
   management? A monthly check-in? Record it — this is the signal
   `EXPERIMENT-001.md` §13 asks you to listen for.

## Payment

No payment gateway or automated invoicing exists in this project, and
none should be built without a separate, explicit decision — this is
outside AI-HQ's frozen security core, not inside it.

For now: UPI, in person or via a shared payment link, confirmed manually
by you. See the open question raised earlier in this project about how
payment reaches you cleanly — resolve that before the first real
transaction, not during it.

## If delivery reveals a step that's clearly the bottleneck

Note it explicitly in the tracker under `notes`, e.g. "the Google Business
Profile photo sourcing/upload took 2 of the 3 total hours." This is
exactly the observation the six-condition automation gate
(`docs/EXPERIMENT-001.md` §12) is watching for. Do not act on one
instance — the gate requires the same step to recur across at least 3
paid jobs before it becomes an automation candidate.

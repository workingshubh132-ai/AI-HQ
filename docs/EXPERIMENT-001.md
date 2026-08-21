# Experiment 001 — Phase 1 Market Validation

**Status:** Not started. Zero prospects contacted.
**Type:** Business experiment record. **Not architecture. Not code.**
**Governed by:** [`CONSTITUTION.md`](CONSTITUTION.md) §7 (human attention),
§28–30 (economic principles). This document does not amend the Constitution.

This file exists so the experiment survives session and container loss. The
Claude container running this project is erased between sessions; this
repository, via GitHub, is not. Everything here is designed to be read cold
after a break of any length.

---

## 1. Objective

**Primary objective:** obtain real market evidence for the first AI-HQ
workflow.

**Immediate target:** 3 genuine conversations with decision-makers.

**Hard validation:** at least one real payment.

**Explicit statement of what this experiment cannot do:** 20 prospects
cannot establish a conversion rate, an optimal price, or a market size. At
realistic reply rates for personalized outreach, 20 prospects produce
roughly 1–3 replies — a set of individual data points, not a sample. Any
conclusion about "X% convert" or "the right price is ₹Y" drawn from this
round is not supported by the data and must not be treated as fact.

What this experiment *can* establish: whether the problem framing lands,
what objections actually surface in a real conversation, whether the
segment is reachable at all, and whether a decision-maker will give a
stranger ten minutes.

---

## 2. Customer hypotheses

### H1 — Primary test

Local, owner-operated service businesses that depend on being found online.

Examples: dental clinics, physiotherapy clinics, diagnostic labs, coaching
centres, gyms, salons, boutique local services.

Characteristics: 1–3 locations, owner is the decision-maker, owner is
physically reachable, the problem (being hard to find) is verifiable from a
phone in a few minutes without fabrication.

### H2 — Secondary probe

Small web/marketing agencies and freelancers who already buy this category
of work and might outsource overflow.

H1 and H2 differ in segment, channel, and price expectation. A signal from
one is informative about the absence of a signal in the other.

---

## 3. Offer hypotheses

### O1 — Digital front-door audit → fixed-price fix (for H1)

A free, specific, evidenced audit of the business's online presence,
followed by a fixed-price offer to fix what the audit found.

**Initial price hypothesis: ₹8,000.** Not proven. A hypothesis to be tested,
not anchored as fact.

### O2 — Overflow web delivery (for H2)

Taking one small build off an agency's plate this week, fixed price, they
keep the client relationship.

---

## 4. Prospect qualification criteria

A prospect qualifies **only** when at least two of the following are
objectively true and documented with evidence:

- Poor or absent ranking for the obvious "[service] in [area]" search
- Missing website, or one that visibly fails on mobile
- Google Business Profile missing hours, photos, or has very few reviews
- Contact path is broken (dead form, wrong number, unmonitored inbox)
- Business information is inconsistent across Google / Justdial / Instagram
- Social presence appears stale (e.g. no posts in 3+ months) despite the
  business apparently still operating

**Never fabricate a defect.** If a real defect cannot be found and
evidenced, the prospect is dropped, not stretched to fit.

**Explicitly excluded:** chains and franchises (no local decision-maker),
businesses that already look well-optimized (no verifiable pain), any
business where a decision-maker cannot be identified.

---

## 5. Experiment design

**20 total prospects: 15 for H1, 5 for H2.** Not split evenly — H1 is the
real test, H2 is a cheap probe on a different axis.

**H1: one city, one vertical.** Not a mix of business types. A single
vertical means research shortcuts, objections, and pitch improvements
compound across attempts instead of resetting each time.

**Sequential execution, in batches of 5:**

```
5 prospects → observe reactions → adjust approach → next 5 → repeat
```

Do not send or approach all 20 at once. A batch sent before the pitch has
been improved by real reactions wastes the remaining prospects on a version
of the pitch already known to be weaker.

---

## 6. Channel

**Preferred H1 channel: local walk-in, where realistically possible.**
Cold email to Indian local businesses is a low-yield playbook — owners
often don't monitor the email address on file, which may belong to a web
designer from years earlier. Walk-in carries no platform risk and produces
real conversations, which email does not.

**Fallback: email**, only if walk-in is genuinely not feasible (wrong city,
no time, not comfortable).

**Explicitly not used:**

- **Unsolicited WhatsApp outreach.** Cold business messaging on WhatsApp
  risks violating its Business Messaging Policy and the number used, and is
  the kind of unauthorized communication the Constitution (§31) already
  prohibits. WhatsApp is usable only *after* a prospect engages, or if they
  themselves publish a WhatsApp contact inviting it.
- **Automated outreach of any kind.** The human is the sender and the
  decision-maker for every message. Nothing in this repository sends
  anything, and nothing should.
- **Cold calling** is not recommended as a default channel; India's
  commercial-communication rules for unsolicited business calls are not
  clearly settled for this use case.

---

## 7. Audit method — per-prospect record

For every prospect, record:

| Field | Notes |
|---|---|
| Business | Name |
| Vertical | Must match the vertical chosen for this round |
| Location | Area / city |
| URL | Website, if any |
| Evidence of problem | The specific, verifiable defect(s) found |
| Screenshot/reference | Where available |
| Exact search performed | E.g. `"dentist in [area]"` — must be reproducible |
| Competitor observed | Who outranks them, if relevant |
| Contact method | Walk-in / email / other |
| Decision-maker identified | Name/role if known, or "owner, unconfirmed" |
| Outcome | One of the states in §8 |
| Objection | Category |
| Objection (verbatim) | Their actual words, not a paraphrase — a summary discards the information that distinguishes "a previous freelancer disappeared on us" from "it's too expensive," both of which collapse to the same category otherwise |
| Next action | What happens next for this prospect, if anything |

A companion spreadsheet may hold this data day to day; this document is the
durable specification of what that spreadsheet must capture.

---

## 8. Outcome states

Use exactly these, no others:

```
NO_RESPONSE · NOT_INTERESTED · WRONG_PERSON · PRICE_OBJECTION · TIMING ·
INTERESTED · MEETING · NEGOTIATING · PAID · LOST · OTHER
```

**Never convert an unknown outcome into a guessed category.** If genuinely
uncertain, use `OTHER` with a note — never force a fit.

---

## 9. Pricing

**Initial anchor: ₹8,000** for the O1 fix.

Do not vary this price across the first 20 prospects. With 1–3 expected
replies, price variation across such a small set is unmeasurable noise and
also inconsistent quoting within one locality travels.

Record, for every prospect who discusses price:

- The price they reacted to (₹8,000, unless scope was reduced — see below)
- Their reaction, in their own words where possible
- **Their own stated expected price**, if they offer one — this is
  independently valuable and must be recorded even if no deal results
- **Do not automatically discount.** If scope must be reduced to reach
  agreement, record the *reduced scope* as a separate line, not as a
  discount on the original offer.

---

## 10. Success interpretation

| Result after ~20 prospects | Reading |
|---|---|
| ≥3 conversations **and** ≥1 payment | Strong evidence — the offer works |
| ≥3 conversations **and** 0 payments | Pitch opens doors; offer or price needs work |
| 1–2 conversations | Insufficient signal — not zero, not enough to conclude |
| 0 conversations | Investigate channel or segment, not the offer |

**Do not overfit conclusions to 20 prospects.** A single payment is hard
validation. A single rejection is not proof the offer fails. Both are one
data point each.

---

## 11. Pivot signals — record explicitly if observed

- Multiple owners state that referrals or walk-ins are their dominant
  acquisition channel (may mean the offered problem isn't their real one)
- Prospects repeatedly ask for something not in O1 or O2 — that request may
  be the real business
- Delivery takes substantially longer than expected (economics may not
  work at the anchor price)
- H2 materially outperforms H1 (the real customer may be agencies, not
  local businesses)
- Repeated price objections at the same anchor
- Verbal agreement is reached but payment does not follow
- A recurring need surfaces repeatedly (this is a stronger signal than a
  one-off sale — see §13)

---

## 12. First automation gate

**All six conditions must be true before the first AI-HQ agent is built.**
Not five.

1. At least 3 customers have paid for substantially the same offer
2. Delivery follows substantially repeatable steps
3. One step consumes disproportionate time relative to the rest
4. That step is sufficiently rule-shaped — not a judgement call a human
   would want to override
5. Automating it has a plausible payback within roughly 10 uses
6. Automation can operate entirely within already-approved permissions
   (GREEN clearance, no new tool, no new tier)

**The first agent must be selected from evidence, not architectural
preference.** The decision rule for this project is:

```
CUSTOMER PROBLEM → REPEATED WORKFLOW → PAID OFFER → MEASURED DELIVERY COST
  → REPETITIVE BOTTLENECK → AUTOMATION CANDIDATE → AGENT
```

not:

```
ARCHITECTURE → AGENT → FIND A USE
```

---

## 13. Economic objective

The long-term goal is **₹1,00,000/month**. The path to it is **not
currently known** and must not be assumed.

This experiment exists to discover, with real evidence rather than
projection:

- Who actually pays
- What they pay for
- How much they pay
- What delivery actually costs, in hours and in money
- What recurs (a recurring need is worth more than a one-off sale — see
  the unit-economics note below)
- What, if anything, is worth automating

**Unit-economics note, recorded as reasoning rather than as a conclusion:**
at a ₹8,000 one-off price, reaching ₹1,00,000/month requires roughly 13 new
paying customers every month, indefinitely — a volume that does not fit a
solo operator studying for board exams. A recurring component (retainer,
subscription, ongoing service) is likely necessary for the ₹1L target to be
reachable at all. This experiment should therefore listen for what recurs,
not only for what sells once.

---

## 14. Data integrity rule

This experiment is evidence collection. It has no value as anything else.

**Never fabricate:**

- Prospects
- Conversations
- Objections
- Payments
- Conversion rates
- Pricing data
- Customer feedback

**If a field is unknown, it stays unknown.** An empty cell is data. A
guessed cell is contamination that corrupts every decision made from it
afterward.

---

## 15. Technical baseline at time of writing

Recorded so this document is legible without cross-referencing commit
history.

```
HEAD:                 eedbca3
Tests:                116/116 passing
Architecture:          FROZEN — Milestone 5 is the current baseline
Milestone 5.1:         Not started
Model calls:           None
External tools:        None
Network access:        None
Credentials:           None
Persistence:           None (in-memory only; migrations written, never run)
Production changes
  during this
  experiment:          None — this experiment does not touch src/, tests/,
                        package.json, or supabase/
```

No code changes are anticipated during this experiment. If a genuine
security defect is discovered, it is handled separately, on its own merits,
outside this document.

---

## 16. Decision log

Real observations only, appended as they occur. Each entry:

```
Date:
Prospect/segment:
Observed fact:
Verbatim customer statement (if applicable):
Interpretation:
Confidence:            (low / medium / high)
Decision/action:
```

**No entries yet. This experiment has not started. Zero prospects have
been contacted.**

<!-- Append new entries below this line, oldest first. Do not edit or
     delete a prior entry — if an earlier interpretation turns out to be
     wrong, add a new entry correcting it rather than rewriting history. -->

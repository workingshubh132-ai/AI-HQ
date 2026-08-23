/**
 * LIVE CALL BUDGET (Milestone 27)
 *
 * The "exactly one paid call" promise, as a pure function.
 *
 * ── WHY THIS IS A MODULE AND NOT A FEW LINES IN THE SCRIPT ───────────────
 *
 * It began as an inline check inside `scripts/live-groq-smoke.mjs`. M27's
 * mutation testing then disabled that check outright — `if (false && ...)`
 * — and NOTHING failed. The only tests covering it asserted on the
 * script's SOURCE TEXT (that the strings were present, in the right
 * order), because a script that runs `main()` on import cannot be unit
 * tested. A test that checks where code is written rather than what it
 * does cannot detect code that has stopped working.
 *
 * This is the same lesson M26 learned from its own unreachable-guard
 * finding, applied one level up: if an invariant matters, make it
 * reachable by a test. So the invariant moved here, where its BEHAVIOR is
 * verifiable, and the script calls it.
 *
 * ── WHAT IT PROTECTS ─────────────────────────────────────────────────────
 *
 * A live provider run is allowed exactly one request and exactly one
 * attempt. Two independent counters must agree on that:
 *
 *   `networkCalls` — what the wire actually saw, counted by wrapping
 *                    fetch. This is the number that corresponds to money.
 *   `attempts`     — what the governed invoker believes it did.
 *
 * They are checked SEPARATELY and deliberately. If they ever disagree,
 * that disagreement is itself the finding: it means a retry happened
 * somewhere the invoker did not account for, or a request was issued
 * outside the governed path.
 *
 * This function holds no authority. It counts, compares, and reports. It
 * cannot stop a call — by the time it runs, the money is already spent —
 * so its job is to make sure an overspend can never be reported as a
 * clean run.
 *
 * Constitution: sections 13, 18, 22.
 */

/** The only number of live requests a smoke activation may make. */
export const MAX_LIVE_REQUESTS = 1;

export const CALL_BUDGET_VIOLATION = Object.freeze({
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
  COUNTER_DISAGREEMENT: 'COUNTER_DISAGREEMENT',
  UNCOUNTED: 'UNCOUNTED',
});

/**
 * @param {object} observed
 * @param {number} observed.networkCalls  real requests seen on the wire
 * @param {number|null} [observed.attempts]  the invoker's own count, or
 *   null when it did not report one (a denial before invocation)
 * @returns {{ok:boolean, violations:Array<{code:string, detail:string}>}}
 *   Never throws. `ok: false` means the run must NOT be reported as valid.
 */
export function verifyCallBudget({ networkCalls, attempts = null } = {}) {
  const violations = [];

  // An uncounted run is a failed run. A missing or non-numeric counter
  // cannot be read as "zero calls" — it means the wrapper that counts
  // money was not in place, which is strictly worse than a known
  // overspend because it is invisible.
  if (!Number.isInteger(networkCalls) || networkCalls < 0) {
    violations.push({
      code: CALL_BUDGET_VIOLATION.UNCOUNTED,
      detail: 'network requests were not counted — the run cannot be verified',
    });
    return Object.freeze({ ok: false, violations: Object.freeze(violations) });
  }

  if (networkCalls !== MAX_LIVE_REQUESTS) {
    violations.push({
      code: CALL_BUDGET_VIOLATION.TOO_MANY_REQUESTS,
      detail: `expected exactly ${MAX_LIVE_REQUESTS} network request, observed ${networkCalls}`,
    });
  }

  if (attempts !== null && attempts !== undefined) {
    if (!Number.isInteger(attempts) || attempts < 0) {
      violations.push({
        code: CALL_BUDGET_VIOLATION.UNCOUNTED,
        detail: 'the invoker reported a non-numeric attempt count',
      });
    } else {
      if (attempts !== MAX_LIVE_REQUESTS) {
        violations.push({
          code: CALL_BUDGET_VIOLATION.TOO_MANY_ATTEMPTS,
          detail: `expected exactly ${MAX_LIVE_REQUESTS} attempt, the invoker reported ${attempts}`,
        });
      }
      // Both counters individually fine but disagreeing is impossible if
      // every request went through the governed path — so it is reported
      // rather than reconciled.
      if (attempts !== networkCalls) {
        violations.push({
          code: CALL_BUDGET_VIOLATION.COUNTER_DISAGREEMENT,
          detail: `the invoker counted ${attempts} attempt(s) but the wire saw ${networkCalls} request(s)`,
        });
      }
    }
  }

  return Object.freeze({ ok: violations.length === 0, violations: Object.freeze(violations) });
}

/**
 * The same verdict, plus the ACT of refusing — so the caller has no
 * branch of its own to get wrong.
 *
 * `verifyCallBudget` alone left the caller holding an `if`, and an `if`
 * in a script is exactly what M27's mutation testing showed cannot be
 * covered: disabling it changed no observable behavior any test could
 * reach. Moving the decision here leaves the script one unconditional
 * call, and makes "does a violation actually stop the run?" a question a
 * test can ask directly, with `report` and `fail` injected.
 *
 * @param {object} args
 * @param {number} args.networkCalls
 * @param {number|null} [args.attempts]
 * @param {(line:string) => void} args.report  receives operator-facing lines
 * @param {() => void} args.fail  called ONLY on a violation; expected not
 *   to return (the script passes `process.exit(1)`)
 * @returns {{ok:boolean, violations:ReadonlyArray<object>}} the verdict,
 *   for a caller that wants to keep going after a clean run.
 */
export function enforceCallBudget({ networkCalls, attempts = null, report, fail }) {
  const verdict = verifyCallBudget({ networkCalls, attempts });
  if (verdict.ok) return verdict;

  const say = typeof report === 'function' ? report : () => {};
  say('');
  say('  ✗ CALL-BUDGET VIOLATION — this run may NOT be reported as valid');
  for (const v of verdict.violations) say(`    ${v.code}: ${v.detail}`);
  say('');
  say('  STOPPING. Not retrying.');
  say('');
  if (typeof fail === 'function') fail();
  return verdict;
}

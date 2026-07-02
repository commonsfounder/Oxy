'use strict';
// Pure outcome classifier for the reliability benchmark — no browser, no model, so it's
// unit-testable (see test/smoke/reliability-classify.test.js). Maps a `runOrderingTurn`
// result (plus the case's `expect`) to one of a small set of buckets the scorecard groups
// by. The KEY distinction is `botwall` (an infra/IP ceiling — the loop never got a fair
// page) vs `stuck`/`wrong` (a real loop failure), because only the latter is ours to fix.

// The loop's own copy for a stripped/blocked page (see browser-task.js blocked-shell + STUCK
// branches). Matched on the user-facing error string the harness receives.
const BOTWALL_ERROR = /blocking automated access|couldn'?t load the page properly/i;
const STUCK_ERROR = /got stuck on this page/i;
const WATCHDOG = /taking an unusually long time/i;

// buckets:
//  pass       — reached the expected success state
//  botwall    — infra ceiling: site served a blocked/stripped page (NOT a loop bug)
//  reauth     — needs a stored login we don't have in the harness (NOT a loop bug)
//  stuck      — loop ran but couldn't make progress (a real loop failure)
//  wrong      — finished in a state that doesn't satisfy the goal (e.g. done on an order case)
//  incomplete — ran out of turns / asked a question it shouldn't need to (a soft loop failure)
//  threw      — an unhandled exception escaped the loop
function classifyOutcome(expect, outcome) {
  if (!outcome || typeof outcome !== 'object') return 'threw';
  const { type } = outcome;

  if (type === 'reauth') return 'reauth';

  if (type === 'error') {
    const msg = String(outcome.error || '');
    if (BOTWALL_ERROR.test(msg)) return 'botwall';
    if (STUCK_ERROR.test(msg)) return 'stuck';
    return 'stuck'; // any other hard error mid-loop is a loop failure to explain
  }

  if (type === 'done') {
    // A price/info lookup wants `done`. An order case that ends in `done` never actually
    // built a cart (the loop guards against a premature order-`done`), so it's `wrong`.
    return expect === 'cart' ? 'wrong' : 'pass';
  }

  if (type === 'ready_for_payment') {
    // Cart built to the pay guardrail — the success state for a `cart` case. For an
    // `answer` case, reaching payment means it overshot the goal, but it did find the item.
    return 'pass';
  }

  if (type === 'ask') {
    if (WATCHDOG.test(String(outcome.question || ''))) return 'incomplete';
    // A legitimate fork the goal didn't resolve. For a `cart` case a needed choice is
    // plausible; for an `answer` case the loop should have just answered → soft failure.
    return 'incomplete';
  }

  // awaiting_more after the harness exhausts its turn budget = never converged.
  if (type === 'awaiting_more') return 'incomplete';

  return 'threw';
}

// A bucket is a "loop failure" (counts against the reliability number) vs an infra ceiling
// (excluded, tracked separately). pass is neither.
const LOOP_FAILURE_BUCKETS = new Set(['stuck', 'wrong', 'incomplete', 'threw']);
const INFRA_BUCKETS = new Set(['botwall', 'reauth']);

module.exports = { classifyOutcome, LOOP_FAILURE_BUCKETS, INFRA_BUCKETS };

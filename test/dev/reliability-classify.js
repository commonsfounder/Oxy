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
// A checkout fork asking for user-specific data the harness deliberately withholds (email,
// address, postcode, phone, card, name, or a sign-in). When the loop asks this on an ORDER
// case it has already built the basket and reached checkout — the success boundary, not a
// bug. Kept narrow so a "which size/colour?" ask (a real loop failure when the goal named
// it) does NOT match.
const USER_DATA_GATE = /\b(e-?mail|delivery address|shipping address|postcode|post code|zip code|phone number|mobile number|card (?:number|details)|payment details|(?:full |your )?name|sign in|log ?in|create an account)\b/i;

// buckets:
//  pass       — reached the expected success state
//  botwall    — infra ceiling: site served a blocked/stripped page (NOT a loop bug)
//  reauth     — needs a stored login we don't have in the harness (NOT a loop bug)
//  stuck      — loop ran but couldn't make progress (a real loop failure)
//  wrong      — finished in a state that doesn't satisfy the goal (e.g. done on an order case)
//  user_gate  — order reached checkout and asked for withheld user data (email/address/
//               login) — the success boundary for the harness, NOT a loop bug
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
    const q = String(outcome.question || '');
    if (WATCHDOG.test(q)) return 'incomplete';
    // On an order case, an ask for checkout data we intentionally don't supply means the
    // loop reached the checkout gate — an infra ceiling like reauth, not a loop failure.
    if (expect === 'cart' && USER_DATA_GATE.test(q)) return 'user_gate';
    // Any other ask is a fork the loop shouldn't have needed (e.g. a size the goal named,
    // or any ask on an info lookup) → soft loop failure.
    return 'incomplete';
  }

  // awaiting_more after the harness exhausts its turn budget = never converged.
  if (type === 'awaiting_more') return 'incomplete';

  return 'threw';
}

// A bucket is a "loop failure" (counts against the reliability number) vs an infra ceiling
// (excluded, tracked separately). pass is neither.
const LOOP_FAILURE_BUCKETS = new Set(['stuck', 'wrong', 'incomplete', 'threw']);
const INFRA_BUCKETS = new Set(['botwall', 'reauth', 'user_gate']);

module.exports = { classifyOutcome, LOOP_FAILURE_BUCKETS, INFRA_BUCKETS };

// Hard server-side spend limits the model cannot talk its way past. This is defense-in-depth
// BEHIND the human review gate (action-runner routes high-risk/confirmation actions to
// setPendingAction): even if a spend reaches execution — an approved pending action, or any
// future path that sets bypassReview — an out-of-policy amount is refused here, deterministically,
// with no model in the loop. Caps are env-tunable but default conservative.
const DEFAULT_PER_TXN_USD = 100;
const DEFAULT_PER_DAY_USD = 500;

function positiveNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Resolve the active caps from env each call so tests and ops can override without a restart.
function spendLimits(env = process.env) {
  return {
    perTxn: positiveNum(env.OXY_MAX_SPEND_PER_TXN, DEFAULT_PER_TXN_USD),
    perDay: positiveNum(env.OXY_MAX_SPEND_PER_DAY, DEFAULT_PER_DAY_USD),
  };
}

// Pure and unit-testable. Given the requested amount and how much has already been spent in the
// current rolling day, decide if the spend is allowed. Returns { ok, error }. The caller owns
// reading/writing the daily tally (it lives in the user's preferences); this just does the math.
function checkSpendLimit({ amount, spentToday = 0, limits = spendLimits() } = {}) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return { ok: false, error: 'Invalid amount.' };
  }
  if (amt > limits.perTxn) {
    return {
      ok: false,
      error: `Amount $${amt.toFixed(2)} exceeds the per-transaction cap of $${limits.perTxn.toFixed(2)}. Ask the user to confirm a higher OXY_MAX_SPEND_PER_TXN, or split the spend.`,
    };
  }
  const prior = Number.isFinite(Number(spentToday)) && Number(spentToday) > 0 ? Number(spentToday) : 0;
  if (prior + amt > limits.perDay) {
    return {
      ok: false,
      error: `This would bring today's concierge spend to $${(prior + amt).toFixed(2)}, over the daily cap of $${limits.perDay.toFixed(2)}. It won't go through automatically.`,
    };
  }
  return { ok: true };
}

// Regression: spend_from_concierge_account deducted the virtual balance unconditionally,
// then separately attempted a real Stripe PaymentIntent when a key was configured. If that
// real attempt FAILED, the handler still returned success: true (just appending a failure
// note to the text) — the virtual balance was already gone with no real charge to show for
// it, and the caller had no way to distinguish "spent" from "failed but silently accepted."
// Pure and unit-testable: decides the final outcome given whether a real Stripe attempt was
// made and how it went. A failed real attempt must be reported as a failure, full stop — the
// caller must not persist the balance deduction in that case.
function resolveConciergeSpendOutcome({ amount, balanceBeforeSpend, stripeAttempted, stripeSucceeded, stripeError, stripeClientSecret }) {
  if (stripeAttempted && !stripeSucceeded) {
    return {
      success: false,
      error: `Stripe charge failed, so nothing was spent: ${stripeError || 'unknown error'}`,
      balance: balanceBeforeSpend,
    };
  }
  const balance = Number((balanceBeforeSpend - amount).toFixed(2));
  const realChargeInfo = stripeAttempted
    ? ` Real Stripe PaymentIntent created (client_secret: ${stripeClientSecret}). Confirm in your app to complete actual charge.`
    : '';
  return { success: true, balance, realChargeInfo };
}

module.exports = { checkSpendLimit, spendLimits, resolveConciergeSpendOutcome, DEFAULT_PER_TXN_USD, DEFAULT_PER_DAY_USD };

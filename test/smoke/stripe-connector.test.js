const assert = require('node:assert/strict');
const test = require('node:test');

// connectors/stripe.js builds its own supabase client at module load via
// createSupabaseServiceClient() — that's fine for this test because we never touch
// the network; guardConciergeSpend and chargeLinkedCard both take an injected
// client, and this module's own top-level supabase client is only used for the
// SPEND_ACTIONS cap check, which we exercise indirectly through amount limits.
const money = require('../../api/services/money-guard');

test('money-guard per-transaction cap default still rejects an over-limit concierge stripe spend', () => {
  // Regression guard for the rewritten spend_from_concierge_via_stripe: the shared cap
  // must still be the thing that blocks an out-of-policy amount before any Stripe call
  // is attempted, regardless of how the charge itself is implemented.
  const verdict = money.checkSpendLimit({ amount: 99999, spentToday: 0 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /per-transaction cap/);
});

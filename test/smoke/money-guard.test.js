const assert = require('node:assert/strict');
const test = require('node:test');

const { checkSpendLimit, spendLimits, resolveConciergeSpendOutcome } = require('../../api/services/money-guard');

test('checkSpendLimit allows a spend within both caps', () => {
  const r = checkSpendLimit({ amount: 20, spentToday: 0, limits: { perTxn: 100, perDay: 500 } });
  assert.deepEqual(r, { ok: true });
});

test('checkSpendLimit rejects an over-per-transaction amount (the model-hallucinated big charge)', () => {
  const r = checkSpendLimit({ amount: 250, spentToday: 0, limits: { perTxn: 100, perDay: 500 } });
  assert.equal(r.ok, false);
  assert.match(r.error, /per-transaction cap/);
});

test('checkSpendLimit rejects when the rolling daily total would be exceeded', () => {
  const r = checkSpendLimit({ amount: 60, spentToday: 460, limits: { perTxn: 100, perDay: 500 } });
  assert.equal(r.ok, false);
  assert.match(r.error, /daily cap/);
});

test('checkSpendLimit rejects zero / negative / non-numeric amounts', () => {
  for (const amount of [0, -5, NaN, 'lots', undefined]) {
    assert.equal(checkSpendLimit({ amount, limits: { perTxn: 100, perDay: 500 } }).ok, false);
  }
});

test('checkSpendLimit allows exactly hitting the daily cap but not a cent over', () => {
  const limits = { perTxn: 100, perDay: 500 };
  assert.equal(checkSpendLimit({ amount: 100, spentToday: 400, limits }).ok, true);
  assert.equal(checkSpendLimit({ amount: 100.01, spentToday: 400, limits }).ok, false);
});

test('spendLimits reads env overrides and falls back to conservative defaults', () => {
  assert.deepEqual(spendLimits({ OXY_MAX_SPEND_PER_TXN: '250', OXY_MAX_SPEND_PER_DAY: '1000' }), { perTxn: 250, perDay: 1000 });
  const def = spendLimits({});
  assert.ok(def.perTxn > 0 && def.perDay >= def.perTxn);
  // Garbage env must not disable the cap (fall back to defaults, never Infinity/0).
  assert.deepEqual(spendLimits({ OXY_MAX_SPEND_PER_TXN: '-1', OXY_MAX_SPEND_PER_DAY: 'nope' }), def);
});

// Regression: spend_from_concierge_account used to deduct the virtual balance unconditionally
// and still report success: true even when the real Stripe charge attempt failed — the user's
// spendable balance vanished with no real charge to show for it.
test('resolveConciergeSpendOutcome deducts and succeeds for a pure virtual spend (no Stripe key)', () => {
  const r = resolveConciergeSpendOutcome({ amount: 20, balanceBeforeSpend: 100, stripeAttempted: false });
  assert.equal(r.success, true);
  assert.equal(r.balance, 80);
  assert.equal(r.realChargeInfo, '');
});

test('resolveConciergeSpendOutcome deducts and succeeds when the real Stripe attempt succeeds', () => {
  const r = resolveConciergeSpendOutcome({
    amount: 20, balanceBeforeSpend: 100, stripeAttempted: true, stripeSucceeded: true, stripeClientSecret: 'secret_123',
  });
  assert.equal(r.success, true);
  assert.equal(r.balance, 80);
  assert.match(r.realChargeInfo, /secret_123/);
  assert.match(r.realChargeInfo, /Confirm in your app/);
});

test('resolveConciergeSpendOutcome refuses and does NOT deduct when the real Stripe attempt fails', () => {
  const r = resolveConciergeSpendOutcome({
    amount: 20, balanceBeforeSpend: 100, stripeAttempted: true, stripeSucceeded: false, stripeError: 'card declined',
  });
  assert.equal(r.success, false);
  assert.equal(r.balance, 100, 'balance must be unchanged — nothing real happened');
  assert.match(r.error, /card declined/);
});

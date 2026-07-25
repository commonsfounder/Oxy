const assert = require('node:assert/strict');
const test = require('node:test');

const { checkSpendLimit, spendLimits, capCurrency, detectCurrency, convertAmount } = require('../../api/services/money-guard');

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

// --- Currency correctness -------------------------------------------------------------
// Bug: caps are denominated in one currency (USD by default) but the browser-checkout path
// fed in a raw store price whose currency symbol had been stripped — so a UK £-amount was
// compared against a $-cap, making the effective limit ~27% higher than intended.

test('capCurrency defaults to USD and is env-overridable', () => {
  assert.equal(capCurrency({}), 'USD');
  assert.equal(capCurrency({ OXY_SPEND_CAP_CURRENCY: 'gbp' }), 'GBP');
});

test('detectCurrency reads the symbol or trailing code, null when absent', () => {
  assert.equal(detectCurrency('£95.00'), 'GBP');
  assert.equal(detectCurrency('$50'), 'USD');
  assert.equal(detectCurrency('12,99 €'), 'EUR');
  assert.equal(detectCurrency('49.99 GBP'), 'GBP');
  assert.equal(detectCurrency('1299'), null);
  assert.equal(detectCurrency(123), null);
  assert.equal(detectCurrency(null), null);
});

test('convertAmount uses a USD-base table and is env-overridable', () => {
  // Same currency is always identity, even for exotic/unknown codes.
  assert.equal(convertAmount(100, 'USD', 'USD', {}), 100);
  // £85 at the default 1.27 rate is ~$107.95 — the amount that used to slip past a $100 cap.
  assert.equal(convertAmount(85, 'GBP', 'USD', {}), 107.95);
  // Env override changes the rate deterministically (no live FX call).
  assert.equal(convertAmount(100, 'GBP', 'USD', { OXY_FX_USD_PER_GBP: '2' }), 200);
});

test('convertAmount returns null (fail-closed) for unknown currency or bad amount', () => {
  assert.equal(convertAmount(100, 'ZZZ', 'USD', {}), null);
  assert.equal(convertAmount(100, 'USD', 'ZZZ', {}), null);
  // Non-finite amounts are unconvertible; the >0 gate for zero/negative lives in checkSpendLimit.
  for (const bad of [NaN, 'lots', undefined, Infinity]) {
    assert.equal(convertAmount(bad, 'GBP', 'USD', {}), null);
  }
});

test('checkSpendLimit converts a foreign-currency amount into the cap currency before comparing', () => {
  const limits = { perTxn: 100, perDay: 500 };
  // £85 (~$108) must be rejected against a $100 cap; the same 85 in USD is allowed.
  assert.equal(checkSpendLimit({ amount: 85, currency: 'GBP', limits, env: {} }).ok, false);
  assert.equal(checkSpendLimit({ amount: 85, currency: 'USD', limits, env: {} }).ok, true);
  // Unknown currency fails closed rather than comparing raw numbers.
  assert.equal(checkSpendLimit({ amount: 10, currency: 'ZZZ', limits, env: {} }).ok, false);
});

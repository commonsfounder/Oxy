const assert = require('node:assert/strict');
const test = require('node:test');

const { checkSpendLimit, spendLimits } = require('../../api/services/money-guard');

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

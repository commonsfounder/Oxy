const assert = require('node:assert/strict');
const test = require('node:test');

const { guardConciergeSpend, SPEND_DAY_KEY } = require('../../api/services/concierge-spend-guard');

// Minimal fake Supabase client: one preferences row keyed by (user_id, key), enough to drive
// guardConciergeSpend's read-tally / write-tally round trip without a real database.
function fakeSupabase(initialRows = []) {
  const rows = [...initialRows];
  return {
    _rows: rows,
    from(table) {
      assert.equal(table, 'preferences');
      return {
        select() {
          return {
            eq(_col1, userId) {
              return {
                eq(_col2, key) {
                  const data = rows.filter(r => r.user_id === userId && r.key === key);
                  return Promise.resolve({ data });
                }
              };
            }
          };
        },
        upsert(row) {
          const i = rows.findIndex(r => r.user_id === row.user_id && r.key === row.key);
          if (i >= 0) rows[i] = row; else rows.push(row);
          return Promise.resolve({ error: null });
        }
      };
    }
  };
}

test('guardConciergeSpend allows a fresh spend and writes today\'s tally', async () => {
  const supabase = fakeSupabase();
  const verdict = await guardConciergeSpend(supabase, 'user-1', 20);
  assert.equal(verdict.ok, true);
  const row = supabase._rows.find(r => r.user_id === 'user-1' && r.key === SPEND_DAY_KEY);
  const tally = JSON.parse(row.value);
  assert.equal(tally.total, 20);
});

test('guardConciergeSpend rejects an over-per-transaction amount before touching the tally', async () => {
  const supabase = fakeSupabase();
  const verdict = await guardConciergeSpend(supabase, 'user-1', 99999);
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /per-transaction cap/);
  assert.equal(supabase._rows.length, 0, 'a rejected spend must not write a tally entry');
});

// Regression: connectors/stripe.js used to call checkSpendLimit directly with no spentToday,
// so a repeat spend_from_concierge_via_stripe / stripe_payout_to_user call could blow past the
// daily cap even though each individual call was under the per-transaction limit.
test('guardConciergeSpend accumulates today\'s spend across repeated calls and enforces the daily cap', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const supabase = fakeSupabase([
    { user_id: 'user-2', key: SPEND_DAY_KEY, value: JSON.stringify({ date: today, total: 480 }) }
  ]);
  const verdict = await guardConciergeSpend(supabase, 'user-2', 30);
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /daily cap/);
});

test('guardConciergeSpend resets the tally on a new day', async () => {
  const supabase = fakeSupabase([
    { user_id: 'user-3', key: SPEND_DAY_KEY, value: JSON.stringify({ date: '2020-01-01', total: 490 }) }
  ]);
  const verdict = await guardConciergeSpend(supabase, 'user-3', 30);
  assert.equal(verdict.ok, true);
});

// Regression: the browser-checkout path passed a UK store's £-price against a $-cap. A GBP
// amount must be converted to the cap currency (USD) before the cap math, and the rolling
// tally must be stored in that same cap currency so repeated foreign spends accumulate right.
test('guardConciergeSpend converts a GBP amount to the cap currency for both cap and tally', async () => {
  const supabase = fakeSupabase();
  // £85 ~= $107.95 at the default rate -> over the $100 per-transaction cap.
  const rejected = await guardConciergeSpend(supabase, 'user-gbp', 85, 'GBP');
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /per-transaction cap/);
  assert.equal(supabase._rows.length, 0, 'a rejected spend must not write a tally entry');

  // £70 ~= $88.90 -> allowed; the tally must record the converted USD figure, not the raw 70.
  const allowed = await guardConciergeSpend(supabase, 'user-gbp', 70, 'GBP');
  assert.equal(allowed.ok, true);
  const row = supabase._rows.find(r => r.user_id === 'user-gbp' && r.key === SPEND_DAY_KEY);
  assert.equal(JSON.parse(row.value).total, 88.9);
});

test('guardConciergeSpend fails closed on an unconvertible currency', async () => {
  const supabase = fakeSupabase();
  const verdict = await guardConciergeSpend(supabase, 'user-x', 10, 'ZZZ');
  assert.equal(verdict.ok, false);
  assert.equal(supabase._rows.length, 0);
});

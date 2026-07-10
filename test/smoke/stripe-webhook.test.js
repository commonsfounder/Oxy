const assert = require('node:assert/strict');
const test = require('node:test');

const { handleStripeWebhookEvent } = require('../../api/services/stripe-webhook');
const { setPaymentActionRequired } = require('../../api/services/stripe-cards');

function fakeSupabase(initialRows = []) {
  const rows = [...initialRows];
  function matches(row, filters) {
    return Object.entries(filters).every(([k, v]) => row[k] === v);
  }
  return {
    _rows: rows,
    from(table) {
      return {
        select() {
          const filters = {};
          const builder = {
            eq(col, val) { filters[col] = val; return builder; },
            maybeSingle() {
              const match = rows.filter(r => r._table === table).find(r => matches(r, filters));
              return Promise.resolve({ data: match || null });
            }
          };
          return builder;
        },
        upsert(row) {
          const tagged = { ...row, _table: table };
          const key = ['user_id', 'key'];
          const i = rows.findIndex(r => r._table === table && key.every(k => r[k] === row[k]));
          if (i >= 0) rows[i] = tagged; else rows.push(tagged);
          return Promise.resolve({ error: null });
        },
        delete() {
          const filters = {};
          const builder = {
            eq(col, val) { filters[col] = val; return builder; },
            select(col) {
              // Compare-and-delete: only rows matching every .eq() filter (including
              // an exact `value` match, when supplied) are removed. Returns the
              // removed rows' selected column so the caller can tell whether it
              // actually won the delete (mirrors supabase .delete().select()).
              const idx = rows.findIndex(r => r._table === table && matches(r, filters));
              let removed = [];
              if (idx >= 0) {
                removed = rows.splice(idx, 1).map(r => ({ [col]: r[col] }));
              }
              return Promise.resolve({ data: removed, error: null });
            },
            then(resolve) {
              const idx = rows.findIndex(r => r._table === table && matches(r, filters));
              if (idx >= 0) rows.splice(idx, 1);
              resolve({ error: null });
            }
          };
          return builder;
        }
      };
    }
  };
}

test('handleStripeWebhookEvent ignores events with no oxy_user_id metadata', async () => {
  const supabase = fakeSupabase();
  const result = await handleStripeWebhookEvent(supabase, { type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', metadata: {} } } });
  assert.equal(result.handled, false);
});

test('handleStripeWebhookEvent ignores unrelated event types', async () => {
  const supabase = fakeSupabase();
  const result = await handleStripeWebhookEvent(supabase, { type: 'charge.refunded', data: { object: { id: 'pi_1', metadata: { oxy_user_id: 'user-1' } } } });
  assert.equal(result.handled, false);
});

test('succeeded event for a PaymentIntent with no matching pending SCA record is a no-op deduction (already handled synchronously)', async () => {
  const supabase = fakeSupabase();
  const result = await handleStripeWebhookEvent(supabase, {
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_1', amount: 1000, metadata: { oxy_user_id: 'user-1' } } }
  });
  assert.equal(result.handled, true);
  assert.equal(result.deducted, false);
});

test('succeeded event resolves a pending SCA charge exactly once: deducts balance and clears the flag', async () => {
  const supabase = fakeSupabase([
    { _table: 'preferences', user_id: 'user-1', key: 'concierge_account.balance', value: '100' }
  ]);
  await setPaymentActionRequired(supabase, 'user-1', { paymentIntentId: 'pi_2', clientSecret: 'pi_2_secret', amountCents: 2500, description: 'concierge spend' });

  const result = await handleStripeWebhookEvent(supabase, {
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_2', amount: 2500, description: 'concierge spend', metadata: { oxy_user_id: 'user-1' } } }
  });

  assert.equal(result.handled, true);
  assert.equal(result.deducted, true);
  const balanceRow = supabase._rows.find(r => r._table === 'preferences' && r.key === 'concierge_account.balance');
  assert.equal(balanceRow.value, '75');
  const pendingRow = supabase._rows.find(r => r._table === 'preferences' && r.key === 'concierge_account.payment_action_required');
  assert.equal(pendingRow, undefined, 'the SCA-pending flag must be cleared once resolved');
});

test('redelivered succeeded events for the same PaymentIntent only deduct once (at-least-once webhook delivery)', async () => {
  const supabase = fakeSupabase([
    { _table: 'preferences', user_id: 'user-1', key: 'concierge_account.balance', value: '100' }
  ]);
  await setPaymentActionRequired(supabase, 'user-1', { paymentIntentId: 'pi_4', clientSecret: 'pi_4_secret', amountCents: 3000, description: 'concierge spend' });

  const event = {
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_4', amount: 3000, description: 'concierge spend', metadata: { oxy_user_id: 'user-1' } } }
  };

  // Simulate Stripe redelivering the same event (or two near-simultaneous
  // deliveries) by firing both handler calls without awaiting the first
  // before starting the second. Because handleStripeWebhookEvent has real
  // await points between its read and its write, Promise.all here actually
  // interleaves the two calls at the microtask level — both can complete
  // their "read" step before either completes its "write" step, which is
  // exactly the contention window a real concurrent claim must survive.
  // A sequential await-then-await version would NOT exercise this: see the
  // report for how this was verified against the pre-fix read-then-clear
  // logic.
  const [first, second] = await Promise.all([
    handleStripeWebhookEvent(supabase, event),
    handleStripeWebhookEvent(supabase, event)
  ]);

  const deductedCount = [first, second].filter(r => r.deducted === true).length;
  assert.equal(deductedCount, 1, 'exactly one delivery should win the claim and deduct');

  const balanceRow = supabase._rows.find(r => r._table === 'preferences' && r.key === 'concierge_account.balance');
  assert.equal(balanceRow.value, '70', 'balance must only be deducted once (100 - 30 = 70), not twice');

  const pendingRow = supabase._rows.find(r => r._table === 'preferences' && r.key === 'concierge_account.payment_action_required');
  assert.equal(pendingRow, undefined);
});

test('failed event for a pending SCA charge clears the flag without touching balance', async () => {
  const supabase = fakeSupabase([
    { _table: 'preferences', user_id: 'user-1', key: 'concierge_account.balance', value: '100' }
  ]);
  await setPaymentActionRequired(supabase, 'user-1', { paymentIntentId: 'pi_3', clientSecret: 'pi_3_secret', amountCents: 1000, description: 'x' });

  const result = await handleStripeWebhookEvent(supabase, {
    type: 'payment_intent.payment_failed',
    data: { object: { id: 'pi_3', metadata: { oxy_user_id: 'user-1' } } }
  });

  assert.equal(result.handled, true);
  assert.equal(result.outcome, 'failed');
  const balanceRow = supabase._rows.find(r => r._table === 'preferences' && r.key === 'concierge_account.balance');
  assert.equal(balanceRow.value, '100', 'a failed charge must not touch the balance');
  const pendingRow = supabase._rows.find(r => r._table === 'preferences' && r.key === 'concierge_account.payment_action_required');
  assert.equal(pendingRow, undefined);
});

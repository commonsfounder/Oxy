const assert = require('node:assert/strict');
const test = require('node:test');

const { getLinkedCard, saveLinkedCard, STRIPE_CONNECTOR_ID } = require('../../api/services/stripe-cards');

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
          const key = table === 'connectors' ? ['user_id', 'connector_id'] : ['user_id', 'key'];
          const i = rows.findIndex(r => r._table === table && key.every(k => r[k] === row[k]));
          if (i >= 0) rows[i] = tagged; else rows.push(tagged);
          return Promise.resolve({ error: null });
        }
      };
    }
  };
}

test('getLinkedCard returns null when no stripe connector row exists', async () => {
  const supabase = fakeSupabase();
  const card = await getLinkedCard(supabase, 'user-1');
  assert.equal(card, null);
});

test('getLinkedCard returns null when a row exists but is not enabled (customer created, no card yet)', async () => {
  const supabase = fakeSupabase([
    { _table: 'connectors', user_id: 'user-1', connector_id: STRIPE_CONNECTOR_ID, enabled: false, tokens: { stripe_customer_id: 'cus_1' } }
  ]);
  const card = await getLinkedCard(supabase, 'user-1');
  assert.equal(card, null);
});

test('saveLinkedCard then getLinkedCard round-trips the card details', async () => {
  const supabase = fakeSupabase();
  await saveLinkedCard(supabase, 'user-1', { customerId: 'cus_1', paymentMethodId: 'pm_1', brand: 'visa', last4: '4242' });
  const card = await getLinkedCard(supabase, 'user-1');
  assert.deepEqual(card, { customerId: 'cus_1', paymentMethodId: 'pm_1', brand: 'visa', last4: '4242' });
});

test('saveLinkedCard preserves an existing secret_key override already on the tokens blob', async () => {
  const supabase = fakeSupabase([
    { _table: 'connectors', user_id: 'user-1', connector_id: STRIPE_CONNECTOR_ID, enabled: false, tokens: { secret_key: 'sk_test_custom' } }
  ]);
  await saveLinkedCard(supabase, 'user-1', { customerId: 'cus_1', paymentMethodId: 'pm_1', brand: 'visa', last4: '4242' });
  const row = supabase._rows.find(r => r._table === 'connectors' && r.user_id === 'user-1');
  assert.equal(row.tokens.secret_key, 'sk_test_custom');
  assert.equal(row.tokens.stripe_customer_id, 'cus_1');
});

test('saveLinkedCard rejects missing customerId or paymentMethodId', async () => {
  const supabase = fakeSupabase();
  await assert.rejects(() => saveLinkedCard(supabase, 'user-1', { paymentMethodId: 'pm_1' }), TypeError);
  await assert.rejects(() => saveLinkedCard(supabase, 'user-1', { customerId: 'cus_1' }), TypeError);
});

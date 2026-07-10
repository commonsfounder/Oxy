const assert = require('node:assert/strict');
const test = require('node:test');

const { getLinkedCard, saveLinkedCard, STRIPE_CONNECTOR_ID, getOrCreateStripeCustomer, createSetupIntentForUser } = require('../../api/services/stripe-cards');

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

function fakeStripeForCustomers({ nextCustomerId = 'cus_new', nextSetupIntent = { id: 'seti_1', client_secret: 'seti_1_secret' } } = {}) {
  const calls = { customersCreate: [], setupIntentsCreate: [] };
  return {
    _calls: calls,
    customers: {
      create: async (params) => { calls.customersCreate.push(params); return { id: nextCustomerId }; }
    },
    setupIntents: {
      create: async (params) => { calls.setupIntentsCreate.push(params); return nextSetupIntent; }
    }
  };
}

test('getOrCreateStripeCustomer creates a new Stripe customer when none is stored yet', async () => {
  const supabase = fakeSupabase();
  const stripe = fakeStripeForCustomers({ nextCustomerId: 'cus_abc' });
  const customerId = await getOrCreateStripeCustomer(stripe, supabase, 'user-1');
  assert.equal(customerId, 'cus_abc');
  assert.equal(stripe._calls.customersCreate.length, 1);
  assert.equal(stripe._calls.customersCreate[0].metadata.oxy_user_id, 'user-1');
  const row = supabase._rows.find(r => r._table === 'connectors' && r.user_id === 'user-1');
  assert.equal(row.tokens.stripe_customer_id, 'cus_abc');
  assert.equal(row.enabled, false, 'creating a customer alone must not mark the connector enabled — no card linked yet');
});

test('getOrCreateStripeCustomer reuses an existing stripe_customer_id without calling Stripe again', async () => {
  const supabase = fakeSupabase([
    { _table: 'connectors', user_id: 'user-1', connector_id: STRIPE_CONNECTOR_ID, enabled: false, tokens: { stripe_customer_id: 'cus_existing' } }
  ]);
  const stripe = fakeStripeForCustomers();
  const customerId = await getOrCreateStripeCustomer(stripe, supabase, 'user-1');
  assert.equal(customerId, 'cus_existing');
  assert.equal(stripe._calls.customersCreate.length, 0);
});

test('createSetupIntentForUser creates a SetupIntent for the user\'s customer, usage off_session', async () => {
  const supabase = fakeSupabase();
  const stripe = fakeStripeForCustomers({ nextCustomerId: 'cus_abc', nextSetupIntent: { id: 'seti_9', client_secret: 'seti_9_secret' } });
  const result = await createSetupIntentForUser(stripe, supabase, 'user-1');
  assert.equal(result.clientSecret, 'seti_9_secret');
  assert.equal(result.customerId, 'cus_abc');
  assert.equal(stripe._calls.setupIntentsCreate[0].customer, 'cus_abc');
  assert.equal(stripe._calls.setupIntentsCreate[0].usage, 'off_session');
});

const assert = require('node:assert/strict');
const test = require('node:test');

const { getLinkedCard, saveLinkedCard, unlinkCard, STRIPE_CONNECTOR_ID, getOrCreateStripeCustomer, createSetupIntentForUser, resolveOffSessionChargeOutcome, chargeLinkedCard, setPaymentActionRequired, getPaymentActionRequired, clearPaymentActionRequired } = require('../../api/services/stripe-cards');

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
        },
        delete() {
          const filters = {};
          const builder = {
            eq(col, val) { filters[col] = val; return builder; },
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

test('unlinkCard clears the card fields and disables the connector, but keeps the Stripe customer id', async () => {
  const supabase = fakeSupabase();
  await saveLinkedCard(supabase, 'user-1', { customerId: 'cus_1', paymentMethodId: 'pm_1', brand: 'visa', last4: '4242' });
  await unlinkCard(supabase, 'user-1');
  const card = await getLinkedCard(supabase, 'user-1');
  assert.equal(card, null, 'getLinkedCard must report no card once unlinked');
  const row = supabase._rows.find(r => r._table === 'connectors' && r.user_id === 'user-1');
  assert.equal(row.enabled, false);
  assert.equal(row.tokens.stripe_customer_id, 'cus_1', 'customer id survives so a relink reuses it instead of creating a duplicate');
  assert.equal(row.tokens.default_payment_method_id, '');
  assert.equal(row.tokens.card_brand, '');
  assert.equal(row.tokens.card_last4, '');
});

test('unlinkCard on a user with no connector row yet is a harmless no-op', async () => {
  const supabase = fakeSupabase();
  await assert.doesNotReject(() => unlinkCard(supabase, 'user-1'));
  assert.equal(await getLinkedCard(supabase, 'user-1'), null);
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

test('resolveOffSessionChargeOutcome maps a succeeded PaymentIntent', () => {
  const outcome = resolveOffSessionChargeOutcome({ status: 'succeeded', id: 'pi_1' });
  assert.deepEqual(outcome, { status: 'succeeded' });
});

test('resolveOffSessionChargeOutcome maps a requires_action PaymentIntent (SCA)', () => {
  const outcome = resolveOffSessionChargeOutcome({ status: 'requires_action', client_secret: 'pi_1_secret' });
  assert.deepEqual(outcome, { status: 'requires_action', clientSecret: 'pi_1_secret' });
});

test('resolveOffSessionChargeOutcome maps any other status to failed with the decline reason', () => {
  const outcome = resolveOffSessionChargeOutcome({ status: 'requires_payment_method', last_payment_error: { message: 'card declined' } });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, 'card declined');
});

function fakeStripeForCharges(paymentIntentResponse) {
  const calls = [];
  return {
    _calls: calls,
    paymentIntents: {
      create: async (params, opts) => { calls.push({ params, opts }); return paymentIntentResponse; }
    }
  };
}

test('chargeLinkedCard returns no_card when the user has not linked a card', async () => {
  const supabase = fakeSupabase();
  const stripe = fakeStripeForCharges({ status: 'succeeded', id: 'pi_1' });
  const result = await chargeLinkedCard(stripe, supabase, 'user-1', { amountCents: 1000, description: 'test', idempotencyKey: 'idem_1' });
  assert.deepEqual(result, { status: 'no_card' });
  assert.equal(stripe._calls.length, 0);
});

test('chargeLinkedCard charges the linked card off-session with the idempotency key', async () => {
  const supabase = fakeSupabase();
  await saveLinkedCard(supabase, 'user-1', { customerId: 'cus_1', paymentMethodId: 'pm_1', brand: 'visa', last4: '4242' });
  const stripe = fakeStripeForCharges({ status: 'succeeded', id: 'pi_1' });
  const result = await chargeLinkedCard(stripe, supabase, 'user-1', { amountCents: 2500, currency: 'gbp', description: 'concierge spend', idempotencyKey: 'idem_1' });
  assert.deepEqual(result, { status: 'succeeded', paymentIntentId: 'pi_1' });
  const call = stripe._calls[0];
  assert.equal(call.params.amount, 2500);
  assert.equal(call.params.currency, 'gbp');
  assert.equal(call.params.customer, 'cus_1');
  assert.equal(call.params.payment_method, 'pm_1');
  assert.equal(call.params.off_session, true);
  assert.equal(call.params.confirm, true);
  assert.equal(call.params.metadata.oxy_user_id, 'user-1');
  assert.equal(call.opts.idempotencyKey, 'idem_1');
});

test('chargeLinkedCard surfaces requires_action for SCA', async () => {
  const supabase = fakeSupabase();
  await saveLinkedCard(supabase, 'user-1', { customerId: 'cus_1', paymentMethodId: 'pm_1' });
  const stripe = fakeStripeForCharges({ status: 'requires_action', id: 'pi_2', client_secret: 'pi_2_secret' });
  const result = await chargeLinkedCard(stripe, supabase, 'user-1', { amountCents: 500, description: 'x', idempotencyKey: 'idem_2' });
  assert.deepEqual(result, { status: 'requires_action', paymentIntentId: 'pi_2', clientSecret: 'pi_2_secret' });
});

test('chargeLinkedCard rejects a non-positive amount or a missing idempotency key', async () => {
  const supabase = fakeSupabase();
  const stripe = fakeStripeForCharges({ status: 'succeeded', id: 'pi_1' });
  await assert.rejects(() => chargeLinkedCard(stripe, supabase, 'user-1', { amountCents: 0, idempotencyKey: 'x' }), TypeError);
  await assert.rejects(() => chargeLinkedCard(stripe, supabase, 'user-1', { amountCents: 100 }), TypeError);
});

test('payment-action-required set/get/clear round-trips', async () => {
  const supabase = fakeSupabase();
  assert.equal(await getPaymentActionRequired(supabase, 'user-1'), null);
  await setPaymentActionRequired(supabase, 'user-1', { paymentIntentId: 'pi_2', clientSecret: 'pi_2_secret', amountCents: 500, description: 'x' });
  const pending = await getPaymentActionRequired(supabase, 'user-1');
  assert.equal(pending.paymentIntentId, 'pi_2');
  assert.equal(pending.clientSecret, 'pi_2_secret');
  await clearPaymentActionRequired(supabase, 'user-1');
  assert.equal(await getPaymentActionRequired(supabase, 'user-1'), null);
});

test('payment-action-required round-trips the currency the charge was attempted in', async () => {
  const supabase = fakeSupabase();
  await setPaymentActionRequired(supabase, 'user-1', {
    paymentIntentId: 'pi_3', clientSecret: 'pi_3_secret', amountCents: 1200, description: 'y', currency: 'gbp'
  });
  const pending = await getPaymentActionRequired(supabase, 'user-1');
  assert.equal(pending.currency, 'gbp');
});

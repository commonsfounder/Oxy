# Concierge Real Payments — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the concierge account able to charge a real, linked Stripe card
off-session, with SCA/3DS handling and idempotent charges — the backend half of
`docs/superpowers/specs/2026-07-10-concierge-real-payments-design.md`.

**Architecture:** A new `api/services/stripe-cards.js` module owns all Stripe
Customer/SetupIntent/PaymentIntent logic and linked-card storage (reusing the
`connectors` table, `connector_id='stripe'`, encrypted `tokens` — same pattern as
Google/Microsoft). A new `api/services/stripe-webhook.js` module resolves
`payment_intent.succeeded`/`payment_intent.payment_failed` events, and is the sole
place balance deduction happens for charges that needed SCA re-authentication
(avoids double-deducting a charge that also succeeded synchronously).
`api/services/pending-review.js` and `api/services/action-runner.js` gain a small,
optional card-aware review-copy path. `connectors/stripe.js` gets its
`spend_from_concierge_via_stripe` handler rewired onto the new off-session-charge
path. Two new authenticated routes and one webhook route are added to `api/index.js`.

**Tech Stack:** Node.js/Express (`api/index.js`), Supabase (`connectors`,
`preferences` tables), official `stripe` npm SDK, `node --test` (existing test
convention — dependency-injected fakes, no real network calls).

**Out of scope for this plan:** the iOS Stripe SDK / Payment Sheet / card-linking
screen, the Today-card SCA re-auth banner, and the review-card copy that reads
"charge your card ending in 4242" in the iOS app itself (that text is produced by
the backend in this plan; rendering it is a separate iOS plan). Also out of scope:
refunds/disputes, multiple cards, Stripe Connect payouts — per the design doc.

## Global Constraints

- All Stripe amounts sent to `stripe.paymentIntents.create` / `stripe.customers.create`
  etc. use the official `stripe` npm package — no raw `axios` calls to
  `api.stripe.com` in any new code (the existing raw-axios calls in
  `connectors/stripe.js` and `api/index.js` being replaced are the reason this
  package is being added).
- Every new Stripe-touching module takes its `stripe` client and `supabase` client as
  parameters (dependency injection) so tests never hit the network — this matches the
  existing `guardConciergeSpend(supabase, userId, amount)` convention in
  `api/services/concierge-spend-guard.js`.
- All reads/writes of the `connectors` table's `tokens` column go through
  `encryptTokens`/`decryptTokens` from `api/services/token-crypto.js` — this is
  already how the `stripe` connector row's optional `secret_key` override is stored
  (`connectors/stripe.js:20-35`), and card data must not silently break that format.
- `npm test` (`node --test test/smoke/*.test.js`) must stay green after every task.

---

### Task 1: Add the Stripe SDK dependency and document the new env vars

**Files:**
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `cloudrun.env.example.yaml`

**Interfaces:**
- Produces: the `stripe` npm package available to `require('stripe')` in later tasks.

- [ ] **Step 1: Install the official Stripe SDK**

Run: `npm install stripe`

Expected: `package.json` gains `"stripe": "^..."` under `dependencies`, and
`package-lock.json` updates.

- [ ] **Step 2: Document the new env vars in `.env.example`**

Add this block under the `# ── Optional ──` section, near the other connector
credentials (after the Microsoft OAuth block):

```
# Stripe (real card charges for the concierge account)
# STRIPE_SECRET_KEY=sk_test_...
# STRIPE_PUBLISHABLE_KEY=pk_test_...
# STRIPE_WEBHOOK_SECRET=whsec_...
```

- [ ] **Step 3: Document the same vars in `cloudrun.env.example.yaml`**

Add after the `GMAIL_CLIENT_SECRET: ""` line:

```yaml
STRIPE_SECRET_KEY: ""
STRIPE_PUBLISHABLE_KEY: ""
STRIPE_WEBHOOK_SECRET: ""
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .env.example cloudrun.env.example.yaml
git commit -m "chore: add Stripe SDK dependency and document Stripe env vars"
```

---

### Task 2: `stripe-cards.js` — linked-card storage

**Files:**
- Create: `api/services/stripe-cards.js`
- Test: `test/smoke/stripe-cards.test.js`

**Interfaces:**
- Consumes: `encryptTokens`, `decryptTokens` from `api/services/token-crypto.js`
  (signatures: `encryptTokens(tokensObj = {}) -> tokensObj|envelope`,
  `decryptTokens(value = {}) -> tokensObj`).
- Produces (for later tasks):
  - `STRIPE_CONNECTOR_ID` (string constant, `'stripe'`)
  - `getLinkedCard(supabase, userId) -> Promise<{customerId, paymentMethodId, brand, last4} | null>`
  - `saveLinkedCard(supabase, userId, {customerId, paymentMethodId, brand, last4}) -> Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `test/smoke/stripe-cards.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/smoke/stripe-cards.test.js`
Expected: FAIL — `Cannot find module '../../api/services/stripe-cards'`

- [ ] **Step 3: Write the implementation**

Create `api/services/stripe-cards.js`:

```js
const { encryptTokens, decryptTokens } = require('./token-crypto');

const STRIPE_CONNECTOR_ID = 'stripe';

async function readStripeTokens(supabase, userId) {
  const { data } = await supabase
    .from('connectors')
    .select('tokens, enabled')
    .eq('user_id', userId)
    .eq('connector_id', STRIPE_CONNECTOR_ID)
    .maybeSingle();
  if (!data) return { tokens: {}, enabled: false };
  return { tokens: decryptTokens(data.tokens || {}), enabled: !!data.enabled };
}

async function writeStripeTokens(supabase, userId, tokens, { enabled }) {
  const { error } = await supabase.from('connectors').upsert({
    user_id: userId,
    connector_id: STRIPE_CONNECTOR_ID,
    enabled,
    tokens: encryptTokens(tokens),
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id,connector_id' });
  if (error) throw error;
}

async function getLinkedCard(supabase, userId) {
  const { tokens, enabled } = await readStripeTokens(supabase, userId);
  if (!enabled || !tokens.stripe_customer_id || !tokens.default_payment_method_id) return null;
  return {
    customerId: tokens.stripe_customer_id,
    paymentMethodId: tokens.default_payment_method_id,
    brand: tokens.card_brand || '',
    last4: tokens.card_last4 || ''
  };
}

async function saveLinkedCard(supabase, userId, { customerId, paymentMethodId, brand, last4 } = {}) {
  if (!customerId) throw new TypeError('saveLinkedCard requires customerId');
  if (!paymentMethodId) throw new TypeError('saveLinkedCard requires paymentMethodId');
  const { tokens } = await readStripeTokens(supabase, userId);
  await writeStripeTokens(supabase, userId, {
    ...tokens,
    stripe_customer_id: customerId,
    default_payment_method_id: paymentMethodId,
    card_brand: brand || '',
    card_last4: last4 || ''
  }, { enabled: true });
}

module.exports = {
  STRIPE_CONNECTOR_ID,
  readStripeTokens,
  writeStripeTokens,
  getLinkedCard,
  saveLinkedCard
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/smoke/stripe-cards.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add api/services/stripe-cards.js test/smoke/stripe-cards.test.js
git commit -m "feat: add linked-card storage and idempotency keys for Stripe"
```

---

### Task 3: `stripe-cards.js` — Stripe Customer + SetupIntent creation

**Files:**
- Modify: `api/services/stripe-cards.js`
- Test: `test/smoke/stripe-cards.test.js`

**Interfaces:**
- Consumes: `readStripeTokens`, `writeStripeTokens` from Task 2 (same file).
- Produces: `getOrCreateStripeCustomer(stripe, supabase, userId) -> Promise<string>`,
  `createSetupIntentForUser(stripe, supabase, userId) -> Promise<{clientSecret, customerId}>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/smoke/stripe-cards.test.js`:

```js
const { getOrCreateStripeCustomer, createSetupIntentForUser } = require('../../api/services/stripe-cards');

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/smoke/stripe-cards.test.js`
Expected: FAIL — `getOrCreateStripeCustomer is not a function`

- [ ] **Step 3: Add the implementation**

Append to `api/services/stripe-cards.js` (before the `module.exports` block):

```js
async function getOrCreateStripeCustomer(stripe, supabase, userId) {
  const { tokens } = await readStripeTokens(supabase, userId);
  if (tokens.stripe_customer_id) return tokens.stripe_customer_id;
  const customer = await stripe.customers.create({ metadata: { oxy_user_id: userId } });
  await writeStripeTokens(supabase, userId, { ...tokens, stripe_customer_id: customer.id }, { enabled: false });
  return customer.id;
}

async function createSetupIntentForUser(stripe, supabase, userId) {
  const customerId = await getOrCreateStripeCustomer(stripe, supabase, userId);
  const setupIntent = await stripe.setupIntents.create({ customer: customerId, usage: 'off_session' });
  return { clientSecret: setupIntent.client_secret, customerId };
}
```

Update the `module.exports` block to also export `getOrCreateStripeCustomer` and
`createSetupIntentForUser`:

```js
module.exports = {
  STRIPE_CONNECTOR_ID,
  readStripeTokens,
  writeStripeTokens,
  getLinkedCard,
  saveLinkedCard,
  getOrCreateStripeCustomer,
  createSetupIntentForUser
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/smoke/stripe-cards.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add api/services/stripe-cards.js test/smoke/stripe-cards.test.js
git commit -m "feat: add Stripe customer + SetupIntent creation for card linking"
```

---

### Task 4: `stripe-cards.js` — off-session charge + SCA pending-state tracking

**Files:**
- Modify: `api/services/stripe-cards.js`
- Test: `test/smoke/stripe-cards.test.js`

**Interfaces:**
- Consumes: `getLinkedCard` (Task 2).
- Produces:
  - `resolveOffSessionChargeOutcome(paymentIntent) -> {status: 'succeeded'} | {status: 'requires_action', clientSecret} | {status: 'failed', error}`
  - `chargeLinkedCard(stripe, supabase, userId, {amountCents, currency, description, idempotencyKey}) -> Promise<{status: 'no_card'} | {status:'succeeded', paymentIntentId} | {status:'requires_action', paymentIntentId, clientSecret} | {status:'failed', paymentIntentId, error}>`
  - `PAYMENT_ACTION_REQUIRED_KEY` (string constant)
  - `setPaymentActionRequired(supabase, userId, {paymentIntentId, clientSecret, amountCents, description}) -> Promise<void>`
  - `getPaymentActionRequired(supabase, userId) -> Promise<object|null>`
  - `clearPaymentActionRequired(supabase, userId) -> Promise<void>`

- [ ] **Step 1: Write the failing tests**

Append to `test/smoke/stripe-cards.test.js`:

```js
const {
  resolveOffSessionChargeOutcome,
  chargeLinkedCard,
  setPaymentActionRequired,
  getPaymentActionRequired,
  clearPaymentActionRequired
} = require('../../api/services/stripe-cards');

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/smoke/stripe-cards.test.js`
Expected: FAIL — `resolveOffSessionChargeOutcome is not a function`

- [ ] **Step 3: Add the implementation**

The `fakeSupabase` from Task 2 needs `delete()` support for
`clearPaymentActionRequired`. Update the shared `fakeSupabase` helper at the top of
`test/smoke/stripe-cards.test.js` — replace its `from(table) { return { select() {...}, upsert() {...} }; }` body with:

```js
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
```

Append to `api/services/stripe-cards.js` (before `module.exports`):

```js
const PAYMENT_ACTION_REQUIRED_KEY = 'concierge_account.payment_action_required';

function resolveOffSessionChargeOutcome(paymentIntent) {
  if (paymentIntent.status === 'succeeded') return { status: 'succeeded' };
  if (paymentIntent.status === 'requires_action') {
    return { status: 'requires_action', clientSecret: paymentIntent.client_secret };
  }
  return {
    status: 'failed',
    error: paymentIntent.last_payment_error?.message || `Unexpected PaymentIntent status: ${paymentIntent.status}`
  };
}

async function chargeLinkedCard(stripe, supabase, userId, { amountCents, currency = 'gbp', description, idempotencyKey } = {}) {
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new TypeError('chargeLinkedCard requires a positive amountCents');
  }
  if (!idempotencyKey) throw new TypeError('chargeLinkedCard requires an idempotencyKey');

  const card = await getLinkedCard(supabase, userId);
  if (!card) return { status: 'no_card' };

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency,
    customer: card.customerId,
    payment_method: card.paymentMethodId,
    description,
    off_session: true,
    confirm: true,
    metadata: { oxy_user_id: userId }
  }, { idempotencyKey });

  const outcome = resolveOffSessionChargeOutcome(paymentIntent);
  return { ...outcome, paymentIntentId: paymentIntent.id };
}

async function setPaymentActionRequired(supabase, userId, { paymentIntentId, clientSecret, amountCents, description }) {
  await supabase.from('preferences').upsert({
    user_id: userId,
    key: PAYMENT_ACTION_REQUIRED_KEY,
    value: JSON.stringify({ paymentIntentId, clientSecret, amountCents, description, createdAt: new Date().toISOString() }),
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id,key' });
}

async function getPaymentActionRequired(supabase, userId) {
  const { data } = await supabase
    .from('preferences')
    .select('value')
    .eq('user_id', userId)
    .eq('key', PAYMENT_ACTION_REQUIRED_KEY)
    .maybeSingle();
  if (!data?.value) return null;
  try { return JSON.parse(data.value); } catch { return null; }
}

async function clearPaymentActionRequired(supabase, userId) {
  await supabase.from('preferences').delete().eq('user_id', userId).eq('key', PAYMENT_ACTION_REQUIRED_KEY);
}
```

Update `module.exports`:

```js
module.exports = {
  STRIPE_CONNECTOR_ID,
  PAYMENT_ACTION_REQUIRED_KEY,
  readStripeTokens,
  writeStripeTokens,
  getLinkedCard,
  saveLinkedCard,
  getOrCreateStripeCustomer,
  createSetupIntentForUser,
  resolveOffSessionChargeOutcome,
  chargeLinkedCard,
  setPaymentActionRequired,
  getPaymentActionRequired,
  clearPaymentActionRequired
};
```

Note the `preferences` table's `upsert` payload in the test fake's `matches` needs
`row.key`/`row.user_id`, which are already covered by the existing
`key = table === 'connectors' ? [...] : ['user_id', 'key']` branch — no further fake
changes needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/smoke/stripe-cards.test.js`
Expected: PASS (16 tests)

- [ ] **Step 5: Commit**

```bash
git add api/services/stripe-cards.js test/smoke/stripe-cards.test.js
git commit -m "feat: add off-session charging and SCA pending-state tracking"
```

---

### Task 5: `stripe-webhook.js` — resolve async SCA confirmations exactly once

**Files:**
- Create: `api/services/stripe-webhook.js`
- Test: `test/smoke/stripe-webhook.test.js`

**Interfaces:**
- Consumes: `getPaymentActionRequired`, `clearPaymentActionRequired` from
  `api/services/stripe-cards.js` (Task 4).
- Produces: `handleStripeWebhookEvent(supabase, event) -> Promise<{handled: boolean, userId?: string, outcome?: 'succeeded'|'failed', deducted?: boolean, reason?: string}>`

- [ ] **Step 1: Write the failing tests**

Create `test/smoke/stripe-webhook.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/smoke/stripe-webhook.test.js`
Expected: FAIL — `Cannot find module '../../api/services/stripe-webhook'`

- [ ] **Step 3: Write the implementation**

Create `api/services/stripe-webhook.js`:

```js
const { getPaymentActionRequired, clearPaymentActionRequired } = require('./stripe-cards');

async function getBalance(supabase, userId) {
  const { data } = await supabase
    .from('preferences')
    .select('value')
    .eq('user_id', userId)
    .eq('key', 'concierge_account.balance')
    .maybeSingle();
  return Number(data?.value || 0);
}

async function setBalance(supabase, userId, balance) {
  await supabase.from('preferences').upsert({
    user_id: userId,
    key: 'concierge_account.balance',
    value: String(balance),
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id,key' });
}

// The synchronous charge path (chargeLinkedCard, called from connectors/stripe.js)
// already deducts the balance when a charge succeeds immediately. This handler only
// needs to act when the charge was previously parked with requires_action (SCA) —
// i.e. when a payment_action_required record still points at this exact
// PaymentIntent id. Any other 'succeeded' event for a PaymentIntent already handled
// synchronously is an expected, harmless no-op here.
async function handleStripeWebhookEvent(supabase, event) {
  const type = event?.type;
  const pi = event?.data?.object || {};
  const userId = pi.metadata?.oxy_user_id;
  if (!userId) return { handled: false, reason: 'no oxy_user_id in PaymentIntent metadata' };

  if (type === 'payment_intent.succeeded') {
    const pending = await getPaymentActionRequired(supabase, userId);
    if (!pending || pending.paymentIntentId !== pi.id) {
      return { handled: true, userId, outcome: 'succeeded', deducted: false };
    }
    const amount = Number(pi.amount || 0) / 100;
    const balance = Math.max(0, Number((await getBalance(supabase, userId) - amount).toFixed(2)));
    await setBalance(supabase, userId, balance);
    await clearPaymentActionRequired(supabase, userId);
    return { handled: true, userId, outcome: 'succeeded', deducted: true };
  }

  if (type === 'payment_intent.payment_failed') {
    const pending = await getPaymentActionRequired(supabase, userId);
    if (pending && pending.paymentIntentId === pi.id) {
      await clearPaymentActionRequired(supabase, userId);
    }
    return { handled: true, userId, outcome: 'failed' };
  }

  return { handled: false, reason: `unhandled event type: ${type}` };
}

module.exports = { handleStripeWebhookEvent };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/smoke/stripe-webhook.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add api/services/stripe-webhook.js test/smoke/stripe-webhook.test.js
git commit -m "feat: resolve async SCA confirmations via Stripe webhook, deducting balance exactly once"
```

---

### Task 6: Honest review-card copy — "charge your card ending in 4242"

**Files:**
- Modify: `api/services/pending-review.js`
- Test: `test/smoke/pending-review.test.js`

**Interfaces:**
- Produces: `MONEY_ACTION_TYPES` (a `Set` export), `reviewDetailForAction(action, cardInfo = null)`,
  `buildPendingReviewResult(action, cardInfo = null)` — both existing exports gain an
  optional second parameter; existing single-argument call sites keep working
  unchanged (cardInfo defaults to `null`, which reproduces today's virtual-balance copy).

- [ ] **Step 1: Write the failing tests**

Append to `test/smoke/pending-review.test.js`:

```test/smoke/pending-review.test.js
const { MONEY_ACTION_TYPES } = require('../../api/services/pending-review');

test('MONEY_ACTION_TYPES covers every concierge-money action type', () => {
  assert.equal(MONEY_ACTION_TYPES.has('stripe_charge'), true);
  assert.equal(MONEY_ACTION_TYPES.has('spend_from_concierge_via_stripe'), true);
  assert.equal(MONEY_ACTION_TYPES.has('spend_from_concierge_account'), true);
});

test('review detail for a concierge spend with no linked card still shows the virtual-balance framing', () => {
  const detail = reviewDetailForAction({ type: 'spend_from_concierge_account', input: { amount: 25.5, description: 'dinner reservation' } });
  assert.equal(detail, 'Spend $25.50 from your concierge balance for dinner reservation.');
});

test('review detail for a concierge spend with a linked card shows the real card', () => {
  const detail = reviewDetailForAction(
    { type: 'spend_from_concierge_account', input: { amount: 25.5, description: 'dinner reservation' } },
    { brand: 'visa', last4: '4242' }
  );
  assert.equal(detail, 'Charge your visa card ending in 4242 $25.50 for dinner reservation.');
});

test('review detail for stripe_charge converts its amount from cents to dollars', () => {
  const detail = reviewDetailForAction(
    { type: 'stripe_charge', input: { amount: 2550, description: 'concierge spend' } },
    { brand: 'mastercard', last4: '1881' }
  );
  assert.equal(detail, 'Charge your mastercard card ending in 1881 $25.50 for concierge spend.');
});

test('buildPendingReviewResult threads cardInfo into the card text', () => {
  const result = buildPendingReviewResult(
    { type: 'spend_from_concierge_via_stripe', input: { amount: 10, description: 'gift' } },
    { brand: 'visa', last4: '4242' }
  );
  assert.equal(result.cardText, 'Charge your visa card ending in 4242 $10.00 for gift.');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/smoke/pending-review.test.js`
Expected: FAIL — `MONEY_ACTION_TYPES is not defined` / assertion mismatches on the
existing concierge-spend cases (there is no dedicated case for them yet — they
currently fall through to the generic `summarizeActionInput` default).

- [ ] **Step 3: Update the implementation**

In `api/services/pending-review.js`, add near the top (after `isPendingRevisionMessage`):

```js
const MONEY_ACTION_TYPES = new Set(['stripe_charge', 'spend_from_concierge_via_stripe', 'spend_from_concierge_account']);

function conciergeMoneyReviewDetail(action, cardInfo) {
  const input = action?.input || {};
  const isCents = action.type === 'stripe_charge';
  const rawAmount = Number(input.amount || 0);
  const amountUsd = isCents ? rawAmount / 100 : rawAmount;
  const amountStr = Number.isFinite(amountUsd) ? `$${amountUsd.toFixed(2)}` : 'this amount';
  const description = input.description || input.merchant || 'this purchase';
  if (cardInfo?.last4) {
    const brand = cardInfo.brand ? `${cardInfo.brand} ` : '';
    return `Charge your ${brand}card ending in ${cardInfo.last4} ${amountStr} for ${description}.`;
  }
  return `Spend ${amountStr} from your concierge balance for ${description}.`;
}
```

Change `reviewDetailForAction`'s signature and add a case for the money types:

```js
function reviewDetailForAction(action, cardInfo = null) {
  const input = action?.input || {};
  switch (action?.type) {
    case 'send_email':
    case 'send_outlook_email':
      return [input.to, input.subject, input.body].filter(Boolean).join(' · ');
    case 'create_github_issue':
      return [input.repo, input.title, input.body].filter(Boolean).join(' · ');
    case 'comment_github_issue':
      return [input.repo && input.issue_number ? `${input.repo}#${input.issue_number}` : (input.repo || ''), input.body].filter(Boolean).join(' · ');
    case 'create_linear_issue':
      return [input.team, input.title, input.description].filter(Boolean).join(' · ');
    case 'comment_linear_issue':
      return [input.issue, input.body].filter(Boolean).join(' · ');
    case 'send_message':
    case 'send_telegram':
      return [input.contact, input.message].filter(Boolean).join(' · ');
    case 'book_uber':
      return input.destination ? `Destination: ${input.destination}` : '';
    case 'create_calendar_event':
      return reviewCalendarDetail(input);
    case 'make_call':
      return input.contact ? `Contact: ${input.contact}` : '';
    case 'stripe_charge':
    case 'spend_from_concierge_via_stripe':
    case 'spend_from_concierge_account':
      return conciergeMoneyReviewDetail(action, cardInfo);
    default:
      return summarizeActionInput(input).replace(/^\s*\(|\)\s*$/g, '');
  }
}
```

Change `buildPendingReviewResult` to accept and thread `cardInfo`:

```js
function buildPendingReviewResult(action, cardInfo = null) {
  const contract = getActionContract(action?.type) || {};
  const prompt = action?.type === 'send_message'
    ? 'Check this, then send when ready.'
    : action?.type === 'send_email'
      ? 'Check this draft, then send when ready.'
      : `${reviewTitleForAction(action)}. Confirm to continue, or cancel to stop.`;
  return applyActionContractResultMetadata(action, {
    success: true,
    pending: true,
    text: prompt,
    cardText: reviewDetailForAction(action, cardInfo) || 'Ready for review.',
    actionSummary: reviewTitleForAction(action),
    risk: contract.risk || 'high',
    confirmation: 'review_required',
    executionMode: 'review'
  });
}
```

Add `MONEY_ACTION_TYPES` to `module.exports`:

```js
module.exports = {
  buildPendingReviewResult,
  isPendingCancelMessage,
  isPendingConfirmMessage,
  isPendingRevisionMessage,
  cleanCalendarTitle,
  formatCalendarDate,
  formatCalendarTime,
  reviewDetailForAction,
  reviewTitleForAction,
  MONEY_ACTION_TYPES
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/smoke/pending-review.test.js`
Expected: PASS (all tests, including the 5 new ones)

- [ ] **Step 5: Commit**

```bash
git add api/services/pending-review.js test/smoke/pending-review.test.js
git commit -m "feat: show real linked-card copy on concierge-money review cards"
```

---

### Task 7: Wire linked-card lookup into the action runner's review gate

**Files:**
- Modify: `api/services/action-runner.js`
- Modify: `api/index.js:2575` (the `createActionRunner({...})` call site)
- Test: `test/smoke/action-runner.test.js`

**Interfaces:**
- Consumes: `MONEY_ACTION_TYPES` from `api/services/pending-review.js` (Task 6),
  `getLinkedCard(supabase, userId)` from `api/services/stripe-cards.js` (Task 2).
- Produces: `createActionRunner` gains an optional `getLinkedCardInfo` dependency
  (defaults to `async () => null`, so every existing caller keeps working unchanged).

- [ ] **Step 1: Write the failing test**

Append to `test/smoke/action-runner.test.js`:

```js
test('action runner looks up the linked card for money actions and passes it into the review card', async () => {
  const pending = [];
  const lookups = [];
  const executeActions = createActionRunner({
    executeAction: async () => { throw new Error('should not execute before review'); },
    setPendingAction: async (userId, action, context) => pending.push({ userId, action, context }),
    getLinkedCardInfo: async (userId) => { lookups.push(userId); return { brand: 'visa', last4: '4242' }; },
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });

  const result = await executeActions('user-1', [
    { type: 'spend_from_concierge_account', input: { amount: 12, description: 'coffee' } }
  ], { userMessage: 'spend $12 on coffee' });

  assert.deepEqual(lookups, ['user-1']);
  assert.equal(result[0].result.cardText, 'Charge your visa card ending in 4242 $12.00 for coffee.');
});

test('action runner does not look up a linked card for non-money review actions', async () => {
  const lookups = [];
  const executeActions = createActionRunner({
    executeAction: async () => { throw new Error('should not execute before review'); },
    setPendingAction: async () => {},
    getLinkedCardInfo: async (userId) => { lookups.push(userId); return null; },
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });

  await executeActions('user-1', [
    { type: 'send_email', input: { to: 'josh@example.com', body: 'hi' } }
  ], { userMessage: 'email josh' });

  assert.deepEqual(lookups, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/smoke/action-runner.test.js`
Expected: FAIL — `result[0].result.cardText` equals the old virtual-balance copy
(`'Spend $12.00 from your concierge balance for coffee.'`) instead of the
card-aware copy, since `getLinkedCardInfo` is never called yet.

- [ ] **Step 3: Update the implementation**

In `api/services/action-runner.js`, add the import and the new dependency:

```js
const {
  applyActionContractResultMetadata,
  buildActionRecovery,
  getActionContract,
  validateActionWithContract
} = require('../action-contracts');
const { diagnoseConnectorIssue } = require('./connector-health');
const { buildPendingReviewResult, MONEY_ACTION_TYPES } = require('./pending-review');

function createActionRunner({
  executeAction,
  invalidateUserContextCache = () => {},
  logAction = async () => {},
  setPendingAction,
  validateAction = validateActionWithContract,
  getLinkedCardInfo = async () => null
}) {
```

Replace both `result = buildPendingReviewResult(action);` call sites (one in the
parallel branch, one in the sequential branch) with:

```js
          const cardInfo = MONEY_ACTION_TYPES.has(action.type) ? await getLinkedCardInfo(userId) : null;
          result = buildPendingReviewResult(action, cardInfo);
```

(Keep the surrounding `await setPendingAction(userId, action, context);` line exactly
as it is in both branches — only the `buildPendingReviewResult` line changes.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/smoke/action-runner.test.js`
Expected: PASS (all tests, including the 2 new ones)

- [ ] **Step 5: Wire the real dependency in `api/index.js`**

In `api/index.js`, at the `createActionRunner({...})` call (line 2575), add the
import and the new option:

```js
const { getLinkedCard } = require('./services/stripe-cards');
```

Add this near the top with the other `require('./services/...')` imports (after the
`token-crypto` import at line 84).

Then update the `createActionRunner` call:

```js
const executeActions = createActionRunner({
  executeAction,
  invalidateUserContextCache,
  setPendingAction,
  validateAction: validateActionWithContract,
  getLinkedCardInfo: (userId) => getLinkedCard(supabase, userId),
  logAction: (userId, action, result) => supabase.from('action_log').insert({
```

(Leave the rest of the `logAction` body and everything after it unchanged.)

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add api/services/action-runner.js api/index.js test/smoke/action-runner.test.js
git commit -m "feat: surface the real linked card on concierge-money review cards"
```

---

### Task 8: Rewire the real charge path onto `chargeLinkedCard`

**Files:**
- Modify: `connectors/stripe.js`
- Test: `test/smoke/stripe-connector.test.js` (new)

**Interfaces:**
- Consumes: `chargeLinkedCard`, `setPaymentActionRequired` from
  `api/services/stripe-cards.js`.
- Produces: `spend_from_concierge_via_stripe` now performs a real off-session charge
  against the linked card instead of an unconfirmed, un-owned PaymentIntent.

- [ ] **Step 1: Write the failing tests**

Create `test/smoke/stripe-connector.test.js`:

```js
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
```

Note: `connectors/stripe.js` constructs its Supabase client from environment at
`require`-time (`createSupabaseServiceClient()`), which the rest of this codebase's
smoke tests already avoid depending on directly (there is no existing
`connectors/stripe.test.js`). This task keeps that limitation and only adds a
regression check on the cap logic that backs the rewritten handler; the full
charge/no_card/requires_action branches inside `connectors/stripe.js` are exercised
indirectly through `test/smoke/stripe-cards.test.js`'s `chargeLinkedCard` tests
(Task 4), which cover the exact same logic the handler now delegates to.

- [ ] **Step 2: Run the test to verify it passes as a baseline**

Run: `node --test test/smoke/stripe-connector.test.js`
Expected: PASS (this test doesn't depend on the rewrite yet — it's a baseline
regression guard, added now so it's in place before the rewrite below).

- [ ] **Step 3: Rewrite `spend_from_concierge_via_stripe` in `connectors/stripe.js`**

Replace the file's `require`s at the top:

```js
const crypto = require('crypto');
const axios = require('axios');
const { createSupabaseServiceClient } = require('../runtime');
const { decryptTokens } = require('../api/services/token-crypto');
const { guardConciergeSpend } = require('../api/services/concierge-spend-guard');
const { chargeLinkedCard, setPaymentActionRequired } = require('../api/services/stripe-cards');
```

Replace the body of the `if (action === 'spend_from_concierge_via_stripe') { ... }`
block inside `execute()` with:

```js
    if (action === 'spend_from_concierge_via_stripe') {
      const amountCents = Math.round((params.amount || 10) * 100);
      const desc = params.description || 'Concierge spend';
      // dispatch()/execute() (connectors/index.js:60) has no request-identity or
      // pendingAction context to build a stable per-approval idempotency key from
      // (unlike api/index.js's own pendingKey at line 5656) — threading that through
      // would mean changing every connector's execute(userId, action, params)
      // signature, out of scope here. A fresh random key per call is still correct:
      // it only needs to keep this process's own Stripe calls from colliding (e.g.
      // two separate $10 "coffee" spends on the same day must NOT reuse a key, or
      // Stripe would silently replay the first charge's result for the second). The
      // thing that actually prevents one *approval* from executing twice — including
      // across two Cloud Run instances racing the same confirm request — is the
      // atomic claimPendingAction compare-and-delete upstream (api/index.js:3021),
      // which already guarantees at most one call reaches this function per approval.
      const idempotencyKey = crypto.randomUUID();

      const stripeSdk = require('stripe')(key);
      const outcome = await chargeLinkedCard(stripeSdk, supabase, userId, {
        amountCents, currency: 'gbp', description: desc, idempotencyKey
      });

      if (outcome.status === 'no_card') {
        return { success: false, error: 'No card linked yet. Link a card in Payments settings to spend for real.' };
      }
      if (outcome.status === 'failed') {
        return { success: false, error: `Stripe charge failed: ${outcome.error}` };
      }
      if (outcome.status === 'requires_action') {
        await setPaymentActionRequired(supabase, userId, {
          paymentIntentId: outcome.paymentIntentId, clientSecret: outcome.clientSecret, amountCents, description: desc
        });
        return {
          success: true,
          text: `This charge needs you to re-authenticate your card — check Today for a prompt to confirm it.`,
          requiresAction: true,
          paymentIntentId: outcome.paymentIntentId
        };
      }

      // outcome.status === 'succeeded': deduct the tracked balance immediately. The
      // Stripe webhook (api/services/stripe-webhook.js) is a no-op for this same
      // PaymentIntent since no payment_action_required record was ever written for it.
      const { data } = await supabase.from('preferences').select('value').eq('user_id', userId).eq('key', 'concierge_account.balance');
      let balance = Number(data?.[0]?.value || 0);
      const amount = amountCents / 100;
      if (balance >= amount) balance -= amount;
      balance = Number(balance.toFixed(2));
      await supabase.from('preferences').upsert({ user_id: userId, key: 'concierge_account.balance', value: balance });
      return {
        success: true,
        text: `Charged $${amount.toFixed(2)} (${desc}) to your linked card. Balance updated to $${balance.toFixed(2)}.`,
        paymentIntentId: outcome.paymentIntentId,
        balance
      };
    }
```

(Leave `create_stripe_payment_link` and `stripe_payout_to_user` untouched — they're
explicitly out of scope per the design doc.)

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add connectors/stripe.js test/smoke/stripe-connector.test.js
git commit -m "feat: charge the real linked card for spend_from_concierge_via_stripe"
```

---

### Task 9: Card-linking and webhook HTTP routes

**Files:**
- Modify: `api/index.js`

**Interfaces:**
- Consumes: `createSetupIntentForUser`, `saveLinkedCard` from
  `api/services/stripe-cards.js`; `handleStripeWebhookEvent` from
  `api/services/stripe-webhook.js`; `requireSessionAuth`, `getAuthenticatedUserId`
  from `../auth` (already imported at `api/index.js:66-73`).
- Produces: `POST /connectors/stripe/setup-intent`, `POST /connectors/stripe/confirm`,
  `POST /webhooks/stripe`.

This task has no automated test — it's thin route wiring over already-tested service
functions, matching the existing convention for OAuth routes in this file (the
Google/Microsoft callback routes above have no dedicated tests either). Verify with
the manual curl steps below instead.

- [ ] **Step 1: Add the Stripe SDK client and new imports**

Near the top of `api/index.js`, after the `const { encryptTokens } = require('./services/token-crypto');` line (84), add:

```js
const { createSetupIntentForUser, saveLinkedCard, getLinkedCard } = require('./services/stripe-cards');
const { handleStripeWebhookEvent } = require('./services/stripe-webhook');

const stripeClient = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
```

(`getLinkedCard` here is the same import added in Task 7 Step 5 — if that step
already added it, just add `createSetupIntentForUser` and `saveLinkedCard` to the
same `require` line instead of duplicating it.)

- [ ] **Step 2: Add the webhook route BEFORE `app.use(express.json())`**

Stripe's signature verification needs the raw request body, but
`app.use(express.json())` at line 211 parses every request body globally. Insert the
webhook route between the `app.use(cors({...}))` block (ends line 210) and
`app.use(express.json());` (line 211):

```js
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripeClient || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).json({ error: 'Stripe webhook is not configured on the server.' });
  }
  let event;
  try {
    event = stripeClient.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('/webhooks/stripe signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }
  try {
    const result = await handleStripeWebhookEvent(supabase, event);
    res.json({ received: true, ...result });
  } catch (err) {
    console.error('/webhooks/stripe handling error:', err.message);
    res.status(500).json({ error: 'Webhook handling failed' });
  }
});

app.use(express.json());
```

(Replace the existing standalone `app.use(express.json());` line 211 with the block
above — the webhook route now sits immediately before it.)

- [ ] **Step 3: Add the card-linking routes**

Add these routes near the other `/agent/*` routes (after the `/agent/recipes/:id/execute` block, or anywhere alongside the other `requireSessionAuth`-protected routes):

```js
app.post('/connectors/stripe/setup-intent', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!stripeClient) return res.status(500).json({ error: 'Stripe is not configured on the server.' });
  try {
    const { clientSecret, customerId } = await createSetupIntentForUser(stripeClient, supabase, userId);
    res.json({ clientSecret, customerId, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/connectors/stripe/confirm', requireSessionAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!stripeClient) return res.status(500).json({ error: 'Stripe is not configured on the server.' });
  const { setupIntentId } = req.body || {};
  if (!setupIntentId) return res.status(400).json({ error: 'setupIntentId required' });
  try {
    const setupIntent = await stripeClient.setupIntents.retrieve(setupIntentId, { expand: ['payment_method'] });
    if (setupIntent.status !== 'succeeded') {
      return res.status(400).json({ error: `SetupIntent is not confirmed yet (status: ${setupIntent.status})` });
    }
    const pm = setupIntent.payment_method;
    await saveLinkedCard(supabase, userId, {
      customerId: setupIntent.customer,
      paymentMethodId: pm.id,
      brand: pm.card?.brand || '',
      last4: pm.card?.last4 || ''
    });
    const card = await getLinkedCard(supabase, userId);
    res.json({ linked: true, card });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, no regressions (these routes have no unit tests, but nothing they
touch should break existing ones — `node --check api/index.js` is worth running too
since this file has no test importing it directly).

Run: `node --check api/index.js`
Expected: no syntax errors printed.

- [ ] **Step 5: Manual smoke test (requires a real STRIPE_SECRET_KEY in test mode)**

This step can't run in CI — it needs a live (test-mode) Stripe key and a running
server. Do it once locally before considering this task done:

```bash
# with STRIPE_SECRET_KEY (test mode) set, and the server running locally:
curl -s -X POST http://localhost:8080/connectors/stripe/setup-intent \
  -H "Authorization: Bearer <a valid session token>" | jq
# Expected: {"clientSecret":"seti_..._secret_...","customerId":"cus_...","publishableKey":""}
```

Confirming the SetupIntent with a real card and calling `/connectors/stripe/confirm`
requires Stripe's client-side JS/iOS SDK to reach `succeeded` status first — that's
the iOS card-linking work, out of scope for this plan. The setup-intent endpoint
above is enough to confirm the server-side half is wired correctly.

- [ ] **Step 6: Commit**

```bash
git add api/index.js
git commit -m "feat: add Stripe card-linking and webhook HTTP routes"
```

---

### Task 10: Full suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS, all tests including every test added in Tasks 2–8.

- [ ] **Step 2: Run the release check**

Run: `npm run release:check`
Expected: PASS — `node --check api/index.js`, `node --check api/services/context-brain.js`,
and the full smoke suite all succeed.

- [ ] **Step 3: Confirm no stray console output or TODOs were left**

Run: `grep -rn "TODO\|FIXME" api/services/stripe-cards.js api/services/stripe-webhook.js connectors/stripe.js`
Expected: no output.

No commit for this task — it's a checkpoint, not a change.

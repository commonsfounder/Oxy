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

async function unlinkCard(supabase, userId) {
  const { tokens } = await readStripeTokens(supabase, userId);
  await writeStripeTokens(supabase, userId, {
    ...tokens,
    default_payment_method_id: '',
    card_brand: '',
    card_last4: ''
  }, { enabled: false });
}

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

async function setPaymentActionRequired(supabase, userId, { paymentIntentId, clientSecret, amountCents, description, currency }) {
  await supabase.from('preferences').upsert({
    user_id: userId,
    key: PAYMENT_ACTION_REQUIRED_KEY,
    value: JSON.stringify({ paymentIntentId, clientSecret, amountCents, description, currency, createdAt: new Date().toISOString() }),
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

// Atomically claims a pending payment_action_required record for a given
// PaymentIntent id, so a webhook event that is redelivered (Stripe uses
// at-least-once delivery) cannot resolve the same SCA charge twice. Reads the
// raw stored row, then deletes it only if the value column still matches
// exactly what was read (compare-and-delete) — mirroring claimPendingAction
// in api/index.js. Only the caller whose delete actually removed a row (i.e.
// data.length > 0) "wins" the claim; a redelivered/concurrent event that
// arrives after the row is already gone gets false and must not deduct.
async function claimPaymentActionRequired(supabase, userId, paymentIntentId) {
  const { data: row } = await supabase
    .from('preferences')
    .select('value')
    .eq('user_id', userId)
    .eq('key', PAYMENT_ACTION_REQUIRED_KEY)
    .maybeSingle();
  if (!row?.value) return false;
  let parsed;
  try { parsed = JSON.parse(row.value); } catch { return false; }
  if (!parsed || parsed.paymentIntentId !== paymentIntentId) return false;

  const { data, error } = await supabase
    .from('preferences')
    .delete()
    .eq('user_id', userId)
    .eq('key', PAYMENT_ACTION_REQUIRED_KEY)
    .eq('value', row.value)
    .select('value');
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}

module.exports = {
  STRIPE_CONNECTOR_ID,
  PAYMENT_ACTION_REQUIRED_KEY,
  readStripeTokens,
  writeStripeTokens,
  getLinkedCard,
  saveLinkedCard,
  unlinkCard,
  getOrCreateStripeCustomer,
  createSetupIntentForUser,
  resolveOffSessionChargeOutcome,
  chargeLinkedCard,
  setPaymentActionRequired,
  getPaymentActionRequired,
  clearPaymentActionRequired,
  claimPaymentActionRequired
};

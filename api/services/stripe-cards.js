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

module.exports = {
  STRIPE_CONNECTOR_ID,
  readStripeTokens,
  writeStripeTokens,
  getLinkedCard,
  saveLinkedCard,
  getOrCreateStripeCustomer,
  createSetupIntentForUser
};

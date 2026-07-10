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

const { getPaymentActionRequired, clearPaymentActionRequired, claimPaymentActionRequired } = require('./stripe-cards');

// The webhook only settles the pending SCA checkpoint; Stripe's own receipts and intent ids are
// authoritative. Delivery is at-least-once, so claimPaymentActionRequired compare-and-deletes
// the pending record: only the delivery that removes the row deducts. A racing second delivery
// sees it gone and reports deducted:false, the same as "nothing was pending" — correct either way.
async function handleStripeWebhookEvent(supabase, event) {
  const type = event?.type;
  const pi = event?.data?.object || {};
  const userId = pi.metadata?.oxy_user_id;
  if (!userId) return { handled: false, reason: 'no oxy_user_id in PaymentIntent metadata' };

  if (type === 'payment_intent.succeeded') {
    const claimed = await claimPaymentActionRequired(supabase, userId, pi.id);
    if (!claimed) {
      return { handled: true, userId, outcome: 'succeeded', deducted: false };
    }
    return { handled: true, userId, outcome: 'succeeded', settled: true, deducted: false };
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

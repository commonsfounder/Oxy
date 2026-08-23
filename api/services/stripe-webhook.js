const { getPaymentActionRequired, clearPaymentActionRequired, claimPaymentActionRequired } = require('./stripe-cards');

// The webhook only settles the pending SCA checkpoint. Stripe receipts and payment
// intent ids are authoritative; there is no local concierge balance to maintain.
//
// Stripe delivers webhooks at-least-once, so the same payment_intent.succeeded
// event can arrive twice (redelivery, slow 2xx, etc). claimPaymentActionRequired
// does an atomic compare-and-delete on the pending record: only the delivery that
// actually removes the row "wins" the claim and deducts the balance. A second,
// racing delivery for the same PaymentIntent finds the row already gone and
// reports deducted: false — indistinguishable here from "nothing was pending",
// which is the correct behavior either way (don't deduct).
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

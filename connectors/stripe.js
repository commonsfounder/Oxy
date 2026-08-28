const crypto = require('crypto');
const axios = require('axios');
const { createSupabaseServiceClient } = require('../runtime');
const { decryptTokens } = require('../api/services/token-crypto');
const { guardConciergeSpend } = require('../api/services/concierge-spend-guard');
const { chargeLinkedCard, setPaymentActionRequired } = require('../api/services/stripe-cards');
const { resolveCurrencyForLocation } = require('../api/services/currency-from-location');

const supabase = createSupabaseServiceClient();

// Actions here that move money out, which must respect both the per-transaction and the rolling
// daily cap even post-approval — guardConciergeSpend applies both. Receiving money is exempt.
// stripe_charge is handled inline in api/index.js ahead of dispatch and never reaches this file.
const SPEND_ACTIONS = new Set(['spend_from_concierge_via_stripe', 'stripe_payout_to_user']);

async function getStripeKey(userId) {
  try {
    const { data } = await supabase
      .from('connectors')
      .select('tokens')
      .eq('user_id', userId)
      .eq('connector_id', 'stripe')
      .eq('enabled', true)
      .limit(1);
    if (data?.length > 0 && data[0].tokens) {
      const tokens = decryptTokens(data[0].tokens);
      return tokens.secret_key || process.env.STRIPE_SECRET_KEY;
    }
  } catch (e) {}
  return process.env.STRIPE_SECRET_KEY || null;
}

async function stripeRequest(key, method, path, data = null) {
  const url = `https://api.stripe.com/v1${path}`;
  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  };
  const config = { headers };
  if (data) {
    const params = new URLSearchParams();
    Object.entries(data).forEach(([k, v]) => params.append(k, v));
    if (method === 'get') config.params = params;
    else config.data = params;
  }
  const res = await axios({ method, url, ...config });
  return res.data;
}

async function execute(userId, action, params) {
  // Hard per-transaction + rolling-daily ceiling before any real Stripe call — independent of
  // the model and of whether the review gate was bypassed.
  if (SPEND_ACTIONS.has(action)) {
    const dollars = Number(params?.amount || 0);
    const verdict = await guardConciergeSpend(supabase, userId, dollars);
    if (!verdict.ok) return { success: false, error: verdict.error };
  }

  const key = await getStripeKey(userId);
  if (!key) {
    return {
      success: false,
      outcome: 'unavailable',
      unavailable: true,
      error: `Stripe ${action} is unavailable because no payment rail is configured. No money moved.`
    };
  }

  const currency = resolveCurrencyForLocation(params?.location);

  try {
    if (action === 'create_stripe_payment_link') {
      const amount = Math.round((params.amount || 10) * 100);
      const product = await stripeRequest(key, 'post', '/products', { name: params.description || 'Concierge Service' });
      const price = await stripeRequest(key, 'post', '/prices', {
        product: product.id,
        unit_amount: amount,
        currency
      });
      const link = await stripeRequest(key, 'post', '/payment_links', {
        line_items: [{ price: price.id, quantity: 1 }],
        after_completion: { type: 'redirect', redirect: { url: 'https://yourapp.com/thanks' } }
      });
      return { success: true, text: `Real Stripe Payment Link created for $${(amount/100).toFixed(2)}. Share or use to receive into account.`, webLink: link.url };
    }

    if (action === 'spend_from_concierge_via_stripe') {
      const amountCents = Math.round((params.amount || 10) * 100);
      const desc = params.description || 'Concierge spend';
      // A fresh random idempotency key per call: execute() has no per-approval context to build
      // a stable one from, and this only needs to keep two genuinely separate spends from
      // sharing a key. What stops one approval executing twice is claimPendingAction upstream.
      const idempotencyKey = crypto.randomUUID();

      const stripeSdk = require('stripe')(key);
      const outcome = await chargeLinkedCard(stripeSdk, supabase, userId, {
        amountCents, currency, description: desc, idempotencyKey
      });

      if (outcome.status === 'no_card') {
        return { success: false, error: 'No card linked yet. Link a card in Payments settings to spend for real.' };
      }
      if (outcome.status === 'failed') {
        return { success: false, error: `Stripe charge failed, so nothing was spent: ${outcome.error}` };
      }
      if (outcome.status === 'requires_action') {
        await setPaymentActionRequired(supabase, userId, {
          paymentIntentId: outcome.paymentIntentId, clientSecret: outcome.clientSecret, amountCents, description: desc, currency
        });
        return {
          success: false,
          outcome: 'awaiting_user',
          pending: true,
          text: `This charge needs you to re-authenticate your card — check Today for a prompt to confirm it.`,
          requiresAction: true,
          paymentIntentId: outcome.paymentIntentId
        };
      }

      const amount = amountCents / 100;
      return {
        success: true,
        text: `Charged $${amount.toFixed(2)} (${desc}) to your linked card.`,
        paymentIntentId: outcome.paymentIntentId
      };
    }

    if (action === 'stripe_payout_to_user') {
      const amount = Math.round((params.amount || 50) * 100);
      // Payouts require Stripe Connect or balance. For demo: create a transfer if account set.
      const transfer = await stripeRequest(key, 'post', '/transfers', {
        amount,
        currency,
        destination: params.destination || 'acct_xxx', // needs connected account
        description: params.description || 'Payout from concierge'
      });
      return { success: true, text: `Stripe payout of $${(amount/100).toFixed(2)} initiated.`, transfer };
    }

    return { success: false, error: 'Unknown Stripe action' };
  } catch (e) {
    return { success: false, error: `Stripe error: ${e.response?.data?.error?.message || e.message}` };
  }
}

module.exports = { execute };

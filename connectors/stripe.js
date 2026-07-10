const crypto = require('crypto');
const axios = require('axios');
const { createSupabaseServiceClient } = require('../runtime');
const { decryptTokens } = require('../api/services/token-crypto');
const { guardConciergeSpend } = require('../api/services/concierge-spend-guard');
const { chargeLinkedCard, setPaymentActionRequired } = require('../api/services/stripe-cards');
const { resolveCurrencyForLocation } = require('../api/services/currency-from-location');

const supabase = createSupabaseServiceClient();

// Actions on this connector that move money OUT and must respect the hard per-transaction AND
// rolling-daily caps, even when reached post-approval (bypassReview). Receiving money (payment
// links) is exempt. Regression: this used to call checkSpendLimit directly with no spentToday,
// so these enforced the per-transaction cap but silently skipped the daily one — a repeat spend
// action here could blow straight past OXY_MAX_SPEND_PER_DAY. guardConciergeSpend (shared with
// api/index.js) applies both.
// stripe_charge is handled inline in api/index.js, ahead of dispatch — it never reaches this
// file, so there is no branch for it here.
const SPEND_ACTIONS = new Set(['spend_from_concierge_via_stripe', 'stripe_payout_to_user']);

const SUPPORTED_ACTIONS = ['stripe_payout_to_user', 'create_stripe_payment_link', 'spend_from_concierge_via_stripe'];

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
    return { success: true, text: `Stripe ${action} - add your STRIPE_SECRET_KEY for real payments. Falling back to concierge account simulation.`, webLink: 'https://stripe.com' };
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

module.exports = { SUPPORTED_ACTIONS, execute };
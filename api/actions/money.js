'use strict';

// Money actions, lifted out of the switch in api/index.js.
//
// The stripe-cards helpers are destructured rather than property-accessed: their tests
// exercise the service directly with injected clients rather than monkey-patching the
// shared module object, so there is nothing here to keep resolvable at call time.

const crypto = require('crypto');
const { escapeIlikePattern } = require('../lib/text');
const receipts = require('../services/receipts');
const { chargeLinkedCard, setPaymentActionRequired } = require('../services/stripe-cards');
const { resolveCurrencyForLocation } = require('../services/currency-from-location');
const { buildCleanupQuery } = require('../services/gmail-cleanup');

// No virtual concierge ledger exists. Real money actions use Stripe or remain unavailable.
async function checkConciergeBalance({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, dispatch, stripeClient, guardConciergeSpend } = deps;
  return { success: false, outcome: 'unavailable', unavailable: true, error: 'No real concierge balance is connected.' };
}

async function spendFromConciergeAccount({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, dispatch, stripeClient, guardConciergeSpend } = deps;
  const amount = Number(params?.amount || 0);
  const description = params?.description || 'purchase';
  const merchant = params?.merchant || 'unknown';
  if (amount <= 0) return { success: false, error: 'Invalid amount' };
  const spendGuard = await guardConciergeSpend(userId, amount);
  if (!spendGuard.ok) return { success: false, error: spendGuard.error };
  if (!stripeClient) {
    return { success: false, outcome: 'unavailable', unavailable: true, error: 'Real concierge spending is unavailable until a payment rail is configured. No money moved.' };
  }

  const idempotencyKey = crypto.randomUUID();
  const currency = resolveCurrencyForLocation(context.location);
  const outcome = await chargeLinkedCard(stripeClient, supabase, userId, {
    amountCents: Math.round(amount * 100), currency, description: `${description} at ${merchant}`, idempotencyKey
  });

  if (outcome.status === 'no_card') {
    return { success: false, error: 'No card linked yet. Link a card in Payments settings to spend for real.' };
  }
  if (outcome.status === 'failed') {
    return { success: false, error: `Stripe charge failed, so nothing was spent: ${outcome.error}` };
  }
  if (outcome.status === 'requires_action') {
    await setPaymentActionRequired(supabase, userId, {
      paymentIntentId: outcome.paymentIntentId, clientSecret: outcome.clientSecret,
      amountCents: Math.round(amount * 100), description: `${description} at ${merchant}`, currency
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

  return { success: true, text: `Charged $${amount.toFixed(2)} on ${description} at ${merchant} to your linked card.`, paymentIntentId: outcome.paymentIntentId };
}

async function topUpConciergeAccount({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, dispatch, stripeClient, guardConciergeSpend } = deps;
  const amount = Number(params?.amount || 0);
  if (amount <= 0) return { success: false, error: 'Invalid amount' };
  return { success: false, outcome: 'unavailable', unavailable: true, error: 'Concierge top-ups are unavailable until a real payment rail is configured. No balance was changed.', amount };
}

async function receiveToConciergeAccount({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, dispatch, stripeClient, guardConciergeSpend } = deps;
  const amount = Number(params?.amount || 0);
  const description = params?.description || 'payment';
  if (amount <= 0) return { success: false, error: 'Invalid amount' };
  return { success: false, outcome: 'unavailable', unavailable: true, error: `Receiving ${description} is unavailable until a real payment rail is configured. No balance was changed.`, amount };
}

async function fundOpportunity({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, dispatch, stripeClient, guardConciergeSpend } = deps;
  const amount = Number(params?.amount || 0);
  const opportunity = params?.opportunity || 'opportunity';
  if (amount <= 0) return { success: false, error: 'Invalid amount' };
  const fundGuard = await guardConciergeSpend(userId, amount);
  if (!fundGuard.ok) return { success: false, error: fundGuard.error };
  return { success: false, outcome: 'unavailable', unavailable: true, error: `Funding "${opportunity}" is unavailable until a real payment rail is configured. No balance was changed.`, amount };
}

async function stripeCharge({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, dispatch, stripeClient, guardConciergeSpend } = deps;
  const amountCents = Number(params?.amount || 1000);
  const desc = params?.description || 'Concierge spend';
  const amount = amountCents / 100;
  const chargeGuard = await guardConciergeSpend(userId, amount);
  if (!chargeGuard.ok) return { success: false, error: chargeGuard.error };
  if (!stripeClient) {
    return { success: false, outcome: 'unavailable', unavailable: true, error: `Stripe is not configured, so no charge was attempted for ${desc}.`, amount };
  }

  const idempotencyKey = crypto.randomUUID();
  const currency = resolveCurrencyForLocation(context.location);
  const outcome = await chargeLinkedCard(stripeClient, supabase, userId, {
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

  return { success: true, text: `Stripe charged $${amount.toFixed(2)} (${desc}) to your linked card.`, amount, paymentIntentId: outcome.paymentIntentId };
}

// Spend and receipts. Two real sources only — receipts in the connected mailbox, and
// orders this system actually placed and saw confirmed. There is no bank feed, and the
// summary text says so every time rather than implying completeness.
async function findSpend({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, dispatch, stripeClient, guardConciergeSpend } = deps;
  const merchantFilter = String(params?.merchant || '').trim();
  const since = String(params?.since || '').trim();
  const before = String(params?.before || '').trim();
  const categoryQuery = String(params?.category || '').trim().toLowerCase();
  const textQuery = String(params?.query || '').trim();
  const sources = String(params?.sources || 'all').trim().toLowerCase();
  const wantEmail = sources !== 'millie';
  const wantMillie = sources !== 'email';
  const cap = Math.max(1, Math.min(Number(params?.max_results) || 60, 150));

  let emailSearched = false;
  let emailError = '';
  let scanned = 0;
  let skipped = 0;

  if (wantEmail) {
    // A receipt-shaped Gmail query, then the real extractor decides — the query narrows
    // what is fetched, it is not itself the classifier.
    const terms = ['receipt', 'invoice', '"order confirmation"', '"your order"', '"payment received"', '"thanks for your order"', 'refund'];
    const parts = [`{${terms.join(' ')}}`];
    if (merchantFilter) parts.push(`(from:${merchantFilter} OR "${merchantFilter}")`);
    else if (textQuery) parts.push(`"${textQuery.replace(/"/g, '')}"`);
    const sinceToken = buildCleanupQuery({ since }).match(/after:(\S+)/)?.[1];
    const beforeToken = buildCleanupQuery({ before }).match(/before:(\S+)/)?.[1];
    if (sinceToken) parts.push(`after:${sinceToken}`);
    if (beforeToken) parts.push(`before:${beforeToken}`);

    const searchResult = await dispatch(userId, 'search_emails', { query: parts.join(' '), max_results: cap });
    if (searchResult?.success) {
      emailSearched = true;
      const emails = searchResult.emails || [];
      scanned = emails.length;
      for (const email of emails) {
        const extracted = receipts.extractReceipt(email);
        if (!extracted) { skipped += 1; continue; }
        // Persisting normalized records is what makes a second "find that receipt" fast
        // and lets a purchase be recognised later without re-mining the mailbox. The
        // dedupe indexes make a rescan idempotent rather than double-counting.
        const row = {
          source: extracted.source,
          merchant: extracted.merchant,
          merchant_domain: extracted.merchantDomain,
          purchased_at: extracted.purchasedAt,
          total_amount: extracted.totalAmount,
          currency: extracted.currency,
          order_id: extracted.orderId,
          description: extracted.description,
          items: extracted.items?.length ? extracted.items : null,
          status: extracted.status,
          refund_amount: extracted.refundAmount,
          tracking_url: extracted.trackingUrl,
          source_ref: extracted.sourceRef,
          source_thread_id: extracted.sourceThreadId,
          raw_total_text: extracted.rawTotalText,
          extraction_confidence: extracted.extractionConfidence,
          updated_at: new Date().toISOString()
        };
        // upsertPurchase, not a raw upsert: both dedupe indexes are partial, which
        // Postgres will not accept as an ON CONFLICT target. It also folds a second
        // document about an order already on file (shipping note, refund) into that
        // record instead of counting the order twice.
        await receipts.upsertPurchase(supabase, userId, row);
      }
    } else {
      emailError = searchResult?.error || 'your mailbox was unreachable';
    }
  }

  let query = supabase.from('purchases').select('*').eq('user_id', userId);
  if (!wantEmail) query = query.eq('source', 'millie_browser');
  if (!wantMillie) query = query.eq('source', 'email_receipt');
  if (merchantFilter) query = query.ilike('merchant', `%${escapeIlikePattern(merchantFilter)}%`);
  // "What did that sock order cost?" is not a merchant question — the only thing the user
  // remembers is what the thing was, which lives in the description (Millie's own order
  // goal) or the receipt's subject line. Without this, a real recorded order was
  // unfindable by the most natural way to ask about it.
  if (textQuery) {
    const safe = escapeIlikePattern(textQuery);
    query = query.or(`merchant.ilike.%${safe}%,description.ilike.%${safe}%`);
  }
  if (since && !Number.isNaN(Date.parse(since))) query = query.gte('purchased_at', new Date(since).toISOString());
  if (before && !Number.isNaN(Date.parse(before))) query = query.lte('purchased_at', new Date(before).toISOString());
  const { data, error } = await query.order('purchased_at', { ascending: false }).limit(cap);
  if (error) return { success: false, error: error.message };

  let items = data || [];
  let unclassified = 0;
  if (categoryQuery) {
    const kept = [];
    for (const purchase of items) {
      const verdict = receipts.classifyCategory(purchase.merchant, purchase.description);
      if (verdict.confident && verdict.category === categoryQuery) kept.push(purchase);
      else if (!verdict.confident) unclassified += 1;
    }
    items = kept;
  }

  return {
    success: true,
    purchases: items.map(p => ({
      id: p.id,
      merchant: p.merchant,
      amount: p.total_amount,
      currency: p.currency,
      purchasedAt: p.purchased_at,
      orderId: p.order_id,
      description: p.description,
      items: p.items || [],
      status: p.status,
      source: p.source,
      threadId: p.source_thread_id,
      messageId: p.source === 'email_receipt' ? p.source_ref : null,
      trackingUrl: p.tracking_url,
      observedTotalText: p.raw_total_text,
      confidence: p.extraction_confidence
    })),
    summary: receipts.summarizeSpend(items),
    coverage: {
      emailSearched,
      emailError: emailError || null,
      emailsScanned: scanned,
      emailsWithoutUsableReceipt: skipped,
      bankFeed: false
    },
    lines: items.slice(0, 12).map(receipts.formatPurchaseLine),
    text: receipts.formatSpendSummary(items, {
      since, merchant: merchantFilter,
      sources: wantEmail ? ['email_receipt', 'millie_browser'] : ['millie_browser'],
      emailSearched: wantEmail ? emailSearched : true,
      emailError, unclassified, categoryQuery
    })
  };
}

module.exports = {
  handlers: {
    check_concierge_balance: checkConciergeBalance,
    spend_from_concierge_account: spendFromConciergeAccount,
    top_up_concierge_account: topUpConciergeAccount,
    receive_to_concierge_account: receiveToConciergeAccount,
    fund_opportunity: fundOpportunity,
    stripe_charge: stripeCharge,
    find_spend: findSpend
  }
};

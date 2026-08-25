'use strict';

// Browser and web actions, lifted out of the switch in api/index.js.
//
// browserTask is required as an object and called as a property, never destructured: the
// ordering tests monkey-patch browserTask.runOrderingTurn on the shared module object, and
// that substitution only lands while the call site resolves the property at call time.
//
// The model boundary (generateBrain/webSearchBrain) arrives through deps because the
// orchestration tests mock it by intercepting index.js's require of brain-provider.

const axios = require('axios');
const { getLocalDateKey } = require('../lib/time');
const { detectCurrency } = require('../services/money-guard');
const { getAgentCardSummary } = require('../services/agent-card');
const browserTask = require('../services/browser-task');

// Real browser ordering (api/services/browser-task.js) — actually runs Playwright,
// recipes, the Shopify platform-API tier, and the vision-driven fallback loop. Was
// built across many sessions but never wired into a live action before this case
// existed — see [[browser-task-reliability]] memory. Never auto-confirms payment:
// stops at ready_for_payment and returns review_required, same contract every other
// money action honours (see action-contracts.js's run_browser_task entry for why this
// one is executionMode: 'direct' rather than 'review').
async function runBrowserTask({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, FAST_MODEL, parsePrice, guardConciergeSpend, generateBrain, webSearchBrain } = deps;
  const goal = String(params?.goal || '').trim();
  const url = String(params?.url || '').trim();
  // No upfront "goal required" guard — an empty goal is a valid continuation call for
  // an already-open order; runOrderingTurn resolves it from the live session or
  // persisted resume context and returns its own honest error if there's truly
  // nothing to continue.
  const credentialSites = Array.isArray(params?.credentialSites) ? params.credentialSites : [];
  let outcome;
  try {
    outcome = await browserTask.runOrderingTurn(userId, {
      url,
      goal,
      location: context.location,
      credentialSites,
      // Browser work can take several real site interactions. Stream its bounded,
      // human-readable step labels into the active chat task so the person can see
      // the current page action rather than a generic "Browsing the web" spinner.
      onProgress: (label) => context.onBrowserProgress?.(String(label || '').replace(/\s+/g, ' ').trim())
    });
  } catch (e) {
    return { success: false, error: `Browse task failed: ${e.message}` };
  }
  if (outcome.type === 'ready_for_credential_use') {
    return {
      success: false,
      outcome: 'awaiting_user',
      pending: true,
      confirmation: 'review_required',
      text: `I found a sign-in for ${outcome.site} — use your saved "${outcome.label}" credential to sign in?`,
      actionSummary: 'Sign-in ready',
      taskId: outcome.taskId,
      // The site and the run identity the user would be permitting, so a client can offer
      // "allow this for this task" (POST /vault/grants with scope 'task' and this id) and
      // not only the standing permission. taskId above is the TURN's id and changes every
      // turn; binding a grant to it would authorise nothing.
      site: outcome.site,
      credentialTaskId: outcome.credentialTaskId
    };
  }
  if (outcome.type === 'ready_for_payment') {
    const total = parsePrice(outcome.total || '');
    if (total) {
      // parsePrice strips the currency symbol, so recover it from the raw total and pass it
      // through — a UK £-checkout must be converted before it hits the (USD) spend cap, not
      // compared naked. No symbol on a UK-first app → assume GBP, the stricter side.
      const currency = detectCurrency(outcome.total || '') || 'GBP';
      // Check only: reaching the payment step is not spending. Budget is consumed when
      // the charge actually goes through, in confirmBrowserPayment.
      const guard = await guardConciergeSpend(userId, total, currency, { record: false });
      if (!guard.ok) return { success: false, error: guard.error };
    }
    // Tell the user up front which card the checkout will be paid with — or that
    // none is saved — so confirm never surprises them at the payment form.
    const agentCard = await getAgentCardSummary(supabase, userId).catch(() => null);
    const cardNote = agentCard
      ? ` I'll pay with your ${agentCard.brand} ending ${agentCard.last4}.`
      : ' (No payment card is saved — if this checkout asks for card details, add one on the Payments screen first.)';
    return {
      success: false,
      outcome: 'awaiting_user',
      pending: true,
      confirmation: 'review_required',
      text: `Ready to pay: ${outcome.summary}${outcome.total ? ` — ${outcome.total}` : ''}.${cardNote} Say the word and I'll place the order.`,
      total: outcome.total,
      summary: outcome.summary,
      actionSummary: 'Order ready for payment',
      taskId: outcome.taskId,
      ...(outcome.productName ? { productName: outcome.productName } : {}),
      ...(outcome.colorOptions?.length ? { colorOptions: outcome.colorOptions } : {}),
      ...(outcome.imageUrls?.length ? { imageUrls: outcome.imageUrls } : {})
    };
  }
  if (outcome.type === 'needs_user_information') {
    return {
      success: false,
      error: outcome.question || 'I need some checkout information to continue.',
      recoverable: true,
      recoveryAction: {
        type: 'checkout_information',
        label: 'Add details',
        fields: Array.isArray(outcome.fields) ? outcome.fields : []
      },
      taskId: outcome.taskId
    };
  }
  if (outcome.type === 'done') {
    return {
      success: true,
      text: outcome.text,
      taskId: outcome.taskId,
      ...(outcome.imageUrls?.length ? { imageUrls: outcome.imageUrls } : {}),
      ...(outcome.productName ? { productName: outcome.productName } : {}),
      ...(outcome.price ? { price: outcome.price } : {})
    };
  }
  if (outcome.type === 'awaiting_more') return { success: false, outcome: 'incomplete', incomplete: true, text: outcome.summary, continuesBrowsing: true, taskId: outcome.taskId };
  if (outcome.type === 'ask') return { success: false, outcome: 'awaiting_user', pending: true, text: outcome.question, taskId: outcome.taskId };
  if (outcome.type === 'reauth') {
    // Regression: this outcome type had no case here at all, so it fell through to the
    // generic "Browse task failed." error below — the actual "I need to sign in" question
    // was silently dropped and the client had no way to actually complete a sign-in
    // in-session (saying "keep going" just re-hits the same login wall). recoveryAction
    // type reauth_login is a new client-side case (MessageBubble) that opens a sign-in
    // sheet posting straight to POST /browser-task/reauth-login — see fillReauthLogin.
    return {
      success: false,
      error: outcome.question,
      recoverable: true,
      recoveryAction: { type: 'reauth_login', label: 'Sign in', site: outcome.site },
      taskId: outcome.taskId
    };
  }
  return { success: false, error: outcome.error || 'Browse task failed.' };
}

async function confirmBrowserPayment({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, FAST_MODEL, parsePrice, guardConciergeSpend, generateBrain, webSearchBrain } = deps;
  try {
    const result = await browserTask.confirmPayment(userId);
    if (result.type === 'error') return { success: false, error: result.error };
    // Only a completed charge consumes the daily cap.
    const charged = browserTask.getPendingPaymentTotal?.(userId);
    if (charged?.total) {
      await guardConciergeSpend(userId, charged.total, charged.currency || null).catch(() => {});
    }
    return { success: true, text: result.text };
  } catch (e) {
    return { success: false, error: `Payment confirmation failed: ${e.message}` };
  }
}

async function cancelBrowserPayment({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, FAST_MODEL, parsePrice, guardConciergeSpend, generateBrain, webSearchBrain } = deps;
  browserTask.cancelPayment(userId);
  return { success: true, text: 'Order cancelled — nothing was charged.' };
}

async function confirmCredentialUse({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, FAST_MODEL, parsePrice, guardConciergeSpend, generateBrain, webSearchBrain } = deps;
  try {
    const result = await browserTask.confirmCredentialUse(userId);
    if (result.type === 'error') return { success: false, error: result.error };
    return { success: true, text: result.text };
  } catch (e) {
    return { success: false, error: `Sign-in confirmation failed: ${e.message}` };
  }
}

async function cancelCredentialUse({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, FAST_MODEL, parsePrice, guardConciergeSpend, generateBrain, webSearchBrain } = deps;
  browserTask.cancelCredentialUse(userId);
  return { success: true, text: 'Okay, not signing in.' };
}

// === NEW AGENTIC GENERAL TOOLS ===
async function webBrowse({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, FAST_MODEL, parsePrice, guardConciergeSpend, generateBrain, webSearchBrain } = deps;
  const url = String(params?.url || '').trim();
  const query = String(params?.query || params?.summarize || '').trim();
  if (!url) return { success: false, error: 'web_browse requires url' };
  try {
    const axios = require('axios');
    const res = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'AssistantBot/1.0 (concierge)' } });
    let text = String(res.data || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 6000);
    
    // Concierge-grade: if query, use fast model to extract/answer specifically (makes it useful for real tasks)
    if (query) {
      const prompt = `You are a helpful concierge assistant. From this page content, answer or extract exactly what is needed for: "${query}". Be concise, factual, list key details or steps. Page: ${text.slice(0, 3000)}`;
      const llmRes = await generateBrain({
        model: FAST_MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {}
      });
      const answer = (llmRes.text || '').trim();
      return { success: true, text: answer || 'No specific info found.', url, contentPreview: text.slice(0, 400), query };
    }
    
    const summary = text.slice(0, 1500) + (text.length > 1500 ? '...' : '');
    return { success: true, text: summary, url, contentPreview: text.slice(0, 800) };
  } catch (e) {
    return { success: false, error: `Browse failed: ${e.message}` };
  }
}

async function webSearchAction({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, FAST_MODEL, parsePrice, guardConciergeSpend, generateBrain, webSearchBrain } = deps;
  const q = String(params?.query || '').trim();
  if (!q) return { success: false, error: 'web_search requires query' };
  try {
    const answer = await webSearchBrain({
      model: FAST_MODEL,
      prompt: `Today's date is ${getLocalDateKey()}. Search the web and answer concisely for: "${q}". Include key options, prices, and links where available. Only report what the search results support — if results look older than today, say so instead of guessing. Plain prose, no markdown headings or asterisks.`
    });
    if (!answer) return { success: false, error: `Search for "${q}" returned no results.` };
    return { success: true, text: answer, query: q };
  } catch (e) {
    return { success: false, error: `Search failed: ${e.message}`, query: q };
  }
}

module.exports = {
  handlers: {
    run_browser_task: runBrowserTask,
    confirm_browser_payment: confirmBrowserPayment,
    cancel_browser_payment: cancelBrowserPayment,
    confirm_credential_use: confirmCredentialUse,
    cancel_credential_use: cancelCredentialUse,
    web_browse: webBrowse,
    web_search: webSearchAction
  }
};

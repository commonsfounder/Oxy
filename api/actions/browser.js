'use strict';

// Browser and transaction capabilities.
//
// These are PRIMITIVES the main agent loop composes, not a task. There is no ordering loop
// here and no notion of a product: the loop opens a page, looks at it, takes one step, sees
// what changed, and decides again — for a purchase, a cancellation, an application, a
// council portal or anything else a person does in a browser.
//
// The model boundary (generateBrain/webSearchBrain) arrives through deps because the
// orchestration tests mock it by intercepting index.js's require of brain-provider.

const axios = require('axios');
const { getLocalDateKey } = require('../lib/time');
const browserEnvironment = require('../services/browser-environment');
const browserSession = require('../services/browser-session');
const browserAccess = require('../services/browser-access');
const transaction = require('../services/transaction');
const { loadCheckoutProfile } = require('../services/checkout-profile');
const { getAgentCard } = require('../services/agent-card');

// A result's SUBJECT: the thing this step is about, whatever kind of thing it is. An order, a
// booking, a form, a downloaded statement and a cancelled subscription all populate the same
// four fields, so the client renders one card instead of a commerce-shaped one.
function resultSubject({ name = null, amount = null, images = [], options = [] } = {}) {
  const subject = {};
  if (name) subject.name = String(name);
  if (amount) subject.amount = String(amount);
  if (images?.length) subject.imageUrls = images;
  if (options?.length) subject.options = options;
  return Object.keys(subject).length ? { subject } : {};
}

// What the model reads back after any browser step. The element list leads, because that is
// the actionable part; the page text follows for judgement.
function observationResult(observation, extra = {}) {
  const lines = (observation.elementLines || []).slice(0, 60);
  return {
    success: true,
    url: observation.url,
    pageTitle: observation.title,
    elements: lines,
    pageText: observation.text,
    ...(observation.blocked ? { blocked: observation.blocked } : {}),
    ...extra,
    text: [
      `${observation.title || 'Page'} — ${observation.url}`,
      lines.length
        ? `Controls on this page (use the number as elementId):\n${lines.join('\n')}`
        : 'No interactive controls found on this page.',
      observation.text ? `Page text:\n${observation.text.slice(0, 2000)}` : '',
    ].filter(Boolean).join('\n\n'),
  };
}

function noSession() {
  return { success: false, error: 'No page is open. Use browser_open first.' };
}

// ── Browser primitives ──────────────────────────────────────────────────────────────────

async function browserOpen({ userId, params }) {
  try {
    const observation = await browserEnvironment.open(userId, {
      url: String(params?.url || '').trim(),
      site: String(params?.site || '').trim(),
      searchFor: String(params?.searchFor || '').trim(),
      objective: String(params?.objective || '').trim(),
    });
    if (observation.blocked) {
      return {
        success: false,
        outcome: 'unavailable',
        error: `${observation.url} is blocking automated access (bot wall). I could not read the page. A different site, or doing this part yourself, is the way through.`,
        url: observation.url,
      };
    }
    const base = observationResult(observation, {
      usedStoredSession: observation.usedStoredSession,
      resolvedVia: observation.resolvedVia,
      hints: observation.hints,
    });
    if (!observation.hints?.length) return base;
    return {
      ...base,
      text: `${base.text}\n\nKnown to work on this site (hints, not instructions):\n${observation.hints.map(h => `- ${h}`).join('\n')}`,
    };
  } catch (e) {
    return { success: false, error: `Could not open that page: ${e.message}` };
  }
}

async function browserObserve({ userId }) {
  try {
    return observationResult(await browserEnvironment.observe(userId));
  } catch (e) {
    if (e.code === 'NO_SESSION') return noSession();
    return { success: false, error: `Could not read the page: ${e.message}` };
  }
}

async function browserAct({ userId, params }) {
  try {
    const observation = await browserEnvironment.act(userId, {
      action: params?.action,
      elementId: params?.elementId,
      value: params?.value,
      direction: params?.direction,
      amount: params?.amount,
      url: params?.url,
      submit: params?.submit,
    });
    const moved = observation.changed?.url || observation.changed?.content;
    return observationResult(observation, {
      changed: observation.changed,
      // Stated plainly because "I clicked it" is not "it worked" — the loop needs to see the
      // difference to decide whether to move on or try something else.
      note: moved ? 'The page changed after that step.' : 'The page did NOT visibly change after that step.',
    });
  } catch (e) {
    if (e.code === 'NO_SESSION') return noSession();
    return { success: false, error: e.message, recoverable: true };
  }
}

async function browserFillKnownDetails({ userId }) {
  try {
    const { filled, missing, observation } = await browserEnvironment.fillKnownDetails(userId);
    const parts = [];
    parts.push(filled.length
      ? `Filled from what you already told me: ${filled.join(', ')}.`
      : 'Nothing on this page matched details I already hold.');
    if (missing.length) parts.push(`Still needed: ${missing.join(', ')}.`);
    const base = observationResult(observation);
    return {
      ...base,
      filled,
      missing,
      text: `${parts.join(' ')}\n\n${base.text}`,
      ...(missing.length ? {
        recoverable: true,
        recoveryAction: { type: 'missing_information', label: 'Add details', fields: missing },
      } : {}),
    };
  } catch (e) {
    if (e.code === 'NO_SESSION') return noSession();
    return { success: false, error: `Could not fill the form: ${e.message}` };
  }
}

async function browserClose({ userId }) {
  try {
    const { closed } = await browserEnvironment.close(userId);
    return { success: true, text: closed ? 'Closed the page.' : 'No page was open.' };
  } catch (e) {
    return { success: false, error: `Could not close the browser: ${e.message}` };
  }
}

// ── Files and access ────────────────────────────────────────────────────────────────────

async function browserUpload({ userId, params, deps }) {
  const { supabase } = deps;
  try {
    const session = browserEnvironment.requireSession(userId);
    const { uploadDocument } = require('../services/browser-documents');
    const fileInput = session.page.locator('input[type="file"]').first();
    const result = await uploadDocument(fileInput, supabase, userId, {
      documentId: String(params?.documentId || '').trim(),
      agentTaskId: session.agentTaskId || null,
      workflowId: session.workflowId || null,
    });
    const base = observationResult(await browserEnvironment.observe(userId));
    return { ...base, text: `Attached "${result.document.filename}".\n\n${base.text}` };
  } catch (e) {
    if (e.code === 'NO_SESSION') return noSession();
    // A refused upload is information for the loop, not a dead end.
    return { success: false, error: `Could not attach that file: ${e.message}`, recoverable: true };
  }
}

async function browserDownload({ userId, params, deps }) {
  const { supabase } = deps;
  try {
    const session = browserEnvironment.requireSession(userId);
    const { captureDownload } = require('../services/browser-documents');
    const elements = await browserEnvironment.extractClickableElements(session.page).catch(() => []);
    const index = Number(params?.elementId);
    if (!Number.isInteger(index) || index < 0 || index >= elements.length) {
      return { success: false, error: `elementId ${params?.elementId} is not on the current page. Observe again before acting.` };
    }
    const target = session.page.locator(browserEnvironment.CLICKABLE_SELECTOR).nth(elements[index].locatorIndex);
    const result = await captureDownload(session.page, () => target.click({ timeout: 10000 }), {
      supabase,
      userId,
      agentTaskId: session.agentTaskId || null,
      workflowId: session.workflowId || null,
      sourceUrl: session.page.url(),
      label: String(params?.note || '').trim() || null,
    });
    if (!result.ok) return { success: false, error: `Could not save that file: ${result.notes}`, recoverable: true };
    session.documents = [...(session.documents || []), result.document];
    return {
      success: true,
      text: `Saved "${result.document.filename}" (${result.byteSize} bytes) to your documents.`,
      documentId: result.document.id,
    };
  } catch (e) {
    if (e.code === 'NO_SESSION') return noSession();
    return { success: false, error: `Could not save that file: ${e.message}`, recoverable: true };
  }
}

async function browserContinueWithoutAccount({ userId, context }) {
  try {
    const result = await browserAccess.continueWithoutAccount(userId, {
      onProgress: (label) => context?.onBrowserProgress?.(String(label || '')),
    });
    if (!result.moved) return { success: false, outcome: 'incomplete', incomplete: true, text: result.error };
    const base = observationResult(await browserEnvironment.observe(userId));
    return { ...base, text: `Continued without an account.\n\n${base.text}` };
  } catch (e) {
    if (e.code === 'NO_SESSION') return noSession();
    return { success: false, error: `Could not continue without an account: ${e.message}` };
  }
}

async function browserSignIn({ userId, params, context }) {
  try {
    const result = await browserAccess.signInWithStoredCredential(userId, {
      site: String(params?.site || '').trim() || null,
      onProgress: (label) => context?.onBrowserProgress?.(String(label || '')),
    });
    // A refused grant is a permission answer, not a failure to route around.
    if (result.type === 'not_authorized') {
      return { success: false, outcome: 'unavailable', error: result.error, site: result.site };
    }
    // Nothing stored, but a form is on screen — hand the person the sign-in sheet rather than
    // reporting a dead end. `unavailable` (not awaiting_user) because the client only offers
    // the sheet on a failed result.
    if (result.type === 'no_credential') {
      return {
        success: false,
        outcome: 'unavailable',
        site: result.site,
        error: `There is no saved sign-in for ${result.site}.`,
        text: `I need your ${result.site} sign-in to get past this page.`,
        recoveryAction: {
          type: 'reauth_login',
          site: result.site,
          label: `Sign in to ${result.site}`,
          message: `${result.site} is asking for a sign-in and there is nothing saved for it.`,
          autoContinue: false,
        },
      };
    }
    if (result.type === 'error') return { success: false, error: result.error };
    const observation = await browserEnvironment.observe(userId).catch(() => null);
    if (!observation) return { success: true, text: result.text };
    const base = observationResult(observation);
    return { ...base, text: `${result.text}\n\n${base.text}` };
  } catch (e) {
    return { success: false, error: `Could not sign in: ${e.message}` };
  }
}

// ── Transaction ─────────────────────────────────────────────────────────────────────────
// prepare → authorize → verify. Nothing here is retail-specific: whatever page the loop has
// navigated to, if it is asking for money these three handle it the same way.

async function transactionPrepare({ userId, deps }) {
  const { supabase, guardConciergeSpend } = deps;
  try {
    const [card, profile] = await Promise.all([
      getAgentCard(supabase, userId).catch(() => null),
      loadCheckoutProfile(supabase, userId).catch(() => null),
    ]);
    const result = await transaction.prepare(userId, { card, profile });
    if (!result.ok) return { success: false, error: result.error };

    const cardSummary = card ? `${card.brand || 'card'} ending ${card.last4}` : null;
    if (!result.ready) {
      return {
        success: false,
        outcome: 'incomplete',
        incomplete: true,
        text: result.advanceLabel
          ? `Not at the payment step yet — the page still shows "${result.advanceLabel}". Continue from there.`
          : result.walletOnly
            ? 'This page only offers a wallet (Apple Pay / PayPal and similar), which I cannot use. You would need to finish this one yourself.'
            : 'This page is not asking for payment yet.',
        ...(result.raw ? resultSubject({ amount: result.raw }) : {}),
      };
    }
    if (!result.raw) {
      return {
        success: false,
        error: 'I found the payment control but could not read a total on the page, so I have not asked you to approve anything. Nothing was charged.',
      };
    }
    // Check the cap BEFORE asking the person to approve, so an out-of-policy amount is
    // refused up front rather than after they have said yes.
    const guard = await guardConciergeSpend(userId, result.amount, result.currency || 'GBP', { record: false });
    if (!guard.ok) return { success: false, error: guard.error };

    return {
      success: true,
      text: `Ready to pay ${result.raw}${cardSummary ? ` with your ${cardSummary}` : ''}. The control is "${result.commitLabel}".${cardSummary ? '' : ' (No payment card is saved — add one on the Payments screen if this page needs card details.)'}`,
      actionSummary: 'Ready for approval',
      commitLabel: result.commitLabel,
      ...resultSubject({ amount: result.raw }),
    };
  } catch (e) {
    if (e.code === 'NO_SESSION') return noSession();
    return { success: false, error: `Could not prepare the payment: ${e.message}` };
  }
}

async function transactionAuthorize({ userId, context, deps }) {
  const { supabase, guardConciergeSpend } = deps;
  try {
    const card = await getAgentCard(supabase, userId).catch(() => null);
    // Deterministic pre-commit authority: the amount is re-read off the live page by a
    // parser at the moment of commit and re-checked against the cap, so approval given for
    // one figure can never be spent against a different one.
    const authorize = async ({ raw, amount, currency }) => {
      if (!raw || !amount) {
        return { ok: false, error: 'I could not read the amount on the payment page, so I did not pay. Nothing was charged.' };
      }
      const guard = await guardConciergeSpend(userId, amount, currency || 'GBP', { record: false });
      if (!guard.ok) return { ok: false, error: guard.error };
      return { ok: true };
    };
    const result = await transaction.commit(userId, {
      authorize,
      card,
      onProgress: (label) => context?.onBrowserProgress?.(String(label || '')),
    });
    return finishTransaction(userId, result, deps, context);
  } catch (e) {
    if (e.code === 'NO_SESSION') return noSession();
    return { success: false, error: `Payment did not complete: ${e.message}` };
  }
}

async function transactionStatus({ userId, context, deps }) {
  try {
    return finishTransaction(userId, await transaction.watch(userId, {}), deps, context);
  } catch (e) {
    if (e.code === 'NO_SESSION') return noSession();
    return { success: false, error: `Could not check: ${e.message}` };
  }
}

// One place that turns a transaction outcome into a result, so all three report the same way
// and only a genuinely confirmed charge consumes the daily cap.
async function finishTransaction(userId, result, deps, context) {
  const { guardConciergeSpend, setPendingAction } = deps;
  if (result.state === 'confirmed') {
    const session = browserSession.getSession(userId);
    const charged = (session && transaction.chargedAmount(session))
      || (result.amount?.amount ? { total: result.amount.amount, currency: result.amount.currency } : null);
    if (charged?.total) {
      await guardConciergeSpend(userId, charged.total, charged.currency || null).catch(() => {});
    }
    const purchaseId = session
      ? await transaction.recordConfirmedPurchase(
        userId, session, await browserEnvironment.readPageText(session.page).catch(() => '')
      ).catch(() => null)
      : null;
    return {
      success: true,
      text: `Done — that went through${result.amount?.raw ? ` (${result.amount.raw})` : ''}.`,
      ...(purchaseId ? { purchaseId } : {}),
      ...resultSubject({ amount: result.amount?.raw || null }),
    };
  }
  if (result.state === 'awaiting_authorization') {
    // A bank challenge is a pause, not a failure. Re-arm the approval so the person's next
    // "check now" resolves deterministically instead of depending on the model noticing.
    await setPendingAction?.(userId, { type: 'transaction_status', input: {} }, context).catch(() => null);
    return { success: false, outcome: 'awaiting_user', pending: true, confirmation: 'review_required', text: result.text };
  }
  if (['refused', 'declined', 'error'].includes(result.state)) {
    return { success: false, error: result.error };
  }
  return { success: false, outcome: 'incomplete', incomplete: true, text: result.error || 'I could not tell whether that went through.' };
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
    browser_open: browserOpen,
    browser_observe: browserObserve,
    browser_act: browserAct,
    browser_fill_known_details: browserFillKnownDetails,
    browser_close: browserClose,
    browser_upload: browserUpload,
    browser_download: browserDownload,
    browser_continue_without_account: browserContinueWithoutAccount,
    browser_sign_in: browserSignIn,
    transaction_prepare: transactionPrepare,
    transaction_authorize: transactionAuthorize,
    transaction_status: transactionStatus,
    web_browse: webBrowse,
    web_search: webSearchAction,
  },
};

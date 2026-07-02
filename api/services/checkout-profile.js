'use strict';

// Checkout identity for guest-checkout gates — stored in preferences (same pattern as
// concierge_account.*). v1: email only, order goals only, explicit consent required.

const PREF_EMAIL = 'checkout_profile.email';
const PREF_EMAIL_CONSENT = 'checkout_profile.email_consent';

// Never auto-fill payment-adjacent asks — stays a hard human ask per browser-task guardrail.
const PAYMENT_ASK_PATTERN = /\b(card\s*(?:number|details)?|payment\s*details|cvv|cvc|security\s*code|sort\s*code|account\s*number)\b/i;

const EMAIL_ASK_PATTERN = /\b(e-?mail(?:\s*address)?|your\s+email|guest\s+email)\b/i;

const EMAIL_IN_TEXT = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

const SAVE_EMAIL_CONSENT_PATTERN = /\bsave\s+(my\s+)?email\b/i;

/** Conservative: returns 'email' only on a clear email ask, never on payment fields. */
function classifyCheckoutAsk(question) {
  const q = String(question || '');
  if (!q || PAYMENT_ASK_PATTERN.test(q)) return null;
  if (EMAIL_ASK_PATTERN.test(q)) return 'email';
  return null;
}

/** Find an email input in the loop's extracted clickable elements. */
function findEmailInputElement(elements) {
  return (elements || []).find((el) => {
    const t = String(el.text || '');
    if (!t || PAYMENT_ASK_PATTERN.test(t)) return false;
    return /\b(e-?mail|email address)\b/i.test(t);
  }) || null;
}

function parseEmailFromUserText(text) {
  const m = String(text || '').match(EMAIL_IN_TEXT);
  return m ? m[0].trim().toLowerCase() : null;
}

function wantsSaveEmailConsent(text) {
  return SAVE_EMAIL_CONSENT_PATTERN.test(String(text || ''));
}

function buildEmailAskWithConsent(baseQuestion) {
  const q = String(baseQuestion || 'What email should I use for guest checkout?').trim();
  if (/save my email/i.test(q)) return q;
  return `${q} Reply with your email address. Say "save my email" if you'd like me to remember it for future orders.`;
}

async function loadCheckoutProfile(supabase, userId) {
  const { data, error } = await supabase
    .from('preferences')
    .select('key, value')
    .eq('user_id', userId)
    .in('key', [PREF_EMAIL, PREF_EMAIL_CONSENT]);
  if (error || !data) return { email: null, emailConsent: false };
  const map = Object.fromEntries(data.map((r) => [r.key, r.value]));
  const email = map[PREF_EMAIL] ? String(map[PREF_EMAIL]).trim().toLowerCase() : null;
  const emailConsent = map[PREF_EMAIL_CONSENT] === 'true';
  return { email: email || null, emailConsent };
}

async function setPreferenceValue(supabase, userId, key, value) {
  await supabase
    .from('preferences')
    .upsert({
      user_id: userId,
      key,
      value,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,key' });
}

async function saveCheckoutEmail(supabase, userId, email, consent = false) {
  const normalised = String(email || '').trim().toLowerCase();
  if (!normalised || !EMAIL_IN_TEXT.test(normalised)) return false;
  await setPreferenceValue(supabase, userId, PREF_EMAIL, normalised);
  if (consent) {
    await setPreferenceValue(supabase, userId, PREF_EMAIL_CONSENT, 'true');
  }
  return true;
}

module.exports = {
  PREF_EMAIL,
  PREF_EMAIL_CONSENT,
  classifyCheckoutAsk,
  findEmailInputElement,
  parseEmailFromUserText,
  wantsSaveEmailConsent,
  buildEmailAskWithConsent,
  loadCheckoutProfile,
  saveCheckoutEmail
};
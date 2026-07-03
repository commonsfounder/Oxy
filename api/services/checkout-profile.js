'use strict';

// Checkout identity for guest-checkout gates — stored in preferences (same pattern as
// concierge_account.*). v2: email + name + phone + address, single consolidated consent.

const PREF_EMAIL = 'checkout_profile.email';
const PREF_EMAIL_CONSENT = 'checkout_profile.email_consent'; // legacy key, still read
const PREF_NAME = 'checkout_profile.name';
const PREF_PHONE = 'checkout_profile.phone';
const PREF_ADDRESS = 'checkout_profile.address'; // JSON: {line1,line2?,city,postcode}
const PREF_CONSENT = 'checkout_profile.consent'; // consolidated consent flag

// Never auto-fill payment-adjacent fields — hard stop at every classification layer.
const PAYMENT_ASK_PATTERN = /\b(card\s*(?:number|details)?|payment\s*details|cvv|cvc|security\s*code|sort\s*code|account\s*number)\b/i;

const EMAIL_ASK_PATTERN = /\b(e-?mail(?:\s*address)?|your\s+email|guest\s+email)\b/i;
const NAME_ASK_PATTERN = /\b(your\s+(?:full\s+|first\s+|last\s+)?name|name\s+for\s+(?:the\s+)?(?:order|delivery))\b/i;
const PHONE_ASK_PATTERN = /\b((?:mobile|phone|contact)\s+number|your\s+(?:mobile|phone))\b/i;
const ADDRESS_ASK_PATTERN = /\b(delivery\s+address|shipping\s+address|your\s+address|address\s+line|post\s?code|zip\s+code|house\s+number|street\s+address)\b/i;

const EMAIL_IN_TEXT = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
const UK_MOBILE = /(\+44\s?7\d{3}\s?\d{6}|07\d{3}\s?\d{6})/;

const SAVE_DETAILS_CONSENT_PATTERN = /\bsave\s+(my\s+)?(?:details|address|info(?:rmation)?|email)\b/i;

// Hints that indicate address line 1 (street/house words)
const STREET_WORDS = /\b(street|st|road|rd|avenue|ave|lane|ln|close|cl|court|ct|drive|dr|way|place|pl|crescent|grove|gardens?|terrace|house|flat|apt|apartment|floor)\b/i;

/** Conservative classifier: returns field type or null. Payment always wins → null. */
function classifyCheckoutAsk(question) {
  const q = String(question || '');
  if (!q || PAYMENT_ASK_PATTERN.test(q)) return null;
  if (EMAIL_ASK_PATTERN.test(q)) return 'email';
  if (NAME_ASK_PATTERN.test(q)) return 'name';
  if (PHONE_ASK_PATTERN.test(q)) return 'phone';
  if (ADDRESS_ASK_PATTERN.test(q)) return 'address';
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

/**
 * Map an input's combined hint text (name/id/placeholder/aria-label/label) to the profile
 * field it should be filled with. Returns null when unknown or payment-adjacent — never guess.
 */
function matchProfileFieldForInput(hintText) {
  const h = String(hintText || '').toLowerCase();
  if (!h) return null;
  if (PAYMENT_ASK_PATTERN.test(h)) return null;
  // Email
  if (/e-?mail/.test(h)) return 'email';
  // Name variants — order matters: full > first/given > last/sur/family
  if (/full.?name/.test(h)) return 'full_name';
  if (/first.?name|given.?name|forename/.test(h)) return 'first_name';
  if (/last.?name|surname|family.?name/.test(h)) return 'last_name';
  // Phone
  if (/\b(mobile|phone|tel\b|contact.?number)/.test(h)) return 'phone';
  // Address — line2 before line1 so "address line 2" doesn't match "line 1"
  if (/address.?line.?2|apt|apartment|flat|unit/.test(h)) return 'line2';
  if (/address.?line|street|house.?number|building/.test(h)) return 'line1';
  if (/post.?code|zip/.test(h)) return 'postcode';
  if (/\b(city|town)\b/.test(h)) return 'city';
  return null;
}

function parseEmailFromUserText(text) {
  const m = String(text || '').match(EMAIL_IN_TEXT);
  return m ? m[0].trim().toLowerCase() : null;
}

/**
 * Parse a freeform user reply into whichever checkout identity fields can be confidently
 * extracted. Returns {} rather than guessing when confidence is low.
 *
 * Expected formats (comma/newline separated):
 *   "Name, line1, city, postcode[, phone]"
 *   "Name, line2, line1, city, postcode"
 *   "email@example.com"
 *   Various combinations
 */
function parseCheckoutReplyFromUserText(text) {
  const raw = String(text || '');
  const result = {};

  // Email
  const emailMatch = raw.match(EMAIL_IN_TEXT);
  if (emailMatch) result.email = emailMatch[0].trim().toLowerCase();

  // Phone (UK mobile)
  const phoneMatch = raw.match(UK_MOBILE);
  if (phoneMatch) result.phone = phoneMatch[0].trim();

  // Postcode (UK)
  const postcodeMatch = raw.match(UK_POSTCODE);
  const postcode = postcodeMatch ? postcodeMatch[1].trim().toUpperCase().replace(/\s+/, ' ') : null;

  // Strip already-extracted bits to make segment parsing easier
  let remaining = raw
    .replace(EMAIL_IN_TEXT, '')
    .replace(UK_MOBILE, '')
    .replace(UK_POSTCODE, '')
    .trim();

  // Split on commas or newlines, trim each part
  const parts = remaining
    .split(/[,\n]+/)
    .map((p) => p.trim())
    .filter(Boolean);

  // Heuristic segment classification:
  // - A digit-leading segment → line1 (house number + street)
  // - 2–4 capitalised words with no digits, not a street-word-only segment → name
  // - Remaining short non-digit segment → city
  // - If two address-looking segments before city: second → line2, first → line1

  const SUB_UNIT_PATTERN = /^(flat|apt|apartment|unit|floor)\b/i;
  const digitLeading = parts.filter((p) => /^\d/.test(p));
  const nonDigit = parts.filter((p) => !/^\d/.test(p));

  // Sub-unit non-digit parts e.g. "Flat 3", "Apt 4B"
  const subUnitParts = nonDigit.filter((p) => SUB_UNIT_PATTERN.test(p));

  // Name: first non-digit, non-sub-unit segment of 1–4 capitalised words, no digits
  const nameCandidate = nonDigit.find((p) => {
    if (SUB_UNIT_PATTERN.test(p)) return false;
    const words = p.split(/\s+/);
    return (
      words.length >= 1 &&
      words.length <= 4 &&
      !/\d/.test(p) &&
      !STREET_WORDS.test(p) &&
      words.every((w) => /^[A-Z]/.test(w))
    );
  });
  if (nameCandidate) result.name = nameCandidate;

  // Address segments: digit-leading (line1) + sub-unit non-digit (line2) + remaining (city)
  const remainingNonAddr = nonDigit.filter(
    (p) => p !== nameCandidate && !SUB_UNIT_PATTERN.test(p)
  );

  if (postcode || digitLeading.length || subUnitParts.length || remainingNonAddr.length) {
    const cityParts = [...remainingNonAddr];

    let line1 = digitLeading[0] || null;
    let line2 = subUnitParts[0] || null;

    // If no digit-leading but a non-name text looks like a street, treat as line1
    if (!line1 && cityParts.length > 0 && STREET_WORDS.test(cityParts[0])) {
      line1 = cityParts.shift();
    }

    const city = cityParts[0] || null;

    // Only emit address if at least postcode or line1 is present
    if (postcode || line1) {
      result.address = {};
      if (line1) result.address.line1 = line1;
      if (line2) result.address.line2 = line2;
      if (city) result.address.city = city;
      if (postcode) result.address.postcode = postcode;
    }
  }

  // Return {} when we extracted nothing confident (e.g. "yes please")
  if (!result.email && !result.phone && !result.name && !result.address) return {};
  return result;
}

function wantsSaveDetailsConsent(text) {
  return SAVE_DETAILS_CONSENT_PATTERN.test(String(text || ''));
}

// Alias for backward compat
const wantsSaveEmailConsent = wantsSaveDetailsConsent;

/**
 * Build a user-facing ask that lists the missing fields and appends the consent line once.
 * Idempotent — calling it on its own output returns unchanged.
 */
function buildDetailsAskWithConsent(baseQuestion, missingFields = []) {
  const q = String(baseQuestion || '').trim();
  if (/save my/i.test(q)) return q; // already has consent line
  const fieldList = (missingFields || []).join(', ');
  const ask = fieldList
    ? `${q} Please reply with your ${fieldList}.`
    : q;
  return `${ask} Say "save my details" if you'd like me to remember them for future orders.`;
}

function buildEmailAskWithConsent(baseQuestion) {
  const q = String(baseQuestion || 'What email should I use for guest checkout?').trim();
  if (/save my/i.test(q)) return q;
  return `${q} Reply with your email address. Say "save my details" if you'd like me to remember it for future orders.`;
}

// --------------- Supabase persistence ---------------

async function setPreferenceValue(supabase, userId, key, value) {
  await supabase
    .from('preferences')
    .upsert({ user_id: userId, key, value, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' });
}

async function loadCheckoutProfile(supabase, userId) {
  const { data, error } = await supabase
    .from('preferences')
    .select('key, value')
    .eq('user_id', userId)
    .like('key', 'checkout_profile.%');
  if (error || !data) return { email: null, name: null, phone: null, address: null, consent: false };

  const map = Object.fromEntries(data.map((r) => [r.key, r.value]));

  const email = map[PREF_EMAIL] ? String(map[PREF_EMAIL]).trim().toLowerCase() : null;
  const name = map[PREF_NAME] ? String(map[PREF_NAME]).trim() : null;
  const phone = map[PREF_PHONE] ? String(map[PREF_PHONE]).trim() : null;

  let address = null;
  if (map[PREF_ADDRESS]) {
    try { address = JSON.parse(map[PREF_ADDRESS]); } catch { address = null; }
  }

  // Consolidated consent OR legacy per-email consent
  const consent = map[PREF_CONSENT] === 'true' || map[PREF_EMAIL_CONSENT] === 'true';

  return { email: email || null, name, phone, address, consent };
}

/**
 * Upsert any subset of {email, name, phone, address} into preferences.
 * Pass consent=true to write the consolidated consent flag.
 */
async function saveCheckoutProfile(supabase, userId, fields = {}, consent = false) {
  const writes = [];
  if (fields.email != null) {
    const normalised = String(fields.email).trim().toLowerCase();
    if (normalised && EMAIL_IN_TEXT.test(normalised)) {
      writes.push(setPreferenceValue(supabase, userId, PREF_EMAIL, normalised));
    }
  }
  if (fields.name != null) {
    const n = String(fields.name).trim();
    if (n) writes.push(setPreferenceValue(supabase, userId, PREF_NAME, n));
  }
  if (fields.phone != null) {
    const p = String(fields.phone).trim();
    if (p) writes.push(setPreferenceValue(supabase, userId, PREF_PHONE, p));
  }
  if (fields.address != null && typeof fields.address === 'object') {
    writes.push(setPreferenceValue(supabase, userId, PREF_ADDRESS, JSON.stringify(fields.address)));
  }
  if (consent) {
    writes.push(setPreferenceValue(supabase, userId, PREF_CONSENT, 'true'));
  }
  await Promise.all(writes);
}

/** Thin backward-compat wrapper for email-only saves. */
async function saveCheckoutEmail(supabase, userId, email, consent = false) {
  const normalised = String(email || '').trim().toLowerCase();
  if (!normalised || !EMAIL_IN_TEXT.test(normalised)) return false;
  await saveCheckoutProfile(supabase, userId, { email: normalised }, consent);
  return true;
}

/**
 * Delete all checkout_profile.* preferences for a user (called from forget_memory).
 * Returns a human-readable summary of what was cleared.
 */
async function clearCheckoutProfile(supabase, userId) {
  const { data } = await supabase
    .from('preferences')
    .select('key')
    .eq('user_id', userId)
    .like('key', 'checkout_profile.%');
  if (!data || data.length === 0) return null;
  await supabase
    .from('preferences')
    .delete()
    .like('key', 'checkout_profile.%')
    .eq('user_id', userId);
  return 'checkout details (email, name, phone, and delivery address)';
}

module.exports = {
  PREF_EMAIL,
  PREF_EMAIL_CONSENT,
  PREF_NAME,
  PREF_PHONE,
  PREF_ADDRESS,
  PREF_CONSENT,
  classifyCheckoutAsk,
  findEmailInputElement,
  matchProfileFieldForInput,
  parseEmailFromUserText,
  parseCheckoutReplyFromUserText,
  wantsSaveDetailsConsent,
  wantsSaveEmailConsent,
  buildDetailsAskWithConsent,
  buildEmailAskWithConsent,
  loadCheckoutProfile,
  saveCheckoutProfile,
  saveCheckoutEmail,
  clearCheckoutProfile,
};

'use strict';

// Accepting a login that already exists in the user's own browser.
//
// The agent currently arrives at every site as a stranger: a brand-new browser with no
// history, which is exactly the shape bot detection is built to catch. Handing it a real,
// aged, already-signed-in session removes the login wall, the 2FA step, and the password
// from the picture entirely -- Oxy never learns the password because it never signs in.
//
// This is also the most dangerous input the system takes. A live session cookie is stronger
// than a password, and the payload arrives from a browser extension that can see every
// cookie the browser holds, not only the one site the user meant to share. Two rules follow:
//
//   1. Everything is filtered down to the site actually being imported. A dump containing
//      the user's bank must not become a stored banking session because the extension was
//      careless or the page that triggered it was hostile.
//   2. Some sites are refused outright rather than merely permissioned. A replayed banking
//      or identity-provider session is account takeover, and a permission granted in a hurry
//      is not a good enough gate for that.

const MAX_COOKIES = 500;
const IMPORT_TTL_MS = 1000 * 60 * 60 * 24 * 14; // two weeks, then it must be re-shared
const VALID_SAME_SITE = new Set(['Strict', 'Lax', 'None']);

// Matched against the registrable site being imported. Deliberately broad: the cost of
// wrongly refusing a shop is one annoyed user, the cost of wrongly accepting a bank is an
// emptied account.
const SENSITIVE_SITE_PATTERNS = Object.freeze([
  /(^|\.)chase\.com$/i,
  /(^|\.)hsbc\./i,
  /(^|\.)barclays\./i,
  /(^|\.)lloyds/i,
  /(^|\.)natwest\./i,
  /(^|\.)santander\./i,
  /(^|\.)monzo\.com$/i,
  /(^|\.)starlingbank\.com$/i,
  /(^|\.)revolut\.com$/i,
  /(^|\.)wise\.com$/i,
  /(^|\.)paypal\./i,
  /(^|\.)stripe\.com$/i,
  /(^|\.)coinbase\.com$/i,
  /(^|\.)binance\./i,
  /(^|\.)accounts\.google\.com$/i,
  /(^|\.)login\.microsoftonline\.com$/i,
  /(^|\.)appleid\.apple\.com$/i,
  /(^|\.)id\.gov/i,
  /(^|\.)gov\.uk$/i,
  /(^|\.)hmrc\./i,
  /bank/i,
  /banking/i,
  /(^|\.)okta\.com$/i,
  /(^|\.)auth0\.com$/i,
  /(^|\.)onelogin\.com$/i,
  /(^|\.)duosecurity\.com$/i
]);

// Identity logins that sit UNDER an otherwise-ordinary parent domain. These need a list of
// their own rather than another pattern, because the patterns above are matched against the
// site being imported while cookie filtering deliberately keeps subdomains. Importing the
// parent (`google.com`) matched nothing here and then swept in the identity session on the
// child (`accounts.google.com`) -- and Google's own SSO cookies sit on `.google.com`
// itself, so that import was the whole account. Containment is therefore checked in BOTH
// directions: a sensitive host under the requested site is as disqualifying as the
// requested site sitting under a sensitive host.
//
// amazon.com is deliberately absent even though signin.aws.amazon.com is an identity host:
// shopping sites are the entire point of this feature, and refusing the biggest one to
// protect an AWS console nobody is importing would trade the product for nothing.
const SENSITIVE_HOSTS = Object.freeze([
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'account.microsoft.com',
  'appleid.apple.com'
]);

function normalizeSite(site) {
  return String(site || '').trim().toLowerCase().replace(/^www\./, '');
}

/** True when either host contains the other, so `google.com` and `accounts.google.com`
 *  disqualify each other regardless of which one was asked for. */
function hostsOverlap(a, b) {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function isSensitiveSite(site) {
  const normalized = normalizeSite(site);
  if (!normalized) return false;
  if (SENSITIVE_SITE_PATTERNS.some(pattern => pattern.test(normalized))) return true;
  return SENSITIVE_HOSTS.some(host => hostsOverlap(normalized, host));
}

/**
 * Does this cookie belong to the site being imported?
 *
 * Matching is on a dot boundary, never a substring. `notjohnlewis.com` and
 * `johnlewis.com.evil.com` both contain the site as a substring and must both be rejected;
 * `signin.delta.com` is a real subdomain where the login actually lives and must be kept.
 */
function cookieBelongsToSite(cookieDomain, site) {
  const domain = String(cookieDomain || '').trim().toLowerCase().replace(/^\./, '');
  if (!domain) return false;
  return domain === site || domain.endsWith(`.${site}`);
}

function sanitizeCookie(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  const domain = String(raw.domain || '').trim();
  // A cookie with no name or no domain cannot be replayed; it would only pad the payload.
  if (!name || !domain) return null;

  const sameSite = VALID_SAME_SITE.has(raw.sameSite) ? raw.sameSite : 'Lax';
  const expires = Number.isFinite(Number(raw.expires)) ? Number(raw.expires) : -1;

  // Rebuilt field by field rather than spread: whatever else the extension attached is not
  // carried into storage, and the result is exactly the shape Playwright accepts.
  return {
    name,
    value: String(raw.value ?? ''),
    domain,
    path: String(raw.path || '/'),
    expires,
    httpOnly: Boolean(raw.httpOnly),
    secure: Boolean(raw.secure),
    sameSite
  };
}

/**
 * Turn a raw cookie payload into a Playwright storage state for exactly one site.
 *
 * @returns {{ok: true, site: string, state: object, dropped: number, expiresAt: number}
 *          |{ok: false, error: string}}
 */
function prepareImportedSession({ site, cookies, origins = [], now = new Date() } = {}) {
  const normalizedSite = normalizeSite(site);
  if (!normalizedSite) return { ok: false, error: 'A site is required.' };
  if (isSensitiveSite(normalizedSite)) {
    return { ok: false, error: `Sessions for ${normalizedSite} cannot be imported. Sign in there yourself.` };
  }
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return { ok: false, error: 'No cookies were supplied.' };
  }
  if (cookies.length > MAX_COOKIES) {
    return { ok: false, error: `Too many cookies (${cookies.length}); at most ${MAX_COOKIES} are accepted.` };
  }

  let dropped = 0;
  const kept = [];
  for (const raw of cookies) {
    const clean = sanitizeCookie(raw);
    if (!clean || !cookieBelongsToSite(clean.domain, normalizedSite)) { dropped += 1; continue; }
    kept.push(clean);
  }

  // Storing an empty session would look like success and then behave as a logged-out
  // browser, which is a far more confusing failure than refusing here.
  if (!kept.length) {
    return { ok: false, error: `No cookies for ${normalizedSite} were found in what was sent.` };
  }

  // Second gate, on what actually survived the filter rather than on what was asked for.
  // The site cleared the door, but cookie filtering keeps subdomains, so a sensitive host
  // beneath a perfectly ordinary parent can still be sitting in `kept`. Refuse the whole
  // import rather than quietly dropping the offending cookie: a partial session is a
  // logged-out browser wearing a success message.
  const smuggled = kept.find(cookie => isSensitiveSite(cookie.domain.replace(/^\./, '')));
  if (smuggled) {
    return {
      ok: false,
      error: `That payload carries a ${smuggled.domain.replace(/^\./, '')} session, which cannot be imported. Sign in there yourself.`
    };
  }

  const keptOrigins = (Array.isArray(origins) ? origins : []).filter(origin => {
    try { return cookieBelongsToSite(new URL(origin?.origin).hostname, normalizedSite); }
    catch { return false; }
  });

  return {
    ok: true,
    site: normalizedSite,
    dropped,
    expiresAt: new Date(now).getTime() + IMPORT_TTL_MS,
    state: { cookies: kept, origins: keptOrigins }
  };
}

module.exports = {
  IMPORT_TTL_MS,
  MAX_COOKIES,
  SENSITIVE_HOSTS,
  SENSITIVE_SITE_PATTERNS,
  cookieBelongsToSite,
  isSensitiveSite,
  normalizeSite,
  prepareImportedSession,
  sanitizeCookie
};

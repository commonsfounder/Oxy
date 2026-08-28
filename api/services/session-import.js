'use strict';

// Accepting a login that already exists in the user's own browser, so the agent arrives aged
// and signed in rather than as the brand-new visitor bot detection is built to catch — and
// without ever learning the password, since it never signs in.
//
// It is also the most dangerous input here: a live session cookie beats a password, and the
// payload comes from an extension that can see every cookie the browser holds. So everything
// is filtered down to the one site being imported, and banking and identity providers are
// refused outright — a replayed session there is account takeover, not a permission decision.

const { registrableSite } = require('../lib/site');

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

// Identity logins sitting under an otherwise-ordinary parent domain. They need their own list
// because the patterns above match the site being imported while cookie filtering keeps
// subdomains — importing `google.com` matches no pattern and sweeps in `accounts.google.com`.
// So containment is checked both ways: a sensitive host under the requested site disqualifies
// it as much as the requested site sitting under one. amazon.com is deliberately absent;
// shopping sites are the point of this feature.
const SENSITIVE_HOSTS = Object.freeze([
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'account.microsoft.com',
  'appleid.apple.com'
]);

// Collapse to the registrable domain, not just strip www: a session shared from `account.<site>`
// would otherwise be filed where the lookup by site never looks.
function normalizeSite(site) {
  return registrableSite(site);
}

/** True when either host contains the other, so `google.com` and `accounts.google.com`
 *  disqualify each other regardless of which one was asked for. */
function hostsOverlap(a, b) {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** Lowercase host with leading/trailing dots and www removed -- and nothing else removed. */
function bareHost(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/^\./, '').replace(/\.$/, '').replace(/^www\./, '');
}

/**
 * Screening deliberately does NOT collapse to the registrable domain — that would throw away
 * the label identifying `hsbc.example.com` as a bank. The full host is checked, and the
 * registrable form too, so a parent is still caught by its identity child.
 */
function isSensitiveSite(site) {
  const host = bareHost(site);
  if (!host) return false;
  const candidates = new Set([host, registrableSite(host)].filter(Boolean));
  for (const candidate of candidates) {
    if (SENSITIVE_SITE_PATTERNS.some(pattern => pattern.test(candidate))) return true;
    if (SENSITIVE_HOSTS.some(sensitive => hostsOverlap(candidate, sensitive))) return true;
  }
  return false;
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

  // Second gate, on what survived the filter rather than what was asked for: subdomains are
  // kept, so a sensitive host can still be in `kept`. Refuse the whole import — a partial
  // session is a logged-out browser wearing a success message.
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

'use strict';

// Handing Oxy a login that already exists in the user's own browser.
//
// This is the most dangerous input the system accepts. A live session cookie is stronger
// than a password -- it skips the login form and 2FA entirely -- and the payload arrives
// from a browser extension, which sees every cookie the browser holds, not just the one
// site the user meant to share. So the rule enforced here is: what comes in is filtered
// down to the site actually being imported, and nothing else survives.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  SENSITIVE_HOSTS,
  SENSITIVE_SITE_PATTERNS,
  isSensitiveSite,
  prepareImportedSession
} = require('../../api/services/session-import');

const NOW = new Date('2026-08-25T12:00:00Z');

function cookie(overrides = {}) {
  return {
    name: 'session',
    value: 'abc123',
    domain: '.johnlewis.com',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    ...overrides
  };
}

test('a session for the requested site is accepted and stamped with an expiry', () => {
  const result = prepareImportedSession({
    site: 'www.JohnLewis.com',
    cookies: [cookie()],
    now: NOW
  });
  assert.equal(result.ok, true);
  assert.equal(result.site, 'johnlewis.com');
  assert.equal(result.state.cookies.length, 1);

  // An imported session must age out on its own. Without this it would outlive any
  // permission the user set and become the one credential that never expires.
  assert.ok(result.expiresAt > NOW.getTime());
});

test('cookies for any other domain are stripped, so importing one site cannot smuggle another', () => {
  // This is the property the whole feature rests on. An extension dump contains the bank
  // too; the user asked to share one shop.
  const result = prepareImportedSession({
    site: 'johnlewis.com',
    cookies: [
      cookie(),
      cookie({ domain: '.chase.com', name: 'bank_session' }),
      cookie({ domain: 'accounts.google.com', name: 'google_sid' }),
      cookie({ domain: '.johnlewis.com.evil.com', name: 'lookalike' }),
      cookie({ domain: 'notjohnlewis.com', name: 'suffix_trick' })
    ],
    now: NOW
  });
  assert.equal(result.ok, true);
  const domains = result.state.cookies.map(c => c.domain);
  assert.deepEqual(domains, ['.johnlewis.com']);
  assert.equal(result.dropped, 4);
});

test('real subdomains of the imported site are kept, because that is where logins live', () => {
  const result = prepareImportedSession({
    site: 'delta.com',
    cookies: [
      cookie({ domain: 'delta.com' }),
      cookie({ domain: '.delta.com', name: 'a' }),
      cookie({ domain: 'signin.delta.com', name: 'b' }),
      cookie({ domain: 'www.delta.com', name: 'c' })
    ],
    now: NOW
  });
  assert.equal(result.ok, true);
  assert.equal(result.state.cookies.length, 4);
  assert.equal(result.dropped, 0);
});

test('finance and identity sites are refused outright, not merely permissioned', () => {
  // A permission can be granted in a hurry. These are refused at the door instead, because
  // a replayed banking session is account takeover, not convenience.
  for (const site of ['chase.com', 'hsbc.co.uk', 'paypal.com', 'accounts.google.com', 'coinbase.com']) {
    const result = prepareImportedSession({ site, cookies: [cookie({ domain: '.' + site })], now: NOW });
    assert.equal(result.ok, false, `${site} should be refused`);
    assert.match(result.error, /cannot be imported/i);
  }
  assert.ok(SENSITIVE_SITE_PATTERNS.length > 0);
});

test('an import with nothing usable left is a failure, not an empty success', () => {
  // Silently storing an empty session would look like it worked and then behave as a
  // logged-out browser, which is the confusing failure this avoids.
  const result = prepareImportedSession({
    site: 'johnlewis.com',
    cookies: [cookie({ domain: '.chase.com' })],
    now: NOW
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /no cookies/i);
});

test('malformed input is rejected rather than half-accepted', () => {
  assert.equal(prepareImportedSession({ site: '', cookies: [cookie()], now: NOW }).ok, false);
  assert.equal(prepareImportedSession({ site: 'johnlewis.com', cookies: [], now: NOW }).ok, false);
  assert.equal(prepareImportedSession({ site: 'johnlewis.com', cookies: 'nope', now: NOW }).ok, false);

  // A cookie with no name or no domain cannot be replayed and would only pad the payload.
  const result = prepareImportedSession({
    site: 'johnlewis.com',
    cookies: [cookie(), { value: 'x', domain: '.johnlewis.com' }, cookie({ name: 'ok2' })],
    now: NOW
  });
  assert.equal(result.ok, true);
  assert.equal(result.state.cookies.length, 2);
});

test('an implausibly large payload is refused rather than stored', () => {
  const many = Array.from({ length: 600 }, (_, i) => cookie({ name: 'c' + i }));
  const result = prepareImportedSession({ site: 'johnlewis.com', cookies: many, now: NOW });
  assert.equal(result.ok, false);
  assert.match(result.error, /too many/i);
});

test('the stored shape is what Playwright expects, so it can be replayed directly', () => {
  const result = prepareImportedSession({ site: 'johnlewis.com', cookies: [cookie()], now: NOW });
  assert.ok(Array.isArray(result.state.cookies));
  assert.ok(Array.isArray(result.state.origins));
  const [only] = result.state.cookies;
  for (const key of ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite']) {
    assert.ok(key in only, `cookie is missing ${key}`);
  }
  // sameSite must be one of Playwright's accepted values or the whole import throws on use.
  assert.ok(['Strict', 'Lax', 'None'].includes(only.sameSite));
});

// Tripwire for a route that queried columns the live table does not have.
//
// /agent/browser selected `last_url` and `goal` from browser_sessions. Commit 97742f7a had
// already moved that data inside the encrypted storage_state value precisely because those
// columns do not exist, but this route was not updated, so it returned 500 in production
// from then until a live import test happened to call it. Nothing in the suite noticed,
// because no test exercised the route against a real schema.
test('the browser-sessions route reads the resume state from the blob, not phantom columns', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../../api/index.js'), 'utf8');

  const route = source.slice(source.indexOf("app.get('/agent/browser'"));
  const body = route.slice(0, route.indexOf('\n});'));

  assert.doesNotMatch(body, /\.select\([^)]*last_url/,
    'last_url is not a column on browser_sessions');
  assert.doesNotMatch(body, /\.select\([^)]*\bgoal\b/,
    'goal is not a column on browser_sessions');
  assert.match(body, /\.select\('site, storage_state, updated_at'\)/,
    'the route must select only columns that exist');
  assert.match(body, /RESUME_STATE_KEY/,
    'the resume detail comes out of the encrypted blob');
});


// The popup's "unshare" button hits this route. It must scope the delete to BOTH the
// authenticated user and the requested site -- dropping either `.eq` would let one user's
// request delete another user's session, or delete every site that user has shared at once.
test('the unshare route deletes exactly one user\'s one site, nothing broader', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../../api/index.js'), 'utf8');

  const route = source.slice(source.indexOf("app.delete('/vault/browser-session/:site'"));
  const body = route.slice(0, route.indexOf('\n});'));

  assert.match(body, /\.eq\('user_id',\s*userId\)/, 'must scope the delete to the authenticated user');
  assert.match(body, /\.eq\('site',\s*site\)/, 'must scope the delete to the requested site');
  assert.match(body, /normalizeSite\(req\.params\.site\)/,
    'the site must be normalized the same way the GET list and the import route store it');
});

// The sensitive-site gate was matched against the site being asked for, while cookie
// filtering deliberately keeps subdomains. Those two rules disagreed, and the gap between
// them was the whole feature's worst case: `accounts.google.com` was refused, but asking
// for the PARENT, `google.com`, matched no pattern and was accepted -- and Google's SSO
// cookies (SID/HSID/SSID) live on `.google.com` itself, so what got stored was the entire
// Google account, the exact thing the refusal list exists to prevent.
test('asking for the parent of an identity host does not sneak past the refusal list', () => {
  for (const parent of ['google.com', 'microsoftonline.com', 'apple.com']) {
    assert.equal(isSensitiveSite(parent), true, `${parent} must be refused`);
    const result = prepareImportedSession({
      site: parent,
      cookies: [cookie({ domain: `.${parent}`, name: 'SID' })],
      now: NOW
    });
    assert.equal(result.ok, false, `importing ${parent} should be refused`);
    assert.match(result.error, /cannot be imported/i);
  }
});

test('containment is checked in both directions, so a subdomain of an identity host is refused too', () => {
  assert.equal(isSensitiveSite('mail.accounts.google.com'), true);
  assert.equal(SENSITIVE_HOSTS.length > 0, true);
});

test('ordinary shops are still importable, because refusing everything is not the goal', () => {
  // The gate is broad on purpose, but it has to stay narrow enough to leave the product
  // working. amazon.com in particular is deliberately allowed despite signin.aws.amazon.com.
  for (const site of ['johnlewis.com', 'delta.com', 'amazon.com', 'asos.com', 'argos.co.uk']) {
    assert.equal(isSensitiveSite(site), false, `${site} must remain importable`);
  }
});

test('a sensitive cookie that survives the site filter refuses the whole import', () => {
  // Second gate, on what actually came through rather than on what was asked for. The site
  // here is perfectly ordinary; the cookie riding along under it is not.
  const result = prepareImportedSession({
    site: 'example.com',
    cookies: [
      cookie({ domain: '.example.com', name: 'cart' }),
      cookie({ domain: 'hsbc.example.com', name: 'stowaway' })
    ],
    now: NOW
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot be imported/i);
  // Refused outright, not silently trimmed: a partial session is a logged-out browser
  // wearing a success message.
  assert.equal(result.state, undefined);
});

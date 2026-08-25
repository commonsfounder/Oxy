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
  SENSITIVE_SITE_PATTERNS,
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

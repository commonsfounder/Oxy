const assert = require('node:assert/strict');
const test = require('node:test');

const { siteKeyFromUrl, siteInScope } = require('../../api/services/browser-task');
const { normalizeSite } = require('../../api/services/vault-credentials');

test('siteKeyFromUrl and normalizeSite agree on the same domain (scoped-grant matching depends on this)', () => {
  assert.equal(siteKeyFromUrl('https://www.delta.com/login'), normalizeSite('delta.com'));
  assert.equal(siteKeyFromUrl('https://delta.com/login'), normalizeSite('www.delta.com'));
});

test('a credentialSites entry the model passes as a bare domain normalizes to what siteKeyFromUrl produces for that site', () => {
  const modelPassed = ['Delta.com', 'WWW.United.com'];
  const normalized = modelPassed.map(normalizeSite);
  assert.deepEqual(normalized, ['delta.com', 'united.com']);
  assert.equal(siteKeyFromUrl('https://www.united.com/account'), 'united.com');
  assert.ok(normalized.includes(siteKeyFromUrl('https://www.united.com/account')));
});

test('siteInScope: exact match is in scope', () => {
  assert.equal(siteInScope('delta.com', ['delta.com']), true);
});

test('siteInScope: a sign-in subdomain matches a granted registrable domain', () => {
  assert.equal(siteInScope('signin.delta.com', ['delta.com']), true);
  assert.equal(siteInScope('accounts.google.com', ['google.com']), true);
});

test('siteInScope: an unrelated site is not in scope even with no shared entries', () => {
  assert.equal(siteInScope('notdelta.com', ['delta.com']), false);
});

test('siteInScope: a lookalike domain that merely ENDS WITH the granted string, without a label-boundary dot, must NOT match — guards against a regression to naive .endsWith(allowed)', () => {
  // "evildelta.com".endsWith("delta.com") is true, but evildelta.com is not a subdomain of
  // delta.com — there is no "." before "delta.com". A naive suffix check would wrongly let
  // this through and offer/fill a delta.com credential on an attacker-controlled site.
  assert.equal(siteInScope('evildelta.com', ['delta.com']), false);
  assert.equal('evildelta.com'.endsWith('delta.com'), true); // sanity: the naive check WOULD wrongly match
});

test('siteInScope: no match when allowedSites is empty or has no relation to currentSite', () => {
  assert.equal(siteInScope('delta.com', []), false);
  assert.equal(siteInScope('delta.com', ['united.com']), false);
});

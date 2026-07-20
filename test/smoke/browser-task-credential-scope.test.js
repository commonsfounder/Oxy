const assert = require('node:assert/strict');
const test = require('node:test');

const { siteKeyFromUrl } = require('../../api/services/browser-task');
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

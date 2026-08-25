'use strict';

// Which origins may call the API.
//
// The Chrome extension calls from `chrome-extension://<id>`, which is not a website and was
// never in the allowlist, so every request from it was rejected as a CORS failure and
// surfaced to the user as an unexplained HTTP 500.
//
// Letting extension origins through is safe *here* specifically because this API
// authenticates on headers only -- Bearer or X-Session-Token, never cookies (see auth.js's
// getProvidedSessionToken). CORS exists to stop a hostile page spending the browser's
// ambient credentials; with no cookie auth there are none to spend, so an extension origin
// still has to present a real token. That reasoning would not hold if cookie auth were ever
// added, which is why it is written down rather than assumed.

const assert = require('node:assert/strict');
const test = require('node:test');

const { isAllowedOrigin } = require('../../api/lib/cors');

const ALLOWED = ['https://app.example.com'];
const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

test('a request with no origin is allowed, so non-browser callers keep working', () => {
  // curl, the iOS app, and server-to-server calls send no Origin header at all.
  assert.equal(isAllowedOrigin(undefined, { allowedOrigins: ALLOWED }), true);
  assert.equal(isAllowedOrigin('', { allowedOrigins: ALLOWED }), true);
});

test('an empty allowlist stays permissive, matching the previous behaviour', () => {
  assert.equal(isAllowedOrigin('https://anything.example', { allowedOrigins: [] }), true);
});

test('a listed website is allowed and an unlisted one is not', () => {
  assert.equal(isAllowedOrigin('https://app.example.com', { allowedOrigins: ALLOWED }), true);
  assert.equal(isAllowedOrigin('https://evil.example', { allowedOrigins: ALLOWED }), false);
});

test('a Chrome extension origin is allowed, which is what the session-share extension needs', () => {
  assert.equal(isAllowedOrigin(EXTENSION, { allowedOrigins: ALLOWED }), true);
});

test('extension origins can be pinned to specific ids once those ids are known', () => {
  const pinned = { allowedOrigins: ALLOWED, allowedExtensionIds: ['abcdefghijklmnopabcdefghijklmnop'] };
  assert.equal(isAllowedOrigin(EXTENSION, pinned), true);
  assert.equal(isAllowedOrigin('chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba', pinned), false);
});

test('only a well-formed extension id is accepted, not anything wearing the scheme', () => {
  // Chrome extension ids are exactly 32 characters from a-p. Anything else is not an
  // extension origin and must not inherit the exemption.
  for (const origin of [
    'chrome-extension://short',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnopEXTRA',
    'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop.evil.com',
    'https://chrome-extension.evil.com'
  ]) {
    assert.equal(isAllowedOrigin(origin, { allowedOrigins: ALLOWED }), false, `${origin} should be refused`);
  }
});

test('other extension schemes are not silently trusted', () => {
  // Only Chrome is supported today; Firefox/Safari equivalents would need their own
  // deliberate decision rather than arriving by accident.
  assert.equal(isAllowedOrigin('moz-extension://abcdefghijklmnopabcdefghijklmnop', { allowedOrigins: ALLOWED }), false);
  assert.equal(isAllowedOrigin('safari-web-extension://abcdefghijklmnopabcdefghijklmnop', { allowedOrigins: ALLOWED }), false);
});

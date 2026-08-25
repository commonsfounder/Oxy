'use strict';

// Reading whether a shared session is still signed in.
//
// A session shared from the user's browser expires, gets invalidated by the site, or is
// simply refused when replayed from a server. None of that announces itself: the agent just
// starts behaving like a logged-out visitor, and the user has no way to tell that is what
// happened. This reads a page's own signals and says which it is.
//
// The judgement is deliberately conservative. A page carrying BOTH a sign-in link and an
// account menu is normal (many retailers show both), so a bare keyword count is not enough:
// what settles it is which signals are present that the other state cannot explain.

const assert = require('node:assert/strict');
const test = require('node:test');

const { readSignedInSignals } = require('../../api/services/session-health');

test('a page offering a sign-in form reads as signed out', () => {
  const result = readSignedInSignals({
    url: 'https://www.johnlewis.com/my-account',
    title: 'Sign in | My Account | John Lewis & Partners',
    text: 'Sign in to your account. Email address. Password. Sign in. Register',
    hasPasswordField: true
  });
  assert.equal(result.signedIn, false);
  assert.match(result.because, /password field|sign in/i);
});

test('a page showing account controls reads as signed in', () => {
  const result = readSignedInSignals({
    url: 'https://www.johnlewis.com/my-account',
    title: 'My Account | John Lewis & Partners',
    text: 'Hello Chizi. Your orders. Your details. Sign out',
    hasPasswordField: false
  });
  assert.equal(result.signedIn, true);
  assert.match(result.because, /sign out|your orders/i);
});

test('a live password field settles it, whatever else the page says', () => {
  // A retailer can show "Sign out" in a stale cached header while serving a login form.
  // The form is the stronger signal: you cannot be asked to sign in and already be in.
  const result = readSignedInSignals({
    url: 'https://www.johnlewis.com/my-account',
    title: 'Sign in',
    text: 'Sign out. Your orders. Please enter your password to continue.',
    hasPasswordField: true
  });
  assert.equal(result.signedIn, false);
});

test('being redirected to a login URL reads as signed out even on a bland page', () => {
  const result = readSignedInSignals({
    url: 'https://auth.johnlewis.com/login?state=abc',
    title: 'Loading',
    text: '',
    hasPasswordField: false
  });
  assert.equal(result.signedIn, false);
  assert.match(result.because, /login/i);
});

test('an ordinary shop page with a sign-in link is not mistaken for a verdict', () => {
  // Nearly every retail homepage has "Sign in" in the header. On its own that says nothing
  // about the account state, so this must come back unknown rather than confidently wrong.
  const result = readSignedInSignals({
    url: 'https://www.johnlewis.com/',
    title: 'John Lewis & Partners',
    text: 'Sign in. Basket. Bath towels. Home. Furniture.',
    hasPasswordField: false
  });
  assert.equal(result.signedIn, null);
  assert.match(result.because, /not clear|inconclusive/i);
});

test('nothing to read is reported as nothing, not as a guess', () => {
  const result = readSignedInSignals({ url: '', title: '', text: '', hasPasswordField: false });
  assert.equal(result.signedIn, null);
});

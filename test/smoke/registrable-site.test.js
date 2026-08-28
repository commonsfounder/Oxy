'use strict';

// Which name a shared session gets filed under. A share from `account.<site>` — the page where
// someone checks they are signed in — must file under `<site>`, or the lookup never finds it.
// It also narrows the capture: Chrome's filter matches a domain and its subdomains, so asking
// for the account host skips the cookies holding the session. Both sides collapse to the
// registrable domain first.

const assert = require('node:assert/strict');
const test = require('node:test');

const { registrableSite } = require('../../api/lib/site');

test('a subdomain collapses to the site the ordering loop will look for', () => {
  assert.equal(registrableSite('account.johnlewis.com'), 'johnlewis.com');
  assert.equal(registrableSite('www.johnlewis.com'), 'johnlewis.com');
  assert.equal(registrableSite('johnlewis.com'), 'johnlewis.com');
  assert.equal(registrableSite('signin.delta.com'), 'delta.com');
  assert.equal(registrableSite('a.b.c.example.com'), 'example.com');
});

test('multi-part country suffixes keep the part that identifies the business', () => {
  // Collapsing to the last two labels would turn every British site into "co.uk", which
  // would file unrelated shops under one shared key.
  assert.equal(registrableSite('www.johnlewis.co.uk'), 'johnlewis.co.uk');
  assert.equal(registrableSite('account.marksandspencer.co.uk'), 'marksandspencer.co.uk');
  assert.equal(registrableSite('shop.example.org.uk'), 'example.org.uk');
  assert.equal(registrableSite('www.example.com.au'), 'example.com.au');
  assert.equal(registrableSite('example.co.nz'), 'example.co.nz');
});

test('a full URL works as well as a bare hostname, since callers have both', () => {
  assert.equal(registrableSite('https://www.johnlewis.com/basket?x=1'), 'johnlewis.com');
  assert.equal(registrableSite('http://account.johnlewis.com'), 'johnlewis.com');
});

test('case and a trailing dot do not create a second key for the same site', () => {
  assert.equal(registrableSite('WWW.JohnLewis.COM'), 'johnlewis.com');
  assert.equal(registrableSite('johnlewis.com.'), 'johnlewis.com');
});

test('input that is not a site returns empty rather than a guess', () => {
  assert.equal(registrableSite(''), '');
  assert.equal(registrableSite(null), '');
  assert.equal(registrableSite('localhost'), 'localhost');
  assert.equal(registrableSite('co.uk'), 'co.uk');
});

// Collapsing to the registrable domain is right for filing a session and wrong for screening
// one: it throws away the label identifying hsbc.example.com as a bank, letting a stowaway bank
// cookie under an ordinary site through a check that was catching it.
test('screening a host keeps the labels that identify it, even though filing drops them', () => {
  const { isSensitiveSite } = require('../../api/services/session-import');

  // The label that matters is not the registrable domain.
  assert.equal(isSensitiveSite('hsbc.example.com'), true);
  assert.equal(isSensitiveSite('banking.example.com'), true);

  // A parent is still caught by the identity host beneath it, and vice versa.
  assert.equal(isSensitiveSite('google.com'), true);
  assert.equal(isSensitiveSite('accounts.google.com'), true);

  // Ordinary shops stay importable -- the point of the whole feature.
  for (const site of ['johnlewis.com', 'account.johnlewis.com', 'argos.co.uk', 'amazon.com']) {
    assert.equal(isSensitiveSite(site), false, `${site} must remain importable`);
  }
});

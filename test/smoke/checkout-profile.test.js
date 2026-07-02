'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyCheckoutAsk,
  findEmailInputElement,
  parseEmailFromUserText,
  wantsSaveEmailConsent,
  buildEmailAskWithConsent
} = require('../../api/services/checkout-profile');

test('classifyCheckoutAsk returns email for clear guest-checkout email asks', () => {
  for (const q of [
    'Please provide an email address for the guest checkout',
    'What is your email?',
    'Enter your email address to continue'
  ]) {
    assert.equal(classifyCheckoutAsk(q), 'email', q);
  }
});

test('classifyCheckoutAsk never classifies payment fields as email', () => {
  for (const q of [
    'Enter your card number',
    'What are your payment details?',
    'CVV required'
  ]) {
    assert.equal(classifyCheckoutAsk(q), null, q);
  }
});

test('classifyCheckoutAsk returns null for ambiguous non-email asks', () => {
  assert.equal(classifyCheckoutAsk('Which size would you like?'), null);
  assert.equal(classifyCheckoutAsk('What delivery address should I use?'), null);
});

test('findEmailInputElement matches email-labelled inputs only', () => {
  const elements = [
    { id: 0, text: 'Email address', locatorIndex: 3 },
    { id: 1, text: 'Card number', locatorIndex: 4 },
    { id: 2, text: 'Continue', locatorIndex: 5 }
  ];
  const found = findEmailInputElement(elements);
  assert.equal(found.id, 0);
  assert.equal(found.locatorIndex, 3);
});

test('parseEmailFromUserText extracts and normalises an email', () => {
  assert.equal(parseEmailFromUserText('use john@Example.COM please'), 'john@example.com');
  assert.equal(parseEmailFromUserText('no email here'), null);
});

test('wantsSaveEmailConsent detects explicit save opt-in', () => {
  assert.equal(wantsSaveEmailConsent('john@example.com save my email'), true);
  assert.equal(wantsSaveEmailConsent('john@example.com'), false);
});

test('buildEmailAskWithConsent appends save instructions once', () => {
  const q = buildEmailAskWithConsent('What email for guest checkout?');
  assert.match(q, /save my email/i);
  assert.equal(buildEmailAskWithConsent(q), q);
});
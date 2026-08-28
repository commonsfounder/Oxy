'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { matchesPaymentKeyword, isPaymentAdvance, isPaymentCommit } = require('../../api/services/transaction');

test('advancing to payment pauses for approval but does not charge', () => {
  // Matching is deliberate: it stops for the user before entering the payment page.
  // Treating it as the charge is the bug -- after clicking it, confirmPayment waited for an
  // order confirmation that nothing had triggered.
  for (const label of ['Continue to payment', 'Proceed to payment', 'Go to payment', 'Payment method']) {
    assert.equal(isPaymentAdvance(label), true, `${label} is an advance step`);
    assert.equal(matchesPaymentKeyword(label), true, `${label} should still pause for approval`);
    assert.equal(isPaymentCommit(label), false, `${label} must never count as the charge`);
  }
});

test('controls that actually take the money are commits', () => {
  for (const label of [
    'Pay now', 'Pay £48.75', 'Place order', 'Place your order', 'Confirm order',
    'Confirm and pay', 'Complete purchase', 'Submit order', 'Buy now', 'Pay securely'
  ]) {
    assert.equal(isPaymentCommit(label), true, `${label} should be a commit`);
    assert.equal(isPaymentAdvance(label), false, `${label} is not an advance step`);
  }
});

test('wallets are never a commit, since a headless browser cannot complete them', () => {
  for (const label of ['Apple Pay', 'Pay with PayPal', 'Google Pay', 'Klarna']) {
    assert.equal(isPaymentCommit(label), false);
    assert.equal(matchesPaymentKeyword(label), false);
  }
});

test('the confirm loop presses a commit button after only advancing', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../../api/services/transaction.js'), 'utf8');
  const fn = source.slice(source.indexOf('const deadline = Date.now() + CONFIRM_WATCH_BUDGET_MS'));
  const body = fn.slice(0, fn.indexOf('\n  touchSession(userId);'));
  assert.match(body, /isPaymentCommit\(/, 'the watch loop must look for a real commit control');
});

test('a saved card or card option is recognised, wallets are not', () => {
  const { isCardPaymentOption } = require('../../api/services/transaction');
  // From the real John Lewis payment page, which shows no pay button until one is chosen.
  for (const label of ['Mastercard ending in 2073', 'Credit / Debit card', 'Visa card ending 4464', 'Use saved card']) {
    assert.equal(isCardPaymentOption(label), true, `${label} should be a card option`);
  }
  for (const label of ['Apple Pay', 'PayPal Pay now with PayPal', 'Klarna', 'Add a promo code', 'Pay now']) {
    assert.equal(isCardPaymentOption(label), false, `${label} is not a card option`);
  }
});

test('a saved-card CVV box counts as a card field needing filling', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../../api/services/transaction.js'), 'utf8');
  const fn = source.slice(source.indexOf('async function paymentCardFieldsPresent'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  // Requiring a number field meant a saved card, which shows only a CVV, was never filled.
  assert.match(body, /\['number', 'cvc'\]/, 'cvc-only forms must count');
});

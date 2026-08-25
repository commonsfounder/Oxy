'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { matchesPaymentKeyword, isWalletPayment } = require('../../api/services/browser-task');

test('wallet buttons are not treated as payment controls', () => {
  // These need device biometrics or a redirect the server browser cannot complete, and they
  // render above the card form, so a first-match search always picked them.
  for (const label of [
    'Apple Pay', 'Buy with Apple Pay', 'Pay with Google Pay', 'G Pay',
    'PayPal', 'Pay with PayPal', 'Checkout with PayPal',
    'Amazon Pay', 'Shop Pay', 'Klarna', 'Pay in 3 with Klarna', 'Clearpay'
  ]) {
    assert.equal(isWalletPayment(label), true, `${label} should be a wallet`);
    assert.equal(matchesPaymentKeyword(label), false, `${label} must not match as payment`);
  }
});

test('real card payment controls still match', () => {
  for (const label of [
    'Pay now', 'Place order', 'Confirm order', 'Pay securely',
    'Pay with card', 'Complete purchase', 'Continue to payment', 'Submit order'
  ]) {
    assert.equal(isWalletPayment(label), false, `${label} is not a wallet`);
    assert.equal(matchesPaymentKeyword(label), true, `${label} must match as payment`);
  }
});

test('a card option is not disqualified by the word pay appearing near a wallet name', () => {
  assert.equal(matchesPaymentKeyword('Pay by debit or credit card'), true);
  assert.equal(matchesPaymentKeyword('Card payment'), false); // no pay-action verb
});

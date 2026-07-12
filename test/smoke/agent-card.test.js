const assert = require('node:assert/strict');
const test = require('node:test');

const {
  luhnValid,
  detectCardBrand,
  cardExpiryValid,
  normaliseAgentCard,
  agentCardSummary
} = require('../../api/services/agent-card');

const {
  classifyPaymentInput,
  formatCardValue,
  selectCandidatesFor,
  ORDER_CONFIRMED_PATTERN,
  PAYMENT_DECLINED_PATTERN,
  THREEDS_CHALLENGE_PATTERN
} = require('../../api/services/browser-task');

// Standard test PANs (Stripe test numbers) — Luhn-valid, never chargeable.
const VISA_TEST = '4242424242424242';
const AMEX_TEST = '378282246310005';

test('luhnValid accepts valid test PANs and rejects tampering', () => {
  assert.equal(luhnValid(VISA_TEST), true);
  assert.equal(luhnValid('4242 4242 4242 4242'), true); // spaces tolerated
  assert.equal(luhnValid(AMEX_TEST), true);
  assert.equal(luhnValid('4242424242424241'), false); // last digit off
  assert.equal(luhnValid('1234'), false); // too short
  assert.equal(luhnValid(''), false);
  assert.equal(luhnValid('4242abcd42424242'), false);
});

test('detectCardBrand recognises major brands', () => {
  assert.equal(detectCardBrand(VISA_TEST), 'visa');
  assert.equal(detectCardBrand('5555555555554444'), 'mastercard');
  assert.equal(detectCardBrand('2223003122003222'), 'mastercard'); // 2-series MC
  assert.equal(detectCardBrand(AMEX_TEST), 'amex');
  assert.equal(detectCardBrand('6011111111111117'), 'discover');
  assert.equal(detectCardBrand('9999999999999995'), 'card');
});

test('cardExpiryValid enforces month range and not-in-the-past', () => {
  const now = new Date('2026-07-12T00:00:00Z');
  assert.equal(cardExpiryValid(12, 2026, now), true);
  assert.equal(cardExpiryValid(7, 2026, now), true); // current month still valid
  assert.equal(cardExpiryValid(6, 2026, now), false); // last month
  assert.equal(cardExpiryValid(1, 2025, now), false);
  assert.equal(cardExpiryValid(13, 2027, now), false);
  assert.equal(cardExpiryValid(0, 2027, now), false);
  assert.equal(cardExpiryValid(5, 29, now), true); // 2-digit year normalised
  assert.equal(cardExpiryValid(5, 2099, now), false); // implausibly far future
});

test('normaliseAgentCard validates and normalises', () => {
  const good = normaliseAgentCard({
    name: ' Chizi G ', number: '4242 4242 4242 4242', expMonth: '9', expYear: '28', cvc: '123'
  });
  assert.equal(good.ok, true);
  assert.deepEqual(good.card, {
    name: 'Chizi G', number: VISA_TEST, expMonth: 9, expYear: 2028, cvc: '123'
  });

  assert.equal(normaliseAgentCard({ name: 'A', number: '1111', expMonth: 1, expYear: 2028, cvc: '123' }).ok, false);
  assert.equal(normaliseAgentCard({ name: 'A', number: VISA_TEST, expMonth: 1, expYear: 2020, cvc: '123' }).ok, false);
  assert.equal(normaliseAgentCard({ name: 'A', number: VISA_TEST, expMonth: 1, expYear: 2028, cvc: '12' }).ok, false);
  assert.equal(normaliseAgentCard({ name: '', number: VISA_TEST, expMonth: 1, expYear: 2028, cvc: '123' }).ok, false);
});

test('agentCardSummary masks everything but brand/last4/expiry/name', () => {
  const summary = agentCardSummary({ name: 'Chizi G', number: VISA_TEST, expMonth: 9, expYear: 2028, cvc: '123' });
  assert.deepEqual(summary, { brand: 'visa', last4: '4242', expMonth: 9, expYear: 2028, name: 'Chizi G' });
  assert.equal(JSON.stringify(summary).includes('4242424242424242'), false);
  assert.equal(JSON.stringify(summary).includes('123'), false);
  assert.equal(agentCardSummary(null), null);
});

// ---- browser-task payment field classification ----

test('classifyPaymentInput maps common merchant/PSP hints', () => {
  // Plain merchant forms
  assert.equal(classifyPaymentInput('cardNumber Card number'), 'number');
  assert.equal(classifyPaymentInput('input cc-number'), 'number');
  assert.equal(classifyPaymentInput('long card number'), 'number');
  assert.equal(classifyPaymentInput('nameOnCard Name on card'), 'name');
  assert.equal(classifyPaymentInput('cardholder-name'), 'name');
  assert.equal(classifyPaymentInput('expiryDate Expiry date MM/YY'), 'expiry');
  assert.equal(classifyPaymentInput('cc-exp'), 'expiry');
  assert.equal(classifyPaymentInput('valid thru'), 'expiry');
  assert.equal(classifyPaymentInput('expiry-month cc-exp-month'), 'exp_month');
  assert.equal(classifyPaymentInput('expiry_year'), 'exp_year');
  assert.equal(classifyPaymentInput('cvc CVC'), 'cvc');
  assert.equal(classifyPaymentInput('securityCode Security code'), 'cvc');
  assert.equal(classifyPaymentInput('card verification value'), 'cvc');
  assert.equal(classifyPaymentInput('billing zip'), 'postcode');
  // PSP hosted fields
  assert.equal(classifyPaymentInput('cardnumber cc-number Card number'), 'number'); // Stripe Elements
  assert.equal(classifyPaymentInput('encryptedCardNumber Card number'), 'number'); // Adyen
  assert.equal(classifyPaymentInput('credit-card-number Credit Card Number'), 'number'); // Braintree
  assert.equal(classifyPaymentInput('exp-date MM / YY'), 'expiry');
  // Precedence: cvc-ish text containing "number" must NOT classify as number
  assert.equal(classifyPaymentInput('card verification number'), 'cvc');
  // Non-payment fields stay out
  assert.equal(classifyPaymentInput('email Email address'), null);
  assert.equal(classifyPaymentInput('phone Mobile number'), null);
  assert.equal(classifyPaymentInput(''), null);
});

test('formatCardValue renders each field shape', () => {
  const card = { name: 'Chizi G', number: VISA_TEST, expMonth: 3, expYear: 2028, cvc: '123' };
  assert.equal(formatCardValue('number', card, null), VISA_TEST);
  assert.equal(formatCardValue('name', card, null), 'Chizi G');
  assert.equal(formatCardValue('cvc', card, null), '123');
  assert.equal(formatCardValue('expiry', card, null), '03/28');
  assert.equal(formatCardValue('exp_month', card, null), '03');
  assert.equal(formatCardValue('exp_year', card, null), '2028');
  // Billing postcode only with consented profile
  assert.equal(formatCardValue('postcode', card, { consent: true, address: { postcode: 'SW1A 1AA' } }), 'SW1A 1AA');
  assert.equal(formatCardValue('postcode', card, { consent: false, address: { postcode: 'SW1A 1AA' } }), null);
  assert.equal(formatCardValue('postcode', card, null), null);
});

test('selectCandidatesFor covers padded/unpadded/named month and 4/2-digit year', () => {
  const card = { expMonth: 3, expYear: 2028 };
  assert.deepEqual(selectCandidatesFor('exp_month', card), ['03', '3', 'March']);
  assert.deepEqual(selectCandidatesFor('exp_year', card), ['2028', '28']);
  assert.equal(selectCandidatesFor('number', card), null);
});

test('payment outcome patterns: confirmed is past-tense only', () => {
  // Real confirmations
  assert.match('Thank you for your order! Order number: 12345', ORDER_CONFIRMED_PATTERN);
  assert.match('Your booking is confirmed', ORDER_CONFIRMED_PATTERN);
  assert.match("We've received your order", ORDER_CONFIRMED_PATTERN);
  assert.match('Payment successful', ORDER_CONFIRMED_PATTERN);
  // Pre-payment checkout copy must NOT read as confirmed
  assert.doesNotMatch("We'll send you a confirmation email once you place your order", ORDER_CONFIRMED_PATTERN);
  assert.doesNotMatch('Order summary — review your order before payment', ORDER_CONFIRMED_PATTERN);
  assert.doesNotMatch('Continue to payment', ORDER_CONFIRMED_PATTERN);
});

test('payment outcome patterns: declined and 3DS', () => {
  assert.match('Your card was declined.', PAYMENT_DECLINED_PATTERN);
  assert.match('Payment failed — please check your card details', PAYMENT_DECLINED_PATTERN);
  assert.match('Invalid security code', PAYMENT_DECLINED_PATTERN);
  assert.match('Verify your payment with your bank', THREEDS_CHALLENGE_PATTERN);
  assert.match('3-D Secure authentication required', THREEDS_CHALLENGE_PATTERN);
  assert.match('Enter the one-time passcode we sent to your phone', THREEDS_CHALLENGE_PATTERN);
  assert.doesNotMatch('Pay securely with card', THREEDS_CHALLENGE_PATTERN);
});

'use strict';

// Reading the amount before asking to spend it.
//
// tryPaymentReady is, by its own comment, "the one place every ready_for_payment path
// funnels through" -- and it returned `total: ''`. So the agent reached a real John Lewis
// payment step and offered "I'll pay with your visa ending 4464, say the word" without the
// amount appearing anywhere: not in the reply, not in its task steps, not in its events.
//
// A yes to an unknown sum is not consent. This reads the total off the page so the amount
// can be shown, and reports nothing rather than guessing when it cannot find one.

const assert = require('node:assert/strict');
const test = require('node:test');

const { readOrderTotal } = require('../../api/services/order-total');

test('the order total is read from ordinary checkout wording', () => {
  assert.equal(readOrderTotal('Subtotal £65.00 Delivery Free Total £65.00'), '£65.00');
  assert.equal(readOrderTotal('Order total: £48.75'), '£48.75');
  assert.equal(readOrderTotal('Total to pay £1,204.99'), '£1,204.99');
  assert.equal(readOrderTotal('Amount to pay: £9.99'), '£9.99');
});

test('the most specific total wins when a page shows several', () => {
  // A checkout page carries a basket subtotal, a delivery line and the real figure. Picking
  // the first pound sign on the page would report the subtotal and understate the charge.
  const page = 'Basket subtotal £65.00 Delivery £4.95 Order total £69.95 Continue to pay';
  assert.equal(readOrderTotal(page), '£69.95');

  // "Total to pay" is more specific than a bare "Total" and must win.
  const page2 = 'Total £65.00 Promotional discount -£16.25 Total to pay £48.75';
  assert.equal(readOrderTotal(page2), '£48.75');
});

test('a discounted total is read as the amount actually charged', () => {
  // The whole point for a staff discount: the figure that matters is what leaves the card,
  // not the list price sitting above it.
  const page = 'it luggage Replicating Spinner £65.00 Partner discount -£16.25 Order total £48.75';
  assert.equal(readOrderTotal(page), '£48.75');
});

test('an unreadable page returns nothing rather than a plausible-looking guess', () => {
  // Returning some other number from the page would be worse than returning none: it would
  // be shown to the user as the amount they are approving.
  assert.equal(readOrderTotal('Checkout — payment step'), null);
  assert.equal(readOrderTotal('Recommended for you £55.00 £44.00 £85.00'), null);
  assert.equal(readOrderTotal(''), null);
  assert.equal(readOrderTotal(null), null);
});

test('pence are required, so a bare pound figure is not mistaken for a total', () => {
  // "Total 65" or "£65" without pence is more often marketing copy than a checkout figure.
  assert.equal(readOrderTotal('Total £65'), null);
  assert.equal(readOrderTotal('Order total £65.00'), '£65.00');
});

test('other currencies are read too, since the agent is not UK-only by design', () => {
  assert.equal(readOrderTotal('Order total $48.75'), '$48.75');
  assert.equal(readOrderTotal('Total to pay €120.00'), '€120.00');
});

// Tripwire on the gate itself.
//
// The pure reader above is only useful if the payment path actually calls it. The bug was
// not a bad total, it was a hardcoded empty one shipped straight to the user as an offer to
// charge their card.
test('the payment gate reads a total and refuses to offer payment without one', () => {
  const fs = require('node:fs');
  // The gate now lives in the general transaction layer, and is reached the same way for a
  // retail checkout, a train ticket or a council payment.
  const source = fs.readFileSync(require.resolve('../../api/services/transaction.js'), 'utf8');
  const stripped = source.replace(/\/\/[^\n]*/g, '');

  // prepare() reads the amount with the parser rather than accepting anything it was told.
  const prepare = stripped.slice(stripped.indexOf('async function prepare('));
  assert.match(prepare.slice(0, prepare.indexOf('\n}\n')), /const money = await readAmount\(page\)/);
  // ...and commit() re-reads it, so approval cannot be spent against a figure that changed.
  const commit = stripped.slice(stripped.indexOf('async function commit('));
  assert.match(commit.slice(0, commit.indexOf('\n}\n')), /const money = await readAmount\(page\)/);

  // And nothing may offer payment without one: the handler refuses rather than asking the
  // person to approve a blank.
  const handler = fs.readFileSync(require.resolve('../../api/actions/browser.js'), 'utf8');
  assert.match(handler, /if \(!result\.raw\)/);
  assert.match(handler, /could not read a total on the page/);
});

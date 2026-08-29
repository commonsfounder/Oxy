// Receipt extraction and spend aggregation (api/services/receipts.js). Most of these tests
// exist to prove a NEGATIVE: that a number which was never charged does not become spending.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isReceiptLike,
  extractReceipt,
  extractOrderId,
  extractItems,
  merchantFromSender,
  parseAmount,
  summarizeSpend,
  classifyCategory,
  formatSpendSummary,
  formatPurchaseLine
} = require('../../api/services/receipts');

const normalReceipt = {
  id: 'msg-1',
  threadId: 'thr-1',
  senderName: 'Nike',
  senderAddress: 'no-reply@order.nike.com',
  subject: 'Your Nike order confirmation',
  date: 'Tue, 14 Jul 2026 10:04:00 +0100',
  body: [
    'Thanks for your order.',
    'Order number: NK4471902',
    '1 x Nike Pegasus 41 £104.95',
    'Delivery £0.00',
    'Order total: £104.95'
  ].join('\n')
};

const promotional = {
  id: 'msg-2',
  senderName: 'Nike',
  senderAddress: 'news@nike.com',
  subject: 'Up to 40% off — shop now',
  date: 'Tue, 14 Jul 2026 10:04:00 +0100',
  body: [
    'Pegasus 41 was £104.95 now £62.97',
    'Air Max £129.99',
    'Shop now and save up to 40%'
  ].join('\n')
};

// ── The core negative ──────────────────────────────────────────────────────────────────
test('a promotional email full of prices produces no purchase at all', () => {
  assert.equal(isReceiptLike(promotional), false);
  assert.equal(extractReceipt(promotional), null);
});

test('a bare price with no total label is never read as a charge', () => {
  const vague = {
    id: 'msg-3',
    senderAddress: 'hello@shop.example.com',
    subject: 'Your order',
    date: 'Tue, 14 Jul 2026 10:04:00 +0100',
    body: 'We have received your order. Items in your basket: £42.00. We will email you when it ships.'
  };
  const extracted = extractReceipt(vague);
  // The email genuinely is transactional, so it may be recorded — but with NO total, since
  // "£42.00" is never labelled as what was charged.
  assert.equal(extracted?.totalAmount ?? null, null);
});

test('an email with neither a total nor an order reference is not a record', () => {
  const empty = {
    id: 'msg-4', senderAddress: 'hello@shop.example.com',
    subject: 'Your order', date: 'Tue, 14 Jul 2026 10:04:00 +0100',
    body: 'We have received your order and will be in touch.'
  };
  assert.equal(extractReceipt(empty), null);
});

// ── Normal receipt ─────────────────────────────────────────────────────────────────────
test('a normal receipt yields merchant, date, total, currency, order id and items', () => {
  const extracted = extractReceipt(normalReceipt);
  assert.equal(extracted.merchant, 'Nike');
  assert.equal(extracted.merchantDomain, 'nike.com');
  assert.equal(extracted.totalAmount, 104.95);
  assert.equal(extracted.currency, 'GBP');
  assert.equal(extracted.orderId, 'NK4471902');
  assert.equal(extracted.status, 'confirmed');
  assert.equal(extracted.extractionConfidence, 'high');
  assert.equal(extracted.rawTotalText, 'Order total: £104.95');
  assert.deepEqual(extracted.items, [{ quantity: 1, name: 'Nike Pegasus 41' }]);
  assert.equal(new Date(extracted.purchasedAt).getUTCDate(), 14);
});

test('an order confirmation from a no-reply address is still a receipt', () => {
  // Sender shape must not decide this — real receipts almost always come from no-reply@.
  const extracted = extractReceipt({
    id: 'msg-5', senderName: 'no-reply', senderAddress: 'no-reply@amazon.co.uk',
    subject: 'Your Amazon.co.uk order #205-3384710-1122334',
    date: 'Tue, 14 Jul 2026 10:04:00 +0100',
    body: 'Order Total: £27.48\nDelivery estimate: Thursday'
  });
  assert.equal(extracted.merchant, 'Amazon');
  assert.equal(extracted.totalAmount, 27.48);
  assert.equal(extracted.orderId, '205-3384710-1122334');
});

// ── Refund ─────────────────────────────────────────────────────────────────────────────
test('a refund is marked as one and carries the refunded amount', () => {
  const extracted = extractReceipt({
    id: 'msg-6', senderName: 'ASOS', senderAddress: 'no-reply@asos.com',
    subject: 'Your refund has been processed',
    date: 'Fri, 25 Jul 2026 09:00:00 +0100',
    body: 'Order reference: AS99120344\nRefund amount: £38.00\nIt may take 5 days to appear.'
  });
  assert.equal(extracted.status, 'refunded');
  assert.equal(extracted.refundAmount, 38);
  assert.equal(extracted.currency, 'GBP');
});

test('a refund nets off the original spend rather than counting as more of it', () => {
  const summary = summarizeSpend([
    { total_amount: 104.95, currency: 'GBP', status: 'confirmed' },
    { total_amount: 38, currency: 'GBP', status: 'refunded', refund_amount: 38 }
  ]);
  assert.deepEqual(summary.totals, [{ currency: 'GBP', total: 104.95, count: 2 }]);
  assert.equal(summary.refunded, 1);
});

test('a partial refund leaves the part that was actually kept', () => {
  const summary = summarizeSpend([
    { total_amount: 100, currency: 'GBP', status: 'refunded', refund_amount: 30 }
  ]);
  assert.deepEqual(summary.totals, [{ currency: 'GBP', total: 70, count: 1 }]);
});

// ── Multiple currencies ────────────────────────────────────────────────────────────────
test('currencies are kept separate and never added together', () => {
  const summary = summarizeSpend([
    { total_amount: 100, currency: 'GBP', status: 'confirmed' },
    { total_amount: 50, currency: 'USD', status: 'confirmed' },
    { total_amount: 20, currency: 'EUR', status: 'confirmed' }
  ]);
  assert.equal(summary.totals.length, 3);
  const text = formatSpendSummary([
    { total_amount: 100, currency: 'GBP', status: 'confirmed', source: 'email_receipt' },
    { total_amount: 50, currency: 'USD', status: 'confirmed', source: 'email_receipt' }
  ], {});
  assert.match(text, /£100\.00 \+ \$50\.00/);
  assert.match(text, /I have not converted them/);
});

test('a dollar and euro receipt are read with their real currency, not defaulted to sterling', () => {
  const usd = extractReceipt({
    id: 'm', senderName: 'Apple', senderAddress: 'no_reply@email.apple.com',
    subject: 'Your receipt from Apple', date: 'Tue, 14 Jul 2026 10:04:00 +0100',
    body: 'Order ID: MLK4491X\nTOTAL: $19.99'
  });
  assert.equal(usd.currency, 'USD');
  assert.equal(usd.totalAmount, 19.99);
  assert.equal(parseAmount('€12,50').currency, 'EUR');
});

// ── Recurring / subscription ───────────────────────────────────────────────────────────
test('a subscription renewal is flagged as recurring without inventing a schedule', () => {
  const extracted = extractReceipt({
    id: 'm', senderName: 'Spotify', senderAddress: 'no-reply@spotify.com',
    subject: 'Your Spotify Premium receipt', date: 'Tue, 1 Jul 2026 10:04:00 +0100',
    body: 'Invoice number: SP-88213\nYour plan renews monthly.\nTotal charged: £11.99'
  });
  assert.equal(extracted.recurring, true);
  assert.equal(extracted.totalAmount, 11.99);
  assert.equal(classifyCategory('Spotify', '').category, 'subscriptions');
});

// ── Duplicates ─────────────────────────────────────────────────────────────────────────
test('the order confirmation and the shipping note for one order share an order id', () => {
  // This is what the (user, merchant, order_id) unique index keys on so one order cannot be
  // counted twice from two emails.
  const confirmation = extractReceipt(normalReceipt);
  const shipping = extractReceipt({
    ...normalReceipt,
    id: 'msg-1b',
    subject: 'Your Nike order has shipped',
    body: 'Order number: NK4471902\nOrder total: £104.95\nTrack it: https://track.example.com/NK4471902'
  });
  assert.equal(confirmation.orderId, shipping.orderId);
  assert.equal(confirmation.merchant, shipping.merchant);
  assert.match(shipping.trackingUrl, /^https:\/\/track\.example\.com/);
});

// ── Parsing helpers ────────────────────────────────────────────────────────────────────
test('an order id must actually look like an identifier', () => {
  assert.equal(extractOrderId('Order number: NK4471902'), 'NK4471902');
  assert.equal(extractOrderId('Order date: 2026'), null, 'a bare year is not an order id');
  assert.equal(extractOrderId('Order reference: ABCDEFG'), null, 'letters alone are not an order id');
});

test('a merchant is derived from the sending domain, not a no-reply display name', () => {
  assert.deepEqual(
    merchantFromSender({ senderName: 'no-reply', senderAddress: 'no-reply@mail.notifications.nike.com' }),
    { merchant: 'Nike', domain: 'nike.com' }
  );
  assert.equal(merchantFromSender({ senderName: 'Currys', senderAddress: 'x@currys.co.uk' }).merchant, 'Currys');
});

test('a compound country suffix does not collapse every UK merchant into "Co"', () => {
  // Naive "last two labels" logic turned amazon.co.uk into co.uk and named the merchant Co.
  assert.deepEqual(
    merchantFromSender({ senderName: 'no-reply', senderAddress: 'no-reply@mail.amazon.co.uk' }),
    { merchant: 'Amazon', domain: 'amazon.co.uk' }
  );
  assert.equal(merchantFromSender({ senderName: 'orders', senderAddress: 'x@shop.myer.com.au' }).domain, 'myer.com.au');
});

test('item extraction only fires on an unambiguous quantity-and-price line', () => {
  assert.deepEqual(extractItems('2 x Wool socks £14.00'), [{ quantity: 2, name: 'Wool socks' }]);
  assert.deepEqual(extractItems('Thanks for shopping with us, here is 20% off'), []);
});

// ── Honest reporting ───────────────────────────────────────────────────────────────────
test('every spend answer states that there is no bank feed behind it', () => {
  const text = formatSpendSummary([
    { total_amount: 104.95, currency: 'GBP', status: 'confirmed', source: 'email_receipt' }
  ], { since: '1 July' });
  assert.match(text, /£104\.95 across 1 record/);
  assert.match(text, /1 from receipts in your connected email/);
  assert.match(text, /no bank or card feed connected/);
});

test('records with no readable total are excluded from the figure and said to be', () => {
  const text = formatSpendSummary([
    { total_amount: 50, currency: 'GBP', status: 'confirmed', source: 'email_receipt' },
    { total_amount: null, currency: null, status: 'confirmed', source: 'email_receipt' }
  ], {});
  assert.match(text, /£50\.00 across 2 records/);
  assert.match(text, /1 record had no reliably-stated total/);
});

test('an unreachable mailbox is admitted rather than reported as zero spending', () => {
  const text = formatSpendSummary([], { emailSearched: false, emailError: 'Google is not connected' });
  assert.match(text, /found no receipts or orders/);
  assert.match(text, /could not search your email \(Google is not connected\)/);
});

test('"through Adam" scopes the caveat to what Adam itself placed', () => {
  const text = formatSpendSummary(
    [{ total_amount: 42, currency: 'GBP', status: 'confirmed', source: 'millie_browser' }],
    { sources: ['millie_browser'] }
  );
  assert.match(text, /1 ordered through me/);
  assert.match(text, /only orders placed through me, not your wider spending/);
});

test('an unconfident category is excluded and reported, not guessed into the total', () => {
  const text = formatSpendSummary(
    [{ total_amount: 42, currency: 'GBP', status: 'confirmed', source: 'email_receipt' }],
    { categoryQuery: 'clothes', unclassified: 3 }
  );
  assert.match(text, /3 could not be confidently classified as clothes/);
  assert.equal(classifyCategory('Some Local Shop', 'Your order').confident, false);
  assert.equal(classifyCategory('ASOS', '').category, 'clothes');
});

test('a purchase line names what was observed, including a missing amount', () => {
  assert.equal(
    formatPurchaseLine({ merchant: 'Nike', total_amount: 104.95, currency: 'GBP', purchased_at: '2026-07-14T09:04:00Z', order_id: 'NK4471902' }),
    'Nike — £104.95 — 14 Jul 2026 — order NK4471902'
  );
  assert.match(
    formatPurchaseLine({ merchant: 'Nike', total_amount: null, currency: null, purchased_at: '2026-07-14T09:04:00Z' }),
    /amount not stated/
  );
});

test('a mailbox that could not be re-read is flagged as staleness, not as "only Adam orders"', () => {
  // The naive version of this caveat claimed stored email receipts were Adam's own orders
  // whenever the live mailbox search failed.
  const text = formatSpendSummary(
    [{ total_amount: 104.95, currency: 'GBP', status: 'confirmed', source: 'email_receipt' }],
    { emailSearched: false, emailError: 'Google is not connected' }
  );
  assert.match(text, /1 from receipts in your connected email/);
  assert.match(text, /no bank or card feed connected/);
  assert.match(text, /could not re-check your mailbox just now \(Google is not connected\)/);
  assert.doesNotMatch(text, /only orders placed through me/);
});

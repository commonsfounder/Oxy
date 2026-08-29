// find_spend and the Adam-purchase record against the REAL purchases table and
// demo-test-user. The Gmail leg genuinely cannot run for this account (no Google
// connection), which is exactly what the honest-coverage assertions here depend on.

require('dotenv').config();

const assert = require('node:assert/strict');
const test = require('node:test');

const app = require('../../api/index');
const transaction = require('../../api/services/transaction');
const { createSupabaseServiceClient } = require('../../runtime');

const supabase = createSupabaseServiceClient();
const USER_ID = 'demo-test-user';
const MERCHANTS = ['SpendTestNike', 'SpendTestApple', 'SpendTestAsos', 'Spendtest-shop'];

async function cleanup() {
  await supabase.from('purchases').delete().eq('user_id', USER_ID).in('merchant', MERCHANTS);
  await supabase.from('purchases').delete().eq('user_id', USER_ID).like('source_ref', 'https://spendtest%');
}

test.beforeEach(cleanup);
test.after(cleanup);

async function seed(rows) {
  const { error } = await supabase.from('purchases').insert(rows.map(row => ({
    user_id: USER_ID, source: 'email_receipt', status: 'confirmed', ...row
  })));
  if (error) throw new Error(error.message);
}

test('find_spend sums real stored records and never hides that there is no bank feed', async () => {
  await seed([
    { merchant: 'SpendTestNike', purchased_at: '2026-07-14T10:00:00Z', total_amount: 104.95, currency: 'GBP', order_id: 'NK1', source_ref: 'spendtest-1' },
    { merchant: 'SpendTestApple', purchased_at: '2026-07-20T10:00:00Z', total_amount: 19.99, currency: 'GBP', order_id: 'AP1', source_ref: 'spendtest-2' }
  ]);

  const result = await app.executeAction(USER_ID, 'find_spend', { since: '2026-07-01', before: '2026-08-01' });
  assert.equal(result.success, true);
  const mine = result.purchases.filter(p => MERCHANTS.includes(p.merchant));
  assert.equal(mine.length, 2);
  assert.match(result.text, /no bank or card feed connected/);
  assert.equal(result.coverage.bankFeed, false);
});

test('a merchant filter narrows to that merchant, with the source message still attached', async () => {
  await seed([
    { merchant: 'SpendTestNike', purchased_at: '2026-07-14T10:00:00Z', total_amount: 104.95, currency: 'GBP', order_id: 'NK1', source_ref: 'spendtest-1', source_thread_id: 'thr-nike' },
    { merchant: 'SpendTestApple', purchased_at: '2026-07-20T10:00:00Z', total_amount: 19.99, currency: 'GBP', order_id: 'AP1', source_ref: 'spendtest-2' }
  ]);

  const result = await app.executeAction(USER_ID, 'find_spend', { merchant: 'SpendTestNike' });
  const mine = result.purchases.filter(p => MERCHANTS.includes(p.merchant));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].merchant, 'SpendTestNike');
  assert.equal(mine[0].threadId, 'thr-nike', '"show me that receipt" needs the real thread');
  assert.equal(mine[0].messageId, 'spendtest-1');
});

test('a date window genuinely excludes what falls outside it', async () => {
  await seed([
    { merchant: 'SpendTestNike', purchased_at: '2026-05-14T10:00:00Z', total_amount: 104.95, currency: 'GBP', source_ref: 'spendtest-old' },
    { merchant: 'SpendTestApple', purchased_at: '2026-07-20T10:00:00Z', total_amount: 19.99, currency: 'GBP', source_ref: 'spendtest-new' }
  ]);

  const result = await app.executeAction(USER_ID, 'find_spend', { since: '2026-07-01' });
  const mine = result.purchases.filter(p => MERCHANTS.includes(p.merchant));
  assert.deepEqual(mine.map(p => p.merchant), ['SpendTestApple']);
});

test('re-scanning the same receipt does not double-count it', async () => {
  await seed([{ merchant: 'SpendTestNike', purchased_at: '2026-07-14T10:00:00Z', total_amount: 104.95, currency: 'GBP', order_id: 'NK1', source_ref: 'spendtest-dupe' }]);
  // The unique index on (user_id, source_ref) is what makes a rescan idempotent.
  const { error } = await supabase.from('purchases').insert({
    user_id: USER_ID, source: 'email_receipt', merchant: 'SpendTestNike',
    purchased_at: '2026-07-14T10:00:00Z', total_amount: 104.95, currency: 'GBP', source_ref: 'spendtest-dupe'
  });
  assert.ok(error, 'a second row for the same source document must be rejected by the database');

  const result = await app.executeAction(USER_ID, 'find_spend', { merchant: 'SpendTestNike' });
  assert.equal(result.purchases.filter(p => p.merchant === 'SpendTestNike').length, 1);
});

test('a refunded order is netted off rather than counted as spending', async () => {
  await seed([
    { merchant: 'SpendTestAsos', purchased_at: '2026-07-14T10:00:00Z', total_amount: 80, currency: 'GBP', source_ref: 'spendtest-r1' },
    { merchant: 'SpendTestAsos', purchased_at: '2026-07-18T10:00:00Z', total_amount: 38, currency: 'GBP', status: 'refunded', refund_amount: 38, source_ref: 'spendtest-r2' }
  ]);

  const result = await app.executeAction(USER_ID, 'find_spend', { merchant: 'SpendTestAsos' });
  assert.equal(result.summary.totals.find(t => t.currency === 'GBP').total, 80);
  assert.equal(result.summary.refunded, 1);
});

test('multiple currencies are reported separately in the real query path too', async () => {
  await seed([
    { merchant: 'SpendTestNike', purchased_at: '2026-07-14T10:00:00Z', total_amount: 100, currency: 'GBP', source_ref: 'spendtest-c1' },
    { merchant: 'SpendTestApple', purchased_at: '2026-07-15T10:00:00Z', total_amount: 50, currency: 'USD', source_ref: 'spendtest-c2' }
  ]);
  const result = await app.executeAction(USER_ID, 'find_spend', { since: '2026-07-01', before: '2026-08-01' });
  const currencies = result.summary.totals.map(t => t.currency);
  assert.ok(currencies.includes('GBP') && currencies.includes('USD'));
  assert.match(result.text, /not converted them/);
});

test('a record with no readable total is kept but excluded from the sum', async () => {
  await seed([
    { merchant: 'SpendTestNike', purchased_at: '2026-07-14T10:00:00Z', total_amount: 60, currency: 'GBP', source_ref: 'spendtest-p1' },
    { merchant: 'SpendTestApple', purchased_at: '2026-07-15T10:00:00Z', total_amount: null, currency: null, source_ref: 'spendtest-p2' }
  ]);
  const result = await app.executeAction(USER_ID, 'find_spend', { since: '2026-07-01', before: '2026-08-01' });
  const mine = result.purchases.filter(p => MERCHANTS.includes(p.merchant));
  assert.equal(mine.length, 2, 'the unpriced order is still a real order');
  assert.ok(result.summary.unpriced >= 1);
  assert.match(result.text, /no reliably-stated total/);
});

test('the email leg reports its own failure instead of implying zero spending', async () => {
  // demo-test-user has no Google connection, so this is a genuine failure, not a stub.
  const result = await app.executeAction(USER_ID, 'find_spend', {});
  assert.equal(result.coverage.emailSearched, false);
  assert.ok(result.coverage.emailError, 'a failed mailbox search must carry a reason');
});

test('"through Adam" returns only what Adam itself placed', async () => {
  await seed([{ merchant: 'SpendTestNike', purchased_at: '2026-07-14T10:00:00Z', total_amount: 104.95, currency: 'GBP', source_ref: 'spendtest-m1' }]);
  await supabase.from('purchases').insert({
    user_id: USER_ID, source: 'millie_browser', merchant: 'Spendtest-shop',
    purchased_at: new Date().toISOString(), total_amount: 42.5, currency: 'GBP',
    order_id: 'MB-1', source_ref: 'https://spendtest-shop.example/order-confirmation'
  });

  const result = await app.executeAction(USER_ID, 'find_spend', { sources: 'adam' });
  assert.ok(result.purchases.length >= 1);
  assert.ok(result.purchases.every(p => p.source === 'millie_browser'));
  assert.match(result.text, /only orders placed through me/);
});

// ── The Adam purchase record itself ──────────────────────────────────────────────────
test('a confirmed browser order is recorded at confirmation time, from what was observed', async () => {
  // The real recorder, with a fake session standing in for a live browser — the row it
  // writes, and what it refuses to invent, is the thing under test.
  const session = {
    site: 'www.spendtest-shop.example',
    goal: 'buy a pair of wool socks',
    pendingPaymentTotal: '£24.50',
    page: { url: () => 'https://spendtest-shop.example/order-confirmation?id=9' }
  };
  const id = await transaction.recordConfirmedPurchase(USER_ID, session, 'Thank you for your order. Order number: SHOP-88213. Order total: £24.50');
  assert.ok(id, 'the purchase should have been written');

  const { data } = await supabase.from('purchases').select('*').eq('id', id).single();
  assert.equal(data.source, 'millie_browser');
  assert.equal(data.merchant, 'Spendtest-shop');
  assert.equal(data.merchant_domain, 'spendtest-shop.example');
  assert.equal(Number(data.total_amount), 24.5);
  assert.equal(data.currency, 'GBP');
  assert.equal(data.order_id, 'SHOP-88213');
  assert.equal(data.description, 'buy a pair of wool socks');
  assert.equal(data.raw_total_text, '£24.50');

  // And it is immediately answerable via the normal spend query.
  const result = await app.executeAction(USER_ID, 'find_spend', { sources: 'adam', merchant: 'Spendtest-shop' });
  assert.equal(result.purchases[0].orderId, 'SHOP-88213');
});

test('a confirmed order with no readable total is still recorded, with no invented amount', async () => {
  const session = {
    site: 'spendtest-shop.example',
    goal: 'buy a lamp',
    pendingPaymentTotal: '',
    page: { url: () => 'https://spendtest-shop.example/thank-you' }
  };
  const id = await transaction.recordConfirmedPurchase(USER_ID, session, 'Thanks for your order! We will email you shortly.');
  assert.ok(id);
  const { data } = await supabase.from('purchases').select('total_amount, currency, order_id').eq('id', id).single();
  assert.equal(data.total_amount, null);
  assert.equal(data.currency, null);
  assert.equal(data.order_id, null);
});

test('recording the same confirmation twice does not create a second order', async () => {
  const session = {
    site: 'spendtest-shop.example', goal: 'buy a lamp', pendingPaymentTotal: '£10.00',
    page: { url: () => 'https://spendtest-shop.example/order-confirmation?id=dupe' }
  };
  await transaction.recordConfirmedPurchase(USER_ID, session, 'Order number: DUPE-1. Order total: £10.00');
  await transaction.recordConfirmedPurchase(USER_ID, session, 'Order number: DUPE-1. Order total: £10.00');

  const { data } = await supabase.from('purchases').select('id')
    .eq('user_id', USER_ID).eq('source_ref', 'https://spendtest-shop.example/order-confirmation?id=dupe');
  assert.equal(data.length, 1);
});

test('an order is findable by what it WAS, not only by which shop sold it', () => {
  // Live testing found this: "what did that sock order cost?" returned nothing, because only
  // the merchant was searchable and the user remembered the item, not the shop.
  return (async () => {
    await supabase.from('purchases').insert({
      user_id: USER_ID, source: 'millie_browser', merchant: 'Spendtest-shop',
      purchased_at: new Date().toISOString(), total_amount: 24.5, currency: 'GBP',
      order_id: 'SOCK-1', description: 'buy a pair of wool socks',
      source_ref: 'https://spendtest-shop.example/order-confirmation?id=socks'
    });

    const result = await app.executeAction(USER_ID, 'find_spend', { query: 'socks', sources: 'adam' });
    const found = result.purchases.find(p => p.orderId === 'SOCK-1');
    assert.ok(found, 'the order should be findable by its item description');
    assert.equal(Number(found.amount), 24.5);
  })();
});

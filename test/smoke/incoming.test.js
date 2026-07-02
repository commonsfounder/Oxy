// test/smoke/incoming.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const { extractIncoming } = require('../../api/services/incoming');

test('detects an out-for-delivery shipment with stage 2', () => {
  const items = extractIncoming([
    { from: 'Amazon.co.uk <ship-confirm@amazon.co.uk>',
      subject: 'Your package is out for delivery',
      snippet: 'Sony WH-1000XM5 will arrive today by 6pm', date: '2026-06-25T08:00:00Z' }
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'delivery');
  assert.equal(items[0].vendor, 'Amazon');
  assert.equal(items[0].stage, 2);
  assert.match(items[0].status, /out for delivery/i);
});

test('detects a reservation with no progress stage', () => {
  const items = extractIncoming([
    { from: 'OpenTable <reservations@opentable.com>',
      subject: 'Your reservation at Lasan is confirmed',
      snippet: 'Table for 2 on Saturday 8:00pm', date: '2026-06-24T10:00:00Z' }
  ]);
  assert.equal(items[0].kind, 'reservation');
  assert.equal(items[0].stage, null);
  assert.match(items[0].title, /Lasan/);
});

test('ignores ordinary mail', () => {
  const items = extractIncoming([
    { from: 'Sarah <sarah@example.com>', subject: 'Re: Friday', snippet: 'does the venue still work?', date: null }
  ]);
  assert.deepEqual(items, []);
});

test('maps shipped vs delivered to stages 1 and 3', () => {
  const shipped = extractIncoming([
    { from: 'shipment-tracking@amazon.co.uk', subject: 'Your order has shipped', snippet: 'on its way', date: null }
  ]);
  assert.equal(shipped[0].stage, 1);
  const delivered = extractIncoming([
    { from: 'auto-confirm@amazon.co.uk', subject: 'Delivered: your package', snippet: 'left at front door', date: null }
  ]);
  assert.equal(delivered[0].stage, 3);
});

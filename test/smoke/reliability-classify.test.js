'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyOutcome, LOOP_FAILURE_BUCKETS, INFRA_BUCKETS } = require('../dev/reliability-classify');

test('a done answer to a lookup is a pass', () => {
  assert.equal(classifyOutcome('answer', { type: 'done', text: 'It is £27.00' }), 'pass');
});

test('a cart case that reaches the pay guardrail is a pass', () => {
  assert.equal(classifyOutcome('cart', { type: 'ready_for_payment', summary: '1 pizza', total: '£12' }), 'pass');
});

test('a cart case that ends in done never built a cart → wrong', () => {
  assert.equal(classifyOutcome('cart', { type: 'done', text: 'ok' }), 'wrong');
});

test('a blocked/stripped page is an infra ceiling, not a loop failure', () => {
  const b = classifyOutcome('answer', { type: 'error', error: 'the site may be blocking automated access' });
  assert.equal(b, 'botwall');
  assert.ok(INFRA_BUCKETS.has(b));
  assert.ok(!LOOP_FAILURE_BUCKETS.has(b));
});

test('a "couldn\'t load the page properly" error is also a bot-wall ceiling', () => {
  assert.equal(classifyOutcome('answer', { type: 'error', error: "I couldn't load the page properly just now" }), 'botwall');
});

test('a stuck error is a loop failure', () => {
  const b = classifyOutcome('answer', { type: 'error', error: 'I got stuck on this page and couldn\'t make progress' });
  assert.equal(b, 'stuck');
  assert.ok(LOOP_FAILURE_BUCKETS.has(b));
});

test('reauth is an infra ceiling (needs a login we do not have)', () => {
  const b = classifyOutcome('answer', { type: 'reauth', site: 'x.com', question: 'sign in again' });
  assert.equal(b, 'reauth');
  assert.ok(INFRA_BUCKETS.has(b));
});

test('running out of turns (awaiting_more) is incomplete', () => {
  assert.equal(classifyOutcome('answer', { type: 'awaiting_more', summary: 'still going' }), 'incomplete');
});

test('the runaway-watchdog ask is incomplete, not a real fork', () => {
  assert.equal(classifyOutcome('cart', { type: 'ask', question: 'This order is taking an unusually long time — want me to keep trying?' }), 'incomplete');
});

test('a null/garbage outcome is threw', () => {
  assert.equal(classifyOutcome('answer', null), 'threw');
  assert.equal(classifyOutcome('answer', undefined), 'threw');
});

test('every loop-failure and infra bucket is disjoint from pass', () => {
  for (const b of LOOP_FAILURE_BUCKETS) assert.notEqual(b, 'pass');
  for (const b of INFRA_BUCKETS) assert.notEqual(b, 'pass');
});

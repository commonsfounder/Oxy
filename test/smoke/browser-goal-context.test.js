'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseGoalContext,
  extractSize,
  extractColor,
  extractBudget,
  extractDealHints
} = require('../../api/services/browser-goal-context');

test('extractSize handles common forms', () => {
  assert.equal(extractSize('joggers size M'), 'm');
  assert.equal(extractSize('size uk 9 trainers'), 'uk 9');
  assert.equal(extractSize('the large fleece'), 'large');
  assert.equal(extractSize('XL hoodie'), 'xl');
  assert.equal(extractSize('no size here at all'), null);
});

test('extractColor pulls common colors', () => {
  assert.equal(extractColor('navy joggers'), 'navy');
  assert.equal(extractColor('black size m'), 'black');
  assert.equal(extractColor('stone wash denim'), 'stone');
});

test('extractBudget parses max price', () => {
  assert.equal(extractBudget('under £45'), 45);
  assert.equal(extractBudget('max $30'), 30);
  assert.equal(extractBudget('budget of 25.50'), 25.5);
  assert.equal(extractBudget('no budget mentioned'), null);
});

test('extractDealHints catches coupons and deals', () => {
  const h = extractDealHints('find joggers and use any coupon or bogo deal');
  assert.ok(h.includes('coupon') && h.includes('bogo'));
  assert.ok(extractDealHints('20% off code SUMMER').includes('percent-off'));
});

test('parseGoalContext builds rich context', () => {
  const ctx = parseGoalContext('find navy size M joggers under £50 with any deals or coupon');
  assert.equal(ctx.size, 'm');
  assert.equal(ctx.color, 'navy');
  assert.equal(ctx.budget, 50);
  assert.ok(ctx.dealHints.length > 0);
  assert.ok(ctx.wantsAnyDeal);
});

test('parseGoalContext extracts volume for products like 200ml', () => {
  const ctx = parseGoalContext('order the vaseline cocoa butter oil 200ml');
  assert.equal(ctx.volume, '200ml');
});

test('parseGoalContext falls back gracefully with history', () => {
  const ctx = parseGoalContext('add the black ones', ['if there is a bogo in xl']);
  assert.equal(ctx.size, 'xl');
  assert.ok(ctx.dealHints.includes('bogo'));
});

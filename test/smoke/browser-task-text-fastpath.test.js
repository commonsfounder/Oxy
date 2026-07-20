'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldAttemptTextOnlyDecision } = require('../../api/services/browser-task');

test('eligible: no product grid, element count under the cap', () => {
  assert.equal(shouldAttemptTextOnlyDecision({ hasProducts: 0, elementCount: 12 }), true);
});

test('ineligible: page has a product grid (image-heavy, needs vision)', () => {
  assert.equal(shouldAttemptTextOnlyDecision({ hasProducts: 1, elementCount: 12 }), false);
});

test('ineligible: too many elements to trust a text-only pick', () => {
  assert.equal(shouldAttemptTextOnlyDecision({ hasProducts: 0, elementCount: 41 }), false);
});

test('boundary: exactly the element cap is still eligible', () => {
  assert.equal(shouldAttemptTextOnlyDecision({ hasProducts: 0, elementCount: 40 }), true);
});

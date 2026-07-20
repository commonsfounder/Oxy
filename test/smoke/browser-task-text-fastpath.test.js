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

const { buildTextOnlyDecisionPrompt } = require('../../api/services/browser-task');

test('text-only prompt never mentions a screenshot', () => {
  const prompt = buildTextOnlyDecisionPrompt(
    'buy a blue jumper',
    ['1. opened site'],
    [{ id: 0, text: 'Search' }, { id: 1, text: 'Add to basket' }],
    '',
    null
  );
  assert.equal(/screenshot/i.test(prompt), false);
});

test('text-only prompt offers the insufficient_info escape hatch', () => {
  const prompt = buildTextOnlyDecisionPrompt('buy a blue jumper', [], [{ id: 0, text: 'Search' }], '', null);
  assert.match(prompt, /insufficient_info/);
});

test('text-only prompt lists elements by id and text, same contract as the vision prompt', () => {
  const prompt = buildTextOnlyDecisionPrompt(
    'buy a blue jumper',
    [],
    [{ id: 0, text: 'Search' }, { id: 3, text: 'Add to basket' }],
    '',
    null
  );
  assert.match(prompt, /#0 "Search"/);
  assert.match(prompt, /#3 "Add to basket"/);
});

const { isTextOnlyDeclined } = require('../../api/services/browser-task');

test('insufficient_info triggers vision fallback', () => {
  assert.equal(isTextOnlyDeclined({ action: 'insufficient_info' }), true);
});

test('invalid (failed text-only call) triggers vision fallback', () => {
  assert.equal(isTextOnlyDeclined({ action: 'invalid', error: 'model call failed' }), true);
});

test('a real decision does not trigger fallback', () => {
  assert.equal(isTextOnlyDeclined({ action: 'click', elementId: 3 }), false);
  assert.equal(isTextOnlyDeclined({ action: 'done', summary: 'ok' }), false);
});

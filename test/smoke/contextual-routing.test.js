const assert = require('node:assert/strict');
const test = require('node:test');

const { shouldClarifyPreviousPlace } = require('../../api/services/contextual-routing');

test('plain fact-check follow-up does not get stolen by place clarification', () => {
  assert.equal(shouldClarifyPreviousPlace('is that right'), false);
  assert.equal(shouldClarifyPreviousPlace('is that correct'), false);
});

test('place-specific nearest follow-up still clarifies previous place result', () => {
  assert.equal(shouldClarifyPreviousPlace('is that definitely the nearest one'), true);
  assert.equal(shouldClarifyPreviousPlace('was that the closest place'), true);
});

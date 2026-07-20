const assert = require('node:assert/strict');
const test = require('node:test');

// This task's logic lives inline in runOrderingTurnImpl, which is not itself unit-testable
// without a live browser session (same constraint as makePersistingProgress before it — see
// Phase 1's Task 2, which tested the wrapper helper directly instead of the whole turn). So
// this test targets the extracted decision function below, not the full turn.
const { shouldRecordEntity } = require('../../api/services/browser-task');

test('shouldRecordEntity is true for a done outcome with a productName', () => {
  assert.equal(shouldRecordEntity({ type: 'done', productName: 'Blue Sofa' }), true);
});

test('shouldRecordEntity is true for a ready_for_payment outcome with a productName', () => {
  assert.equal(shouldRecordEntity({ type: 'ready_for_payment', productName: 'Blue Sofa' }), true);
});

test('shouldRecordEntity is false without a productName', () => {
  assert.equal(shouldRecordEntity({ type: 'done' }), false);
});

test('shouldRecordEntity is false for other outcome types even with a productName-shaped field', () => {
  assert.equal(shouldRecordEntity({ type: 'ask', productName: 'Blue Sofa' }), false);
  assert.equal(shouldRecordEntity({ type: 'error', productName: 'Blue Sofa' }), false);
});

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseSizeFromGoal, matchSizeChip } = require('../../api/services/browser-recipes');

test('parseSizeFromGoal pulls an explicit "size X"', () => {
  assert.equal(parseSizeFromGoal('add the joggers in size M to my basket'), 'm');
  assert.equal(parseSizeFromGoal('order size 10 please'), '10');
  assert.equal(parseSizeFromGoal('buy the trainers size UK 9'), 'uk 9');
});

test('parseSizeFromGoal recognises standalone garment sizes and words', () => {
  assert.equal(parseSizeFromGoal('the medium fleece'), 'medium');
  assert.equal(parseSizeFromGoal('get me a large one'), 'large');
  assert.equal(parseSizeFromGoal('joggers, XL'), 'xl');
});

test('parseSizeFromGoal returns null when no size is present', () => {
  assert.equal(parseSizeFromGoal('add the adidas joggers to my basket'), null);
  assert.equal(parseSizeFromGoal('what is the price of the kettle'), null);
  assert.equal(parseSizeFromGoal(''), null);
  // "small" as part of another word must not false-match
  assert.equal(parseSizeFromGoal('a smallish bag'), null);
});

test('matchSizeChip matches normalized labels, exact before contains', () => {
  assert.equal(matchSizeChip('m', ['XS', 'S', 'M', 'L']), 2);
  assert.equal(matchSizeChip('uk 9', ['UK 8', 'UK 9', 'UK 10']), 1);
  assert.equal(matchSizeChip('medium', ['Small', 'Medium', 'Large']), 1);
  assert.equal(matchSizeChip('10', ['Size 8', 'Size 10', 'Size 12']), 1); // contains fallback
});

test('matchSizeChip returns null when no chip matches', () => {
  assert.equal(matchSizeChip('xxl', ['S', 'M', 'L']), null);
  assert.equal(matchSizeChip('m', []), null);
});

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

const { RECIPES, phaseFromUrl } = require('../../api/services/browser-recipes');

test('John Lewis recipe is registered with the expected phases and steps', () => {
  const jl = RECIPES['johnlewis.com'];
  assert.ok(jl, 'johnlewis.com recipe exists');
  assert.deepEqual(jl.steps.map((s) => s.name), ['size', 'add', 'go-to-basket', 'checkout']);
  // durable attribute candidate comes before the visible-text candidate
  const add = jl.steps.find((s) => s.name === 'add');
  const dataTestIdx = add.selectorAny.findIndex((s) => /data-test/i.test(s));
  const textIdx = add.selectorAny.findIndex((s) => /has-text/i.test(s));
  assert.ok(dataTestIdx !== -1 && textIdx !== -1 && dataTestIdx < textIdx, 'durable selector before text');
});

test('phaseFromUrl classifies John Lewis product / basket / checkout urls', () => {
  const jl = RECIPES['johnlewis.com'];
  assert.equal(phaseFromUrl(jl, 'https://www.johnlewis.com/adidas-joggers/p6543210'), 'product');
  assert.equal(phaseFromUrl(jl, 'https://www.johnlewis.com/basket'), 'basket');
  assert.equal(phaseFromUrl(jl, 'https://www.johnlewis.com/checkout/delivery'), 'checkout');
  assert.equal(phaseFromUrl(jl, 'https://www.johnlewis.com/search?search-term=joggers'), null);
  assert.equal(phaseFromUrl(jl, 'not a url'), null);
});

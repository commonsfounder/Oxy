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
  const textIdx = add.selectorAny.findIndex((s) => /^text=/i.test(s));
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

const { createRecipeHealth, selectStep } = require('../../api/services/browser-recipes');

test('selectStep picks the first matching, enabled step for the phase', () => {
  const jl = RECIPES['johnlewis.com'];
  const health = createRecipeHealth();
  // On product page, size still needed → the size step.
  assert.equal(selectStep(jl, 'product', { hasUnsatisfiedSize: true }, health, 'johnlewis.com').name, 'size');
  // Size satisfied → skip to add.
  assert.equal(selectStep(jl, 'product', { hasUnsatisfiedSize: false }, health, 'johnlewis.com').name, 'add');
  // Basket phase → checkout.
  assert.equal(selectStep(jl, 'basket', {}, health, 'johnlewis.com').name, 'checkout');
  // No step for a phase the recipe doesn't cover.
  assert.equal(selectStep(jl, 'search', {}, health, 'johnlewis.com'), null);
});

test('selectStep skips a step that health has disabled', () => {
  const jl = RECIPES['johnlewis.com'];
  const health = createRecipeHealth(2);
  health.recordMiss('johnlewis.com', 'add');
  health.recordMiss('johnlewis.com', 'add'); // disabled at threshold 2
  // add disabled + empty basket: no other product step qualifies (go-to-basket needs basketCount>0) → null
  assert.equal(selectStep(jl, 'product', { hasUnsatisfiedSize: false, basketCount: 0 }, health, 'johnlewis.com'), null);
  // once the item is in the basket, go-to-basket qualifies regardless of add's health
  assert.equal(selectStep(jl, 'product', { hasUnsatisfiedSize: false, basketCount: 1 }, health, 'johnlewis.com').name, 'go-to-basket');
});

test('recipe health disables after N misses and a hit resets the streak', () => {
  const health = createRecipeHealth(3);
  health.recordMiss('h', 's'); health.recordMiss('h', 's');
  assert.equal(health.isDisabled('h', 's'), false);
  health.recordMiss('h', 's');
  assert.equal(health.isDisabled('h', 's'), true);
  health.recordHit('h', 's'); // one success re-enables
  assert.equal(health.isDisabled('h', 's'), false);
});

const { nextRecipeMove, resolveSizeMove } = require('../../api/services/browser-recipes');

// A fake page: url() returns the given url; evaluate(fn, arg) runs fn against a scripted
// "DOM answer" table keyed by a tag we pass in arg.probe, so tests stay declarative.
function fakePage(url, answers = {}) {
  return {
    url: () => url,
    evaluate: async (_fn, arg) => (arg && arg.probe in answers ? answers[arg.probe] : null),
  };
}

test('nextRecipeMove returns null off any recipe phase (e.g. search page)', async () => {
  const jl = RECIPES['johnlewis.com'];
  const move = await nextRecipeMove(
    fakePage('https://www.johnlewis.com/search?search-term=joggers'),
    { goal: 'joggers size m', history: [] }, jl, createRecipeHealth());
  assert.equal(move, null);
});

test('nextRecipeMove asks for a size when the goal has none and a size is needed', async () => {
  const jl = RECIPES['johnlewis.com'];
  const page = fakePage('https://www.johnlewis.com/x/p6543210', {
    ctx: { hasUnsatisfiedSize: true },
    sizeChips: [], // no chips fetched because we ask before matching
  });
  const move = await nextRecipeMove(page, { goal: 'add the joggers to my basket', history: [] }, jl, createRecipeHealth());
  assert.equal(move.action, 'ask');
  assert.match(move.question, /size/i);
});

test('nextRecipeMove returns a click for add-to-basket once size is satisfied', async () => {
  const jl = RECIPES['johnlewis.com'];
  const page = fakePage('https://www.johnlewis.com/x/p6543210', {
    ctx: { hasUnsatisfiedSize: false },
    'resolve:add': { locatorIndex: 17, text: 'Add to basket' }, // scripted resolution
  });
  const move = await nextRecipeMove(page, { goal: 'add the joggers to my basket', history: [] }, jl, createRecipeHealth());
  assert.deepEqual(move, { action: 'click', locatorIndex: 17, text: 'Add to basket', stepName: 'add' });
});

test('nextRecipeMove records a miss and returns null when the step resolves to nothing', async () => {
  const jl = RECIPES['johnlewis.com'];
  const health = createRecipeHealth(1);
  const page = fakePage('https://www.johnlewis.com/x/p6543210', { ctx: { hasUnsatisfiedSize: false }, 'resolve:add': null });
  const move = await nextRecipeMove(page, { goal: 'add joggers', history: [] }, jl, health);
  assert.equal(move, null);
  assert.equal(health.isDisabled('johnlewis.com', 'add'), true);
});

const { GENERIC } = require('../../api/services/browser-recipes');

test('GENERIC recipe is exported with a single cart-phase checkout step', () => {
  assert.ok(GENERIC, 'GENERIC exported');
  assert.deepEqual(GENERIC.steps.map((s) => s.name), ['checkout']);
  assert.equal(GENERIC.steps[0].phase, 'cart');
  assert.ok(Array.isArray(GENERIC.steps[0].selectorAny) && GENERIC.steps[0].selectorAny.length > 0);
  // Size config must be present (empty) so readCtx doesn't throw on missing recipe.size
  assert.deepEqual(GENERIC.size, { container: [], chip: [], selected: [] });
});

test('GENERIC phaseFromUrl detects cart/basket/bag URLs and checkout URLs', () => {
  assert.equal(phaseFromUrl(GENERIC, 'https://www.amazon.co.uk/gp/cart/view.html'), 'cart');
  assert.equal(phaseFromUrl(GENERIC, 'https://www.asos.com/bag'), 'cart');
  assert.equal(phaseFromUrl(GENERIC, 'https://www.example.com/basket'), 'cart');
  assert.equal(phaseFromUrl(GENERIC, 'https://www.walmart.com/cart'), 'cart');
  assert.equal(phaseFromUrl(GENERIC, 'https://www.example.com/checkout/delivery'), 'checkout');
  assert.equal(phaseFromUrl(GENERIC, 'https://www.example.com/payment'), 'checkout');
  // Product / search pages return null → recipe returns null → falls through to vision
  assert.equal(phaseFromUrl(GENERIC, 'https://www.amazon.co.uk/dp/B09XY12345'), null);
  assert.equal(phaseFromUrl(GENERIC, 'https://www.asos.com/search/?q=jeans'), null);
  assert.equal(phaseFromUrl(GENERIC, 'not a url'), null);
});

test('GENERIC nextRecipeMove returns null on a product page', async () => {
  const move = await nextRecipeMove(
    fakePage('https://www.amazon.co.uk/dp/B09XY12345'),
    { goal: 'order nido milk', history: [], site: 'amazon.co.uk' }, GENERIC, createRecipeHealth());
  assert.equal(move, null);
});

test('GENERIC nextRecipeMove returns checkout click on a cart page', async () => {
  const page = fakePage('https://www.amazon.co.uk/gp/cart/view.html', {
    ctx: { hasUnsatisfiedSize: false, basketCount: 0 },
    'resolve:checkout': { locatorIndex: 5, text: 'Proceed to checkout' },
  });
  const move = await nextRecipeMove(page, { goal: 'order nido milk', history: [], site: 'amazon.co.uk' }, GENERIC, createRecipeHealth());
  assert.deepEqual(move, { action: 'click', locatorIndex: 5, text: 'Proceed to checkout', stepName: 'checkout' });
});

test('GENERIC health is tracked under the real site host, not "unknown"', async () => {
  const health = createRecipeHealth(1);
  const page = fakePage('https://www.amazon.co.uk/gp/cart/view.html', {
    ctx: { hasUnsatisfiedSize: false, basketCount: 0 },
    'resolve:checkout': null, // miss
  });
  await nextRecipeMove(page, { goal: 'order nido milk', history: [], site: 'amazon.co.uk' }, GENERIC, health);
  assert.equal(health.isDisabled('amazon.co.uk', 'checkout'), true, 'tracked under actual host');
  assert.equal(health.isDisabled('unknown', 'checkout'), false, 'not under "unknown"');
});

test('GENERIC nextRecipeMove returns null on a checkout page (no steps → vision handles it)', async () => {
  const move = await nextRecipeMove(
    fakePage('https://www.example.com/checkout/delivery', { ctx: { hasUnsatisfiedSize: false, basketCount: 0 } }),
    { goal: 'order item', history: [], site: 'example.com' }, GENERIC, createRecipeHealth());
  assert.equal(move, null);
});

test('recipe CLICKABLE_SELECTOR equals the one browser-task uses', () => {
  const recipes = require('../../api/services/browser-recipes');
  // browser-task.js keeps CLICKABLE_SELECTOR private; it re-exports it for this guard in Task 5.
  const bt = require('../../api/services/browser-task');
  assert.equal(recipes.CLICKABLE_SELECTOR, bt.CLICKABLE_SELECTOR,
    'the two clickable-selector copies must stay identical');
});

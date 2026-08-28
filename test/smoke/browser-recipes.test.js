const assert = require('node:assert/strict');
const test = require('node:test');

const recipes = require('../../api/services/browser-recipes');
const { createSiteKnowledge } = require('../../api/services/site-knowledge');

test('curated recipe records are site knowledge, not an executor', () => {
  const johnLewis = recipes.RECIPES['johnlewis.com'];
  assert.ok(johnLewis);
  assert.deepEqual(johnLewis.steps.map(step => step.name), ['size', 'add', 'go-to-basket', 'checkout', 'guest', 'advance']);
  assert.ok(johnLewis.steps.some(step => step.selectorAny?.includes('text=Add to basket')));

  const source = require('node:fs').readFileSync(require.resolve('../../api/services/browser-recipes'), 'utf8');
  for (const forbidden of ['page.evaluate', 'nextRecipeMove', 'resolveSizeMove', 'createRecipeHealth']) {
    assert.doesNotMatch(source, new RegExp(forbidden.replace('.', '\\.'), 'i'));
  }
});

test('phase records remain facts usable for a hint, not a private execution path', () => {
  const johnLewis = recipes.RECIPES['johnlewis.com'];
  assert.equal(recipes.phaseFromUrl(johnLewis, 'https://www.johnlewis.com/product/p123'), 'product');
  assert.equal(recipes.phaseFromUrl(johnLewis, 'https://www.johnlewis.com/basket'), 'basket');
  assert.equal(recipes.phaseFromUrl(johnLewis, 'https://www.johnlewis.com/checkout/delivery'), 'checkout');
  assert.equal(recipes.phaseFromUrl(johnLewis, 'not a url'), null);
});

test('site knowledge supplies curated hints only for a known host', () => {
  const store = createSiteKnowledge({});
  assert.ok(store.hintsFor('johnlewis.com').some(hint => /add/i.test(hint)));
  assert.deepEqual(store.hintsFor('example.invalid'), []);
});

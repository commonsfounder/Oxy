const assert = require('node:assert/strict');
const test = require('node:test');

const {
  synthesizeAddSelector,
  buildLearnedRecipe,
  createLearnedRecipeStore,
} = require('../../api/services/browser-learned-recipes');
const { CONVENTION } = require('../../api/services/browser-recipes');

test('synthesizeAddSelector learns a genuine "add to X" click', () => {
  assert.equal(synthesizeAddSelector('Add to basket'), 'text=Add to basket');
  assert.equal(synthesizeAddSelector('Add to bag'), 'text=Add to bag');
  assert.equal(synthesizeAddSelector('Add to cart'), 'text=Add to cart');
});

test('synthesizeAddSelector rejects text that is not an add-to-basket click', () => {
  assert.equal(synthesizeAddSelector('Checkout'), null);
  assert.equal(synthesizeAddSelector('Continue'), null);
  assert.equal(synthesizeAddSelector('View basket'), null);
});

test('synthesizeAddSelector rejects too-short or too-generic text (would relearn a blind guess)', () => {
  assert.equal(synthesizeAddSelector('Add'), null);
  assert.equal(synthesizeAddSelector(''), null);
  assert.equal(synthesizeAddSelector(null), null);
});

test('synthesizeAddSelector rejects text containing a quote (would break the selector string)', () => {
  assert.equal(synthesizeAddSelector('Add to basket "now"'), null);
});

test('synthesizeAddSelector rejects implausibly long text (a mis-scraped paragraph, not a button label)', () => {
  const long = 'Add to basket ' + 'x'.repeat(60);
  assert.equal(synthesizeAddSelector(long), null);
});

test('buildLearnedRecipe puts the learned selector first, ahead of CONVENTION\'s generic guesses', () => {
  const recipe = buildLearnedRecipe('text=Add to bag');
  const addStep = recipe.steps.find((s) => s.name === 'add');
  assert.equal(addStep.selectorAny[0], 'text=Add to bag');
  // Still has CONVENTION's own fallbacks after it, so a stale learned selector doesn't lose
  // the generic guess entirely — recipeHealth degrades the whole step to vision anyway once
  // it's been missing enough times, but until then the fallbacks remain available in-step.
  const conventionAddStep = CONVENTION.steps.find((s) => s.name === 'add');
  for (const sel of conventionAddStep.selectorAny) {
    assert.ok(recipe.steps.find((s) => s.name === 'add').selectorAny.includes(sel));
  }
});

test('buildLearnedRecipe does not mutate CONVENTION itself', () => {
  buildLearnedRecipe('text=Add to my very specific learned button');
  const addStep = CONVENTION.steps.find((s) => s.name === 'add');
  assert.ok(!addStep.selectorAny.includes('text=Add to my very specific learned button'));
});

function fakeStorePersistence(initialRows = []) {
  const rows = [...initialRows];
  return {
    rows,
    loadRows: async () => rows,
    saveRow: async (row) => {
      const i = rows.findIndex((r) => r.host === row.host);
      if (i >= 0) rows[i] = row; else rows.push(row);
    },
  };
}

test('createLearnedRecipeStore learns from a real add click and persists it', async () => {
  const { rows, loadRows, saveRow } = fakeStorePersistence();
  const store = createLearnedRecipeStore({ loadRows, saveRow });
  await store.load();
  assert.equal(store.getLearnedRecipe('example.com'), null);

  const learned = store.learn('example.com', 'Add to basket');
  assert.equal(learned, true);
  assert.ok(store.getLearnedRecipe('example.com'));
  assert.equal(rows.find((r) => r.host === 'example.com').selector, 'text=Add to basket');
});

test('createLearnedRecipeStore never overrides an already-learned selector for the same host', async () => {
  const store = createLearnedRecipeStore({});
  store.learn('example.com', 'Add to basket');
  const secondAttempt = store.learn('example.com', 'Add to bag');
  assert.equal(secondAttempt, false);
  const recipe = store.getLearnedRecipe('example.com');
  assert.equal(recipe.steps.find((s) => s.name === 'add').selectorAny[0], 'text=Add to basket');
});

test('createLearnedRecipeStore.learn returns false for non-add-shaped text without storing anything', async () => {
  const store = createLearnedRecipeStore({});
  assert.equal(store.learn('example.com', 'Checkout'), false);
  assert.equal(store.getLearnedRecipe('example.com'), null);
});

test('createLearnedRecipeStore loads rows from persistence at boot', async () => {
  const { loadRows } = fakeStorePersistence([
    { host: 'example.com', selector: 'text=Add to basket', learned_at: '2026-01-01T00:00:00.000Z' }
  ]);
  const store = createLearnedRecipeStore({ loadRows });
  await store.load();
  const recipe = store.getLearnedRecipe('example.com');
  assert.equal(recipe.steps.find((s) => s.name === 'add').selectorAny[0], 'text=Add to basket');
});

test('createLearnedRecipeStore.load is best-effort — a broken loader never throws', async () => {
  const store = createLearnedRecipeStore({ loadRows: async () => { throw new Error('db down'); } });
  await assert.doesNotReject(() => store.load());
});

const assert = require('node:assert/strict');
const test = require('node:test');
const { learnTemplateFromUrl, applyTemplate, TERM } = require('../../api/services/browser-fastpaths');

test('learnTemplateFromUrl derives a template from the param carrying the search term', () => {
  const jl = learnTemplateFromUrl('https://www.johnlewis.com/search?search-term=wool%20coat', 'wool coat');
  assert.deepEqual(jl, { host: 'johnlewis.com', param: 'search-term', template: `https://www.johnlewis.com/search?search-term=${TERM}` });

  const sf = learnTemplateFromUrl('https://www.selfridges.com/GB/en/cat/?freeText=wool%20coat&srch=Y', 'wool coat');
  assert.equal(sf.host, 'selfridges.com');
  assert.equal(sf.param, 'freeText');
  assert.equal(sf.template, `https://www.selfridges.com/GB/en/cat/?freeText=${TERM}&srch=Y`);
});

test('learnTemplateFromUrl returns null when the term is not a query param value', () => {
  assert.equal(learnTemplateFromUrl('https://x.com/product/12345', 'wool coat'), null); // term in path, not query
  assert.equal(learnTemplateFromUrl('https://x.com/?q=other', 'wool coat'), null);       // no matching param
  assert.equal(learnTemplateFromUrl('not a url', 'wool coat'), null);
  assert.equal(learnTemplateFromUrl('https://x.com/?q=a', 'a'), null);                    // term too short (<2)
});

test('applyTemplate fills the placeholder with an encoded term', () => {
  assert.equal(applyTemplate(`https://x.com/s?q=${TERM}`, "men's coat"), 'https://x.com/s?q=men\'s%20coat');
  assert.equal(applyTemplate('https://x.com/s?q=fixed', 'coat'), null); // no placeholder → null
});

const { createFastpathStore, FAIL_DISABLE_THRESHOLD } = require('../../api/services/browser-fastpaths');

function fakePersistence() {
  const rows = new Map();
  return {
    rows,
    loadRows: async () => Array.from(rows.values()),
    saveRow: async (r) => { rows.set(r.host, { ...rows.get(r.host), ...r }); }
  };
}

test('store learns a template and serves it back applied', () => {
  const store = createFastpathStore(fakePersistence());
  assert.equal(store.learn('shop.com', 'q', `https://shop.com/s?q=${TERM}`), true);
  assert.equal(store.getLearnedSearchUrl('shop.com', 'wool coat'), 'https://shop.com/s?q=wool%20coat');
  assert.equal(store.getLearnedSearchUrl('other.com', 'x'), null); // unknown host
  assert.equal(store.learn('shop.com', 'q', `https://shop.com/s?q=${TERM}`), false); // unchanged → no-op
});

test('store disables a template after consecutive failures and re-enables on a learn', () => {
  const store = createFastpathStore(fakePersistence());
  store.learn('shop.com', 'q', `https://shop.com/s?q=${TERM}`);
  for (let i = 0; i < FAIL_DISABLE_THRESHOLD; i++) store.recordOutcome('shop.com', false);
  assert.equal(store.getLearnedSearchUrl('shop.com', 'coat'), null, 'disabled after 3 fails');
  store.learn('shop.com', 'q', `https://shop.com/search?q=${TERM}`); // relearn a fresh template
  assert.equal(store.getLearnedSearchUrl('shop.com', 'coat'), 'https://shop.com/search?q=coat');
});

test('store recordOutcome(ok=true) resets the failure streak', () => {
  const store = createFastpathStore(fakePersistence());
  store.learn('shop.com', 'q', `https://shop.com/s?q=${TERM}`);
  store.recordOutcome('shop.com', false);
  store.recordOutcome('shop.com', false);
  store.recordOutcome('shop.com', true); // reset
  store.recordOutcome('shop.com', false);
  assert.ok(store.getLearnedSearchUrl('shop.com', 'coat'), 'not disabled — streak was reset');
});

test('store load() hydrates the map from persisted rows and honours disabled state', async () => {
  const p = fakePersistence();
  p.rows.set('a.com', { host: 'a.com', url_template: `https://a.com/s?q=${TERM}`, param: 'q', fail_count: 0 });
  p.rows.set('b.com', { host: 'b.com', url_template: `https://b.com/s?q=${TERM}`, param: 'q', fail_count: FAIL_DISABLE_THRESHOLD });
  const store = createFastpathStore(p);
  await store.load();
  assert.equal(store.getLearnedSearchUrl('a.com', 'coat'), 'https://a.com/s?q=coat');
  assert.equal(store.getLearnedSearchUrl('b.com', 'coat'), null); // loaded as disabled
});

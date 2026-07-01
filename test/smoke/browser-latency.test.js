const assert = require('node:assert/strict');
const test = require('node:test');

const { deriveSearchTerm, directSearchUrl } = require('../../api/services/browser-task');

// The John Lewis registry entry (the only seeded site) — used to exercise name-stripping.
const jlSite = { names: ['john lewis', 'johnlewis'] };

test('deriveSearchTerm strips lead verbs and trailing price fluff', () => {
  assert.equal(deriveSearchTerm('find me adidas joggers and tell me the price', jlSite), 'adidas joggers');
  assert.equal(deriveSearchTerm('buy a pair of running shoes', jlSite), 'running shoes');
  assert.equal(deriveSearchTerm('search for a wireless keyboard please', jlSite), 'wireless keyboard');
  assert.equal(deriveSearchTerm('I want to find a coffee machine', jlSite), 'coffee machine');
  assert.equal(deriveSearchTerm('get me an umbrella', jlSite), 'umbrella');
});

test('deriveSearchTerm strips a request-clause even with adjectives before "price"', () => {
  // Regression: "exact"/"shown" around "price" used to defeat the trailing-fluff stripper,
  // polluting the John Lewis fast-path query with the whole sentence (caught in E2E).
  assert.equal(deriveSearchTerm("find a pair of men's joggers and tell me the exact price shown", jlSite), "men's joggers");
  assert.equal(deriveSearchTerm('find a coffee machine and let me know the current price', jlSite), 'coffee machine');
  assert.equal(deriveSearchTerm('find a kettle how much is it', jlSite), 'kettle');
  // Must NOT strip a product name that merely contains the word "price".
  assert.equal(deriveSearchTerm('find a price comparison tool', jlSite), 'price comparison tool');
});

test('deriveSearchTerm removes a mention of the site itself', () => {
  assert.equal(deriveSearchTerm('find joggers on John Lewis', jlSite), 'joggers');
  assert.equal(deriveSearchTerm('search johnlewis for a kettle', jlSite), 'kettle');
});

test('deriveSearchTerm returns null when there is nothing usable left', () => {
  assert.equal(deriveSearchTerm('', jlSite), null);
  assert.equal(deriveSearchTerm('find me', jlSite), null);   // all noise, no subject
  assert.equal(deriveSearchTerm('a', jlSite), null);         // too short
  // Implausibly long → probably not a product query; don't risk a bad fast-path.
  assert.equal(deriveSearchTerm('x'.repeat(120), jlSite), null);
});

test('directSearchUrl jumps to the results page for a known site root', () => {
  const url = directSearchUrl('https://www.johnlewis.com', 'find me adidas joggers and tell me the price');
  assert.equal(url, 'https://www.johnlewis.com/search?search-term=adidas%20joggers');
});

test('directSearchUrl builds the Selfridges results URL from a goal', () => {
  const url = directSearchUrl('https://www.selfridges.com', "find a men's wool coat and tell me the price");
  assert.equal(url, "https://www.selfridges.com/GB/en/cat/?freeText=men's%20wool%20coat&srch=Y");
});

test('directSearchUrl ignores deep links — the caller meant to land there', () => {
  assert.equal(directSearchUrl('https://www.johnlewis.com/browse/men', 'find joggers'), null);
  assert.equal(directSearchUrl('https://www.johnlewis.com/product/12345', 'find joggers'), null);
});

test('directSearchUrl honours the OXY_BROWSER_FASTPATH kill-switch', () => {
  const goal = 'find me adidas joggers';
  assert.ok(directSearchUrl('https://www.johnlewis.com', goal)); // on by default
  process.env.OXY_BROWSER_FASTPATH = 'false';
  try {
    assert.equal(directSearchUrl('https://www.johnlewis.com', goal), null);
  } finally {
    delete process.env.OXY_BROWSER_FASTPATH;
  }
});

test('directSearchUrl is null for unknown sites and unusable goals', () => {
  assert.equal(directSearchUrl('https://www.argos.co.uk', 'find joggers'), null); // not in registry
  assert.equal(directSearchUrl('https://www.johnlewis.com', 'find me'), null);    // no derivable term
  assert.equal(directSearchUrl('not a url', 'find joggers'), null);
});

const bt = require('../../api/services/browser-task');

test('browser-task exposes the fast-path store and boot primer', () => {
  assert.equal(typeof bt.primeFastpaths, 'function');
  assert.ok(bt._fastpathStore && typeof bt._fastpathStore.getLearnedSearchUrl === 'function');
});

test('directSearchUrl uses a LEARNED template when no code seed matches', () => {
  // Nothing seeded for example-shop.com; teach the live store, then expect directSearchUrl to use it.
  bt._fastpathStore.learn('example-shop.com', 'q', 'https://example-shop.com/s?q={{term}}');
  const url = directSearchUrl('https://example-shop.com', 'find a wool coat and tell me the price');
  assert.equal(url, 'https://example-shop.com/s?q=wool%20coat');
});

test('directSearchUrl still returns null for a truly unknown host', () => {
  assert.equal(directSearchUrl('https://never-seen-this.example', 'find a wool coat'), null);
});

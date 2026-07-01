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

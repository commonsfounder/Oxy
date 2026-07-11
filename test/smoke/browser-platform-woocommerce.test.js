const assert = require('node:assert/strict');
const test = require('node:test');
const { pickVariation, normalizeOption, minorToDisplay, decodeHtmlEntities, resolveAndAddToCart } = require('../../api/services/browser-platform-woocommerce');

test('normalizeOption strips a UK prefix and lowercases', () => {
  assert.equal(normalizeOption('UK 10'), '10');
  assert.equal(normalizeOption(' Medium '), 'medium');
  assert.equal(normalizeOption(null), '');
});

test('decodeHtmlEntities decodes numeric, hex, and named entities from WP product titles', () => {
  assert.equal(decodeHtmlEntities('ProfitSync &#8211; Profit Tracker'), 'ProfitSync – Profit Tracker');
  assert.equal(decodeHtmlEntities('Rock &amp; Roll'), 'Rock & Roll');
  assert.equal(decodeHtmlEntities('Caf&#x65;'), 'Cafe');
  assert.equal(decodeHtmlEntities(null), '');
  assert.equal(decodeHtmlEntities('plain title'), 'plain title');
});

test('minorToDisplay converts minor-unit strings to a display price', () => {
  assert.equal(minorToDisplay('6600', 2, '$'), '$66.00');
  assert.equal(minorToDisplay('2200', 2, '$'), '$22.00');
  assert.equal(minorToDisplay('not-a-number', 2, '$'), '');
});

test('pickVariation returns the product itself for a simple (non-variable) product', () => {
  const product = { id: 42, type: 'simple' };
  const v = pickVariation(product, {});
  assert.equal(v.id, 42);
});

test('pickVariation matches on size for a variable product', () => {
  const product = {
    id: 1, type: 'variable',
    variations: [
      { id: 10, attributes: [{ name: 'Size', value: '6' }] },
      { id: 11, attributes: [{ name: 'Size', value: '10' }] },
      { id: 12, attributes: [{ name: 'Size', value: '20' }] }
    ]
  };
  const v = pickVariation(product, { size: '10' });
  assert.equal(v.id, 11);
});

test('pickVariation normalizes a UK-prefixed goal size against a plain numeric attribute', () => {
  const product = {
    id: 1, type: 'variable',
    variations: [{ id: 10, attributes: [{ name: 'Size', value: '9' }] }, { id: 11, attributes: [{ name: 'Size', value: '10' }] }]
  };
  const v = pickVariation(product, { size: 'UK 10' });
  assert.equal(v.id, 11);
});

test('pickVariation returns null (ambiguous) for a variable product with no size/color given and multiple variations', () => {
  const product = {
    id: 1, type: 'variable',
    variations: [{ id: 10, attributes: [{ name: 'Size', value: '6' }] }, { id: 11, attributes: [{ name: 'Size', value: '10' }] }]
  };
  assert.equal(pickVariation(product, {}), null);
});

test('pickVariation returns null for a variable product with no variations at all', () => {
  const product = { id: 1, type: 'variable', variations: [] };
  assert.equal(pickVariation(product, { size: '10' }), null);
});

test('resolveAndAddToCart does not use a ?search= query param (lists and scores locally instead)', async () => {
  let requestedUrl = null;
  const fakeCtx = {
    get: async (url) => {
      requestedUrl = url;
      return { ok: () => true, json: async () => [] };
    }
  };
  await resolveAndAddToCart(fakeCtx, 'https://shop.example.com', 'buy a red jacket', {}, () => 5);
  assert.ok(!requestedUrl.includes('search='), `expected no search param, got: ${requestedUrl}`);
  assert.ok(requestedUrl.includes('per_page=50'));
});

test('resolveAndAddToCart reports no relevant product match when scoring rejects everything', async () => {
  const fakeCtx = {
    get: async () => ({ ok: () => true, json: async () => [{ id: 1, name: 'Totally Unrelated', type: 'simple', is_purchasable: true }] })
  };
  const result = await resolveAndAddToCart(fakeCtx, 'https://shop.example.com', 'buy a red jacket', {}, () => -5);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no relevant product match');
});

test('resolveAndAddToCart flags an ambiguous variation instead of guessing', async () => {
  const fakeCtx = {
    get: async () => ({
      ok: () => true,
      json: async () => [{
        id: 1, name: 'Red Jacket', type: 'variable', is_purchasable: true,
        variations: [{ id: 10, attributes: [{ name: 'Size', value: 'S' }] }, { id: 11, attributes: [{ name: 'Size', value: 'M' }] }]
      }]
    })
  };
  const result = await resolveAndAddToCart(fakeCtx, 'https://shop.example.com', 'buy a red jacket', {}, () => 5);
  assert.equal(result.ok, false);
  assert.equal(result.needsAsk, true);
  assert.deepEqual(result.options, ['S', 'M']);
});

test('resolveAndAddToCart fails cleanly with no cart nonce rather than adding without CSRF protection', async () => {
  const fakeCtx = {
    get: async (url) => {
      if (url.endsWith('/cart')) return { ok: () => true, headers: () => ({}) }; // no nonce header
      return { ok: () => true, json: async () => [{ id: 1, name: 'Simple Thing', type: 'simple', is_purchasable: true }] };
    }
  };
  const result = await resolveAndAddToCart(fakeCtx, 'https://shop.example.com', 'buy simple thing', {}, () => 5);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no cart nonce returned — cannot add to cart safely');
});

test('resolveAndAddToCart adds via cart/add-item with the fetched nonce and returns price/urls', async () => {
  let addCall = null;
  const fakeCtx = {
    get: async (url) => {
      if (url.endsWith('/cart')) return { ok: () => true, headers: () => ({ nonce: 'abc123' }) };
      return {
        ok: () => true,
        json: async () => [{
          id: 1, name: 'Simple Thing', type: 'simple', is_purchasable: true,
          prices: { price: '2500', currency_minor_unit: 2, currency_symbol: '$' }
        }]
      };
    },
    post: async (url, opts) => { addCall = { url, ...opts }; return { ok: () => true }; }
  };
  const result = await resolveAndAddToCart(fakeCtx, 'https://shop.example.com', 'buy simple thing', {}, () => 5);
  assert.equal(result.ok, true);
  assert.equal(result.product.title, 'Simple Thing');
  assert.equal(result.variant.id, 1);
  assert.equal(result.price, '$25.00');
  assert.equal(result.cartUrl, 'https://shop.example.com/cart');
  assert.equal(result.checkoutUrl, 'https://shop.example.com/checkout');
  assert.equal(addCall.url, 'https://shop.example.com/wp-json/wc/store/v1/cart/add-item');
  assert.equal(addCall.headers['Nonce'], 'abc123');
  assert.deepEqual(addCall.data, { id: 1, quantity: 1 });
});

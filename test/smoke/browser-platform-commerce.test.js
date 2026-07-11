const assert = require('node:assert/strict');
const test = require('node:test');
const { pickVariant, normalizeOption, resolveAndAddToCart } = require('../../api/services/browser-platform-commerce');

test('normalizeOption strips a UK prefix and lowercases', () => {
  assert.equal(normalizeOption('UK 10'), '10');
  assert.equal(normalizeOption(' Medium '), 'medium');
  assert.equal(normalizeOption(null), '');
});

test('pickVariant matches on size + color option values', () => {
  const product = {
    variants: [
      { id: 1, option1: 'S', option2: 'Black', available: true },
      { id: 2, option1: 'M', option2: 'Black', available: true },
      { id: 3, option1: 'M', option2: 'White', available: true }
    ]
  };
  const v = pickVariant(product, { size: 'M', color: 'White' });
  assert.equal(v.id, 3);
});

test('pickVariant matches on size alone when no color given', () => {
  const product = {
    variants: [
      { id: 1, option1: 'S', available: true },
      { id: 2, option1: 'M', available: true }
    ]
  };
  const v = pickVariant(product, { size: 'M' });
  assert.equal(v.id, 2);
});

test('pickVariant normalizes a UK-prefixed goal size against a plain numeric option', () => {
  const product = { variants: [{ id: 1, option1: '9', available: true }, { id: 2, option1: '10', available: true }] };
  const v = pickVariant(product, { size: 'UK 10' });
  assert.equal(v.id, 2);
});

test('pickVariant returns null (ambiguous) when nothing scores high enough', () => {
  const product = { variants: [{ id: 1, option1: 'S', available: true }, { id: 2, option1: 'M', available: true }] };
  assert.equal(pickVariant(product, { size: 'XL' }), null);
});

test('pickVariant prefers available variants over out-of-stock ones', () => {
  const product = {
    variants: [
      { id: 1, option1: 'M', available: false },
      { id: 2, option1: 'M', available: true }
    ]
  };
  const v = pickVariant(product, { size: 'M' });
  assert.equal(v.id, 2);
});

test('pickVariant with no size/color and a single variant returns it', () => {
  const product = { variants: [{ id: 1, available: true }] };
  assert.equal(pickVariant(product, {}).id, 1);
});

test('pickVariant with no size/color and multiple variants is ambiguous (null)', () => {
  const product = { variants: [{ id: 1, available: true }, { id: 2, available: true }] };
  assert.equal(pickVariant(product, {}), null);
});

test('resolveAndAddToCart reports no relevant product match when scoring rejects everything', async () => {
  const fakeCtx = {
    get: async () => ({
      ok: () => true,
      json: async () => ({ products: [{ title: 'Totally Unrelated Item', handle: 'x', variants: [] }] })
    })
  };
  const scoreFn = () => -5; // reject everything
  const result = await resolveAndAddToCart(fakeCtx, 'https://shop.example.com', 'buy a red jacket', {}, scoreFn);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no relevant product match');
});

test('resolveAndAddToCart flags an ambiguous variant instead of guessing', async () => {
  const fakeCtx = {
    get: async () => ({
      ok: () => true,
      json: async () => ({
        products: [{
          title: 'Red Jacket',
          handle: 'red-jacket',
          variants: [{ id: 1, option1: 'S', available: true }, { id: 2, option1: 'M', available: true }]
        }]
      })
    })
  };
  const scoreFn = () => 5;
  const result = await resolveAndAddToCart(fakeCtx, 'https://shop.example.com', 'buy a red jacket', {}, scoreFn);
  assert.equal(result.ok, false);
  assert.equal(result.needsAsk, true);
  assert.deepEqual(result.options, ['S', 'M']);
});

test('resolveAndAddToCart adds the matched variant via cart/add.js and returns the cart URL', async () => {
  let addBody = null;
  const fakeCtx = {
    get: async () => ({
      ok: () => true,
      json: async () => ({
        products: [{
          title: 'Red Jacket',
          handle: 'red-jacket',
          variants: [{ id: 42, option1: 'M', available: true }]
        }]
      })
    }),
    post: async (url, opts) => {
      addBody = { url, ...opts };
      return { ok: () => true };
    }
  };
  const scoreFn = () => 5;
  const result = await resolveAndAddToCart(fakeCtx, 'https://shop.example.com', 'buy a red jacket size M', { size: 'M' }, scoreFn);
  assert.equal(result.ok, true);
  assert.equal(result.product.handle, 'red-jacket');
  assert.equal(result.variant.id, 42);
  assert.equal(result.cartUrl, 'https://shop.example.com/cart');
  assert.equal(addBody.url, 'https://shop.example.com/cart/add.js');
  assert.deepEqual(addBody.data, { id: 42, quantity: 1 });
});

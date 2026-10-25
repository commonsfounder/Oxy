const test = require('node:test');
const assert = require('node:assert');
const { shapeResultCards, MAX_RESULTS } = require('../../api/services/result-cards');
const { ACTION_CONTRACTS } = require('../../api/action-contracts');

test('shapes options and keeps only what was stated', () => {
  const [a, b] = shapeResultCards([
    { title: 'Kettle A', price: '£49', rating: 4.5, rating_count: 120, url: 'https://shop.example/a', image_url: 'https://img.example/a.jpg' },
    { name: 'Kettle B', subtitle: '1.7L' }
  ]);
  assert.strictEqual(a.price, '£49');
  assert.strictEqual(a.rating, 4.5);
  assert.strictEqual(a.url, 'https://shop.example/a');
  assert.strictEqual(b.title, 'Kettle B');
  assert.strictEqual(b.price, null);
  assert.strictEqual(b.rating, null);
});

test('drops untitled, duplicate and non-https entries, and caps the list', () => {
  const cards = shapeResultCards([
    { price: '£1' },
    { title: 'Same', url: 'https://x.example/1' },
    { title: 'Same again', url: 'https://x.example/1' },
    { title: 'Plain link', url: 'http://x.example/2', image_url: 'javascript:alert(1)', rating: 9 },
    ...Array.from({ length: 20 }, (_, i) => ({ title: `Item ${i}` }))
  ]);
  assert.strictEqual(cards.filter(c => c.title === 'Same again').length, 0);
  const plain = cards.find(c => c.title === 'Plain link');
  assert.strictEqual(plain.url, null);
  assert.strictEqual(plain.imageUrl, null);
  assert.strictEqual(plain.rating, null);
  assert.strictEqual(cards.length, MAX_RESULTS);
});

test('show_results is a low-risk inline capability', () => {
  const contract = ACTION_CONTRACTS.show_results;
  assert.strictEqual(contract.risk, 'low');
  assert.strictEqual(contract.confirmation, 'none');
});

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  resolveRetailerFromGoal,
  resolveSearchSite,
  detectRegionFromGoal,
  inferRegionFromLocation,
  isDeliveryHost,
  buildSearchSites,
  RETAILERS,
} = require('../../api/services/retailer-sites');

const LONDON = { latitude: 51.5074, longitude: -0.1278 };
const NYC = { latitude: 40.7128, longitude: -74.006 };

test('inferRegionFromLocation maps London to uk and NYC to us', () => {
  assert.equal(inferRegionFromLocation(LONDON), 'uk');
  assert.equal(inferRegionFromLocation(NYC), 'us');
  assert.equal(inferRegionFromLocation(null), null);
});

test('detectRegionFromGoal uses device location when goal has no address hint', () => {
  assert.equal(detectRegionFromGoal('order milk from tesco', { location: LONDON }), 'uk');
  assert.equal(detectRegionFromGoal('order paper towels from walmart', { location: NYC }), 'us');
  assert.equal(detectRegionFromGoal('order milk from tesco'), null);
});

test('goal address hints override device location', () => {
  assert.equal(
    detectRegionFromGoal('order for delivery near 90210', { location: LONDON }),
    'us'
  );
  assert.equal(
    detectRegionFromGoal('order near EC1A 1BB', { location: NYC }),
    'uk'
  );
});

test('resolveRetailerFromGoal picks UK retailer from London location', () => {
  const wickes = resolveRetailerFromGoal('order white paint from wickes', { location: LONDON });
  assert.equal(wickes.host, 'wickes.co.uk');

  const tesco = resolveRetailerFromGoal('order milk from tesco', { location: LONDON });
  assert.equal(tesco.host, 'tesco.com');
});

test('resolveRetailerFromGoal picks US retailer from NYC location', () => {
  const walmart = resolveRetailerFromGoal('order paper towels from walmart', { location: NYC });
  assert.equal(walmart.host, 'walmart.com');

  const target = resolveRetailerFromGoal('buy cereal from target', { location: NYC });
  assert.equal(target.host, 'target.com');
});

test('resolveRetailerFromGoal finds retailer after from/on/at', () => {
  const jl = resolveRetailerFromGoal('add joggers on john lewis', { location: LONDON });
  assert.equal(jl.host, 'johnlewis.com');
});

test('resolveRetailerFromGoal matches multi-word aliases longest-first', () => {
  const ms = resolveRetailerFromGoal('order socks from marks & spencer', { location: LONDON });
  assert.equal(ms.host, 'marksandspencer.com');
});

test('resolveRetailerFromGoal returns null when no retailer named', () => {
  assert.equal(resolveRetailerFromGoal('order me a pizza', { location: LONDON }), null);
  assert.equal(resolveRetailerFromGoal('nearest coffee shop', { location: NYC }), null);
});

test('multi-locale brands use location for ikea and nike', () => {
  const ikeaUk = resolveRetailerFromGoal('shop for a sofa at ikea', { location: LONDON });
  assert.match(ikeaUk.homeUrl, /\/gb\/en/);

  const ikeaUs = resolveRetailerFromGoal('shop for a sofa at ikea', { location: NYC });
  assert.match(ikeaUs.homeUrl, /\/us\/en/);

  const nikeUk = resolveRetailerFromGoal('order running shoes from nike', { location: LONDON });
  assert.equal(nikeUk.homeUrl, 'https://www.nike.com/gb');

  const nikeUs = resolveRetailerFromGoal('order running shoes from nike', { location: NYC });
  assert.equal(nikeUs.homeUrl, 'https://www.nike.com');
});

test('resolveSearchSite returns region-appropriate search URLs from location', () => {
  const uk = resolveSearchSite('nike.com', 'order shoes', { location: LONDON });
  assert.match(uk.searchUrl('trainers'), /nike\.com\/gb\/w/);

  const us = resolveSearchSite('nike.com', 'order shoes', { location: NYC });
  assert.match(us.searchUrl('sneakers'), /nike\.com\/w\?q=sneakers/);
});

test('resolveRetailerFromGoal resolves delivery platforms by location', () => {
  assert.equal(resolveRetailerFromGoal('order curry on deliveroo', { location: LONDON }).host, 'deliveroo.co.uk');
  assert.equal(resolveRetailerFromGoal('order pizza from doordash', { location: NYC }).host, 'doordash.com');
});

test('isDeliveryHost identifies delivery platforms only', () => {
  assert.equal(isDeliveryHost('doordash.com'), true);
  assert.equal(isDeliveryHost('wickes.co.uk'), false);
});

test('buildSearchSites includes UK and US searchUrl retailers', () => {
  const sites = buildSearchSites();
  assert.ok(sites['walmart.com']);
  assert.ok(sites['wickes.co.uk']);
});

test('RETAILERS registry has homeUrl or locales for every entry', () => {
  for (const [host, entry] of Object.entries(RETAILERS)) {
    assert.ok(entry.homeUrl || entry.locales, `${host} missing homeUrl/locales`);
    assert.ok(entry.names?.length, `${host} missing names`);
  }
});

test('US and UK retailer counts are both substantial', () => {
  const uk = Object.values(RETAILERS).filter((r) => r.region === 'uk').length;
  const us = Object.values(RETAILERS).filter((r) => r.region === 'us').length;
  assert.ok(uk >= 15);
  assert.ok(us >= 25);
});
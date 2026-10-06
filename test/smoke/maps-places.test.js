const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

const mockAxios = { get: async () => ({}), post: async () => ({}) };
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'axios') return mockAxios;
  return originalLoad.call(this, request, parent, isMain);
};
const { execute } = require('../../connectors/maps');
Module._load = originalLoad;

function cafe(name, i, extra = {}) {
  return {
    displayName: { text: name }, formattedAddress: `${i} High St, London`,
    location: { latitude: 51.52 + i / 1000, longitude: -0.08 },
    businessStatus: 'OPERATIONAL', types: ['cafe'], ...extra
  };
}

test('find_place hands the app every option it found, not only the first', async () => {
  const oldKey = process.env.GOOGLE_PLACES_API_KEY;
  const oldPost = mockAxios.post;
  try {
    process.env.GOOGLE_PLACES_API_KEY = 'places-key';
    mockAxios.post = async () => ({
      data: { places: [
        cafe('Gails', 1, { rating: 4.6, userRatingCount: 812, priceLevel: 'PRICE_LEVEL_MODERATE', currentOpeningHours: { openNow: true } }),
        cafe('Pret', 2, { rating: 4.0, userRatingCount: 120 })
      ] }
    });
    const result = await execute('user123', 'find_place', { query: 'cafe', location: { latitude: 51.52, longitude: -0.08 } });
    assert.equal(result.success, true);
    assert.equal(result.name, 'Gails');
    assert.equal(typeof result.lat, 'number');
    assert.equal(typeof result.lng, 'number');
    assert.equal(result.places.length, 2);
    assert.equal(result.places[0].name, 'Gails');
    assert.equal(result.places[0].price, '££');
    assert.match(result.places[1].link, /^https:\/\/maps\.apple\.com\/\?ll=/);
    // The sentence the model reads still names the best match.
    assert.match(result.text, /Gails/);
  } finally {
    mockAxios.post = oldPost;
    if (oldKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY; else process.env.GOOGLE_PLACES_API_KEY = oldKey;
  }
});

test('find_place with one result still returns a one-item list and the existing fields', async () => {
  const oldKey = process.env.GOOGLE_PLACES_API_KEY;
  const oldPost = mockAxios.post;
  try {
    process.env.GOOGLE_PLACES_API_KEY = 'places-key';
    mockAxios.post = async () => ({ data: { places: [cafe('Only Cafe', 1)] } });
    const result = await execute('user123', 'find_place', { query: 'cafe', location: { latitude: 51.52, longitude: -0.08 } });
    assert.equal(result.places.length, 1);
    assert.ok(result.deepLink);
    assert.ok(result.cardText);
  } finally {
    mockAxios.post = oldPost;
    if (oldKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY; else process.env.GOOGLE_PLACES_API_KEY = oldKey;
  }
});

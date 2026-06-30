const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

const mockAxios = { get: async () => ({}), post: async () => ({}) };
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'axios') return mockAxios;
  return originalLoad.call(this, request, parent, isMain);
};

const { getGoogleDirectionsKey, getGooglePlacesKey } = require('../../api/services/maps-config');
const { resolvePlaceDestination } = require('../../api/geocoding');

Module._load = originalLoad;

test('Places key can come from dedicated Places env var', () => {
  const oldMaps = process.env.GOOGLE_MAPS_API_KEY;
  const oldPlaces = process.env.GOOGLE_PLACES_API_KEY;
  try {
    delete process.env.GOOGLE_MAPS_API_KEY;
    process.env.GOOGLE_PLACES_API_KEY = 'places-key';
    assert.equal(getGooglePlacesKey(), 'places-key');
  } finally {
    if (oldMaps === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = oldMaps;
    if (oldPlaces === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = oldPlaces;
  }
});

test('Maps key remains a valid fallback for Places lookup', () => {
  const oldMaps = process.env.GOOGLE_MAPS_API_KEY;
  const oldPlaces = process.env.GOOGLE_PLACES_API_KEY;
  try {
    process.env.GOOGLE_MAPS_API_KEY = 'maps-key';
    delete process.env.GOOGLE_PLACES_API_KEY;
    assert.equal(getGooglePlacesKey(), 'maps-key');
  } finally {
    if (oldMaps === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = oldMaps;
    if (oldPlaces === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = oldPlaces;
  }
});

test('Directions key prefers dedicated route env vars before maps fallback', () => {
  assert.equal(getGoogleDirectionsKey({
    GOOGLE_DIRECTIONS_API_KEY: 'directions-key',
    GOOGLE_ROUTES_API_KEY: 'routes-key',
    GOOGLE_MAPS_API_KEY: 'maps-key'
  }), 'directions-key');
  assert.equal(getGoogleDirectionsKey({
    GOOGLE_ROUTES_API_KEY: 'routes-key',
    GOOGLE_MAPS_API_KEY: 'maps-key'
  }), 'routes-key');
  assert.equal(getGoogleDirectionsKey({
    GOOGLE_MAPS_API_KEY: 'maps-key'
  }), 'maps-key');
});

test('explicit nearby place lookup uses distance-ranked Nearby Search before text search', async () => {
  const oldPlaces = process.env.GOOGLE_PLACES_API_KEY;
  const oldPost = mockAxios.post;
  const calls = [];

  try {
    process.env.GOOGLE_PLACES_API_KEY = 'places-key';
    mockAxios.post = async (url, body) => {
      calls.push({ url, body });
      assert.equal(url, 'https://places.googleapis.com/v1/places:searchNearby');
      assert.deepEqual(body.includedTypes, ['restaurant']);
      assert.equal(body.rankPreference, 'DISTANCE');
      return {
        data: {
          places: [
            {
              displayName: { text: 'Corner Cafe' },
              formattedAddress: '1 Nearby Road',
              location: { latitude: 52.00005, longitude: -1.99995 },
              businessStatus: 'OPERATIONAL',
              types: ['restaurant']
            },
            {
              displayName: { text: "McDonald's" },
              formattedAddress: '2 Close Street',
              location: { latitude: 52.0001, longitude: -1.9999 },
              businessStatus: 'OPERATIONAL',
              types: ['restaurant'],
              currentOpeningHours: { openNow: false }
            },
            {
              displayName: { text: "McDonald's" },
              formattedAddress: 'Garretts Green Ln',
              location: { latitude: 52.02, longitude: -1.98 },
              businessStatus: 'OPERATIONAL',
              types: ['restaurant']
            }
          ]
        }
      };
    };

    const result = await resolvePlaceDestination("where's the nearest McDonald's", {
      location: { latitude: 52, longitude: -2 }
    });

    assert.equal(result.name, "McDonald's");
    assert.equal(result.formattedAddress, '2 Close Street');
    assert.ok(result.distanceMeters < 20);
    assert.equal(calls.length, 1);
  } finally {
    mockAxios.post = oldPost;
    if (oldPlaces === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = oldPlaces;
  }
});

test('named place with no nearby match never resolves to the nearest unrelated place', async () => {
  // Regression: "john lewis" with no John Lewis nearby used to confidently return the
  // closest unrelated shop (a Tesco) as if it were the answer. It must NOT do that — it
  // should fail honestly (and fall through to a plain geocode), never hand back Tesco.
  const oldPlaces = process.env.GOOGLE_PLACES_API_KEY;
  const oldMaps = process.env.GOOGLE_MAPS_API_KEY;
  const oldPost = mockAxios.post;
  const oldGet = mockAxios.get;

  try {
    process.env.GOOGLE_PLACES_API_KEY = 'places-key';
    delete process.env.GOOGLE_MAPS_API_KEY; // force geocode fallback to fail loudly
    // searchText for "john lewis" returns only an unrelated nearby Tesco.
    mockAxios.post = async () => ({
      data: {
        places: [
          {
            displayName: { text: 'Tesco Extra' },
            formattedAddress: 'Swan shopping centre, Coventry Rd',
            location: { latitude: 52.0001, longitude: -1.9999 },
            businessStatus: 'OPERATIONAL',
            types: ['supermarket', 'store']
          }
        ]
      }
    });
    mockAxios.get = async () => ({ data: {} }); // geocode + nominatim both find nothing

    await assert.rejects(
      () => resolvePlaceDestination('john lewis', { location: { latitude: 52, longitude: -2 } }),
      (err) => {
        assert.doesNotMatch(err.message, /tesco/i, 'must not surface the unrelated Tesco');
        return true;
      }
    );
  } finally {
    mockAxios.post = oldPost;
    mockAxios.get = oldGet;
    if (oldPlaces === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = oldPlaces;
    if (oldMaps === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = oldMaps;
  }
});

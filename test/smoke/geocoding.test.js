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
const { resolvePlaceDestination, cleanPlaceSearchQuery, meaningfulPlaceTokens, placeMatchesQuery } = require('../../api/geocoding');

Module._load = originalLoad;

// ── Question-opener filler no longer poisons Places result matching ───────────────────────
// Regression, 2026-08-07 live verification: "is there a gym near Old Street" left "there" as
// a required-match token (no real gym's name/address contains the word "there"), so
// placeMatchesQuery rejected every real Places result even when Places found the right gym.

test('meaningfulPlaceTokens drops question-opener filler ("there", "here", "any", "good", "decent", "nice", "are", "around")', () => {
  assert.deepEqual(meaningfulPlaceTokens('is there a gym near Old Street'), ['old', 'street']);
  assert.deepEqual(meaningfulPlaceTokens('are there any decent gyms around here'), ['gyms']);
  // "coffee"/"shop" are themselves already-existing category stopwords (this path is meant
  // to be matched by TYPE via Nearby Search, not by text) — empty means "matches anything",
  // which is correct here, not a regression.
  assert.deepEqual(meaningfulPlaceTokens("do you know if there's a coffee shop near me"), []);
});

test('placeMatchesQuery matches a real gym for "is there a gym near Old Street" (used to reject every result)', () => {
  const place = {
    displayName: { text: 'PureGym Old Street' },
    formattedAddress: '35 Old Street, London EC1V 9HX',
    types: ['gym']
  };
  assert.equal(placeMatchesQuery(place, 'is there a gym near Old Street'), true);
});

test('cleanPlaceSearchQuery strips "is there a" / "are there any" / "do you know if there\'s" openers', () => {
  assert.equal(cleanPlaceSearchQuery('is there a gym near Old Street'), 'gym near Old Street');
  assert.equal(cleanPlaceSearchQuery('are there any decent gyms around here'), 'decent gyms around here');
  // "near me" is separately stripped further down the same pipeline (unrelated to this
  // fix — it's how the category/Nearby-Search path already worked before today).
  assert.equal(cleanPlaceSearchQuery("do you know if there's a coffee shop near me"), 'coffee shop');
});

test('cleanPlaceSearchQuery does not truncate "any"/"anywhere" to a bare "a" (regex-alternation ordering bug caught while adding the opener strip)', () => {
  assert.equal(cleanPlaceSearchQuery('are there any decent gyms'), 'decent gyms');
  assert.equal(cleanPlaceSearchQuery('is there anywhere good to eat'), 'good to eat');
});

test('messy variant: "is there anywhere good to eat near Old Street?" resolves via Places text search', async () => {
  const oldPlaces = process.env.GOOGLE_PLACES_API_KEY;
  const oldPost = mockAxios.post;
  try {
    process.env.GOOGLE_PLACES_API_KEY = 'places-key';
    mockAxios.post = async (url, body) => {
      assert.equal(url, 'https://places.googleapis.com/v1/places:searchText');
      // "eat" is not stripped by this fix's scope (it's a real word, not filler like
      // "there"/"good") and stays a required token — so the synthetic result below
      // deliberately includes it, matching a real restaurant listing/description would.
      assert.match(body.textQuery, /old street/i);
      return {
        data: {
          places: [{
            displayName: { text: 'Old Street Eatery' },
            formattedAddress: '12 Old Street, London EC1V 9BE',
            location: { latitude: 51.5265, longitude: -0.0876 },
            businessStatus: 'OPERATIONAL',
            types: ['restaurant']
          }]
        }
      };
    };
    const result = await resolvePlaceDestination('is there anywhere good to eat near Old Street?', {
      location: { latitude: 51.5265, longitude: -0.0876 }
    });
    assert.equal(result.name, 'Old Street Eatery');
  } finally {
    mockAxios.post = oldPost;
    if (oldPlaces === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = oldPlaces;
  }
});

test('messy variant: "do you know if there\'s a coffee shop near me?" uses the robust near-me category path', async () => {
  const oldPlaces = process.env.GOOGLE_PLACES_API_KEY;
  const oldPost = mockAxios.post;
  try {
    process.env.GOOGLE_PLACES_API_KEY = 'places-key';
    mockAxios.post = async (url, body) => {
      // "near me" phrasing survives the opener strip, so this hits Nearby Search by
      // category (type: cafe) rather than a text query — immune to token-matching at all.
      assert.equal(url, 'https://places.googleapis.com/v1/places:searchNearby');
      assert.deepEqual(body.includedTypes, ['cafe']);
      return {
        data: {
          places: [{
            displayName: { text: 'Grind Coffee' },
            formattedAddress: '1 Old Street, London',
            location: { latitude: 51.5266, longitude: -0.0877 },
            businessStatus: 'OPERATIONAL',
            types: ['cafe']
          }]
        }
      };
    };
    const result = await resolvePlaceDestination("do you know if there's a coffee shop near me?", {
      location: { latitude: 51.5265, longitude: -0.0876 }
    });
    assert.equal(result.name, 'Grind Coffee');
  } finally {
    mockAxios.post = oldPost;
    if (oldPlaces === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = oldPlaces;
  }
});

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

test('named landmark search trusts Google relevance order over raw distance to the user', async () => {
  // Regression: "King's Cross" real-device QA resolved to a "Harry Potter Shop" a
  // 128-minute drive away instead of the actual station. Root cause — the plain
  // text-search branch re-sorted every candidate that merely mentioned "king's cross"
  // in its name/address by *distance to the user's phone*, discarding Google's own
  // text-relevance order (which correctly ranks the landmark itself first). A shop on
  // "King's Cross Road" happening to sit closer to the user than the actual station
  // then won the tie-break. Named-place lookups must preserve Google's ranking.
  const oldPlaces = process.env.GOOGLE_PLACES_API_KEY;
  const oldPost = mockAxios.post;

  try {
    process.env.GOOGLE_PLACES_API_KEY = 'places-key';
    mockAxios.post = async (url, body) => {
      assert.equal(url, 'https://places.googleapis.com/v1/places:searchText');
      return {
        data: {
          places: [
            {
              displayName: { text: "King's Cross Station" },
              formattedAddress: "King's Cross, London N1 9AL",
              location: { latitude: 51.5308, longitude: -0.1238 },
              businessStatus: 'OPERATIONAL',
              types: ['train_station']
            },
            {
              displayName: { text: 'Some Shop' },
              formattedAddress: "12 King's Cross Road, London",
              // Far closer to the user's own location than the actual station.
              location: { latitude: 51.4000, longitude: -0.1300 },
              businessStatus: 'OPERATIONAL',
              types: ['store']
            }
          ]
        }
      };
    };

    const result = await resolvePlaceDestination("Kings Cross", {
      location: { latitude: 51.4010, longitude: -0.1310 }
    });

    assert.equal(result.name, "King's Cross Station");
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

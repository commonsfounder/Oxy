const assert = require('node:assert/strict');
const test = require('node:test');

const { getGoogleDirectionsKey, getGooglePlacesKey } = require('../../api/services/maps-config');

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

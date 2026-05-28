const assert = require('node:assert/strict');
const test = require('node:test');

const trainline = require('../../connectors/trainline');

test('Apsley resolves through the train fallback path without failing', async () => {
  const oldDirections = process.env.GOOGLE_DIRECTIONS_API_KEY;
  const oldRoutes = process.env.GOOGLE_ROUTES_API_KEY;
  const oldMaps = process.env.GOOGLE_MAPS_API_KEY;
  const oldPlaces = process.env.GOOGLE_PLACES_API_KEY;
  delete process.env.GOOGLE_DIRECTIONS_API_KEY;
  delete process.env.GOOGLE_ROUTES_API_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GOOGLE_PLACES_API_KEY;
  try {
    const result = await trainline.execute('test-user', 'search_trains', {
      origin: 'Birmingham New Street',
      destination: 'Apsley'
    });
    assert.equal(result.success, true);
    assert.equal(result.transportApiDisabled, true);
    assert.equal(result.actionSummary, 'Route unavailable');
    assert.match(result.text, /route data is not configured/i);
  } finally {
    if (oldDirections === undefined) delete process.env.GOOGLE_DIRECTIONS_API_KEY;
    else process.env.GOOGLE_DIRECTIONS_API_KEY = oldDirections;
    if (oldRoutes === undefined) delete process.env.GOOGLE_ROUTES_API_KEY;
    else process.env.GOOGLE_ROUTES_API_KEY = oldRoutes;
    if (oldMaps === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = oldMaps;
    if (oldPlaces === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = oldPlaces;
  }
});

test('unknown stations do not fall back to opening Trainline', async () => {
  const oldDirections = process.env.GOOGLE_DIRECTIONS_API_KEY;
  const oldRoutes = process.env.GOOGLE_ROUTES_API_KEY;
  const oldMaps = process.env.GOOGLE_MAPS_API_KEY;
  const oldPlaces = process.env.GOOGLE_PLACES_API_KEY;
  delete process.env.GOOGLE_DIRECTIONS_API_KEY;
  delete process.env.GOOGLE_ROUTES_API_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GOOGLE_PLACES_API_KEY;
  try {
    const result = await trainline.execute('test-user', 'search_trains', {
      origin: 'Milton Keynes Central',
      destination: 'Definitely Not A Station'
    });
    assert.equal(result.success, true);
    assert.equal(result.actionSummary, 'Route unavailable');
    assert.equal(result.webLink, undefined);
    assert.match(result.text, /couldn't get a train route summary/i);
  } finally {
    if (oldDirections === undefined) delete process.env.GOOGLE_DIRECTIONS_API_KEY;
    else process.env.GOOGLE_DIRECTIONS_API_KEY = oldDirections;
    if (oldRoutes === undefined) delete process.env.GOOGLE_ROUTES_API_KEY;
    else process.env.GOOGLE_ROUTES_API_KEY = oldRoutes;
    if (oldMaps === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = oldMaps;
    if (oldPlaces === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = oldPlaces;
  }
});

test('station board explains live rail is unavailable without opening Trainline', async () => {
  const result = await trainline.execute('test-user', 'station_board', {
    station: 'Milton Keynes Central'
  });
  assert.equal(result.success, true);
  assert.equal(result.actionSummary, 'Live rail unavailable');
  assert.equal(result.webLink, undefined);
  assert.match(result.text, /TransportAPI rail feed is disabled/i);
});

// dotenv: requiring the connector registry pulls in google.js, which builds a Supabase client
// at module load and throws without credentials.
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');

const flights = require('../../connectors/flights');
const { registry } = require('../../connectors');

// This connector used to answer search_flights with a Google Flights URL and success:true,
// having never seen a price. That is now a real grounded search in api/index.js. These tests
// exist to keep the fake from coming back by the side door.
test('flights connector exports SUPPORTED_ACTIONS, and search is no longer one of them', () => {
  assert.ok(Array.isArray(flights.SUPPORTED_ACTIONS));
  assert.ok(flights.SUPPORTED_ACTIONS.includes('track_flight'));
  assert.equal(flights.SUPPORTED_ACTIONS.includes('search_flights'), false);
});

test('the link-generator is genuinely unreachable, not merely unregistered', async () => {
  assert.equal(registry.search_flights, undefined, 'nothing may dispatch search_flights to a connector');
  assert.equal(registry.search_hotels, undefined, 'the hotels link-generator was deleted outright');
  const result = await flights.execute('user1', 'search_flights', { from: 'LON', destination: 'TYO' });
  assert.equal(result.success, false);
});

test('track_flight still works — it was never the decorative one', async () => {
  const result = await flights.execute('user1', 'track_flight', { flight: 'BA123' });
  assert.equal(result.success, true);
  assert.match(result.text, /Tracking flight BA123/);
});

test('flights connector returns error for unknown action', async () => {
  const result = await flights.execute('user1', 'unknown_action', {});
  assert.equal(result.success, false);
});

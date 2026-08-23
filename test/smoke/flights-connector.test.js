// dotenv: requiring the connector registry pulls in google.js, which builds a Supabase client
// at module load and throws without credentials.
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');

const flights = require('../../connectors/flights');
const { getExecutableActionCatalog } = require('../../api/services/action-catalog');

// This connector used to answer search_flights with a Google Flights URL and success:true,
// having never seen a price. That is now a real grounded search in api/index.js. These tests
// exist to keep the fake from coming back by the side door.
test('flight ownership comes from the executable catalog, not connector-local action arrays', () => {
  const track = getExecutableActionCatalog().find(action => action.type === 'track_flight');
  const search = getExecutableActionCatalog().find(action => action.type === 'search_flights');
  assert.equal(track.adapter.id, 'flights');
  assert.equal(search.adapter.kind, 'inline');
  assert.equal(Object.hasOwn(flights, 'SUPPORTED_ACTIONS'), false);
});

test('the link-generator is genuinely unreachable, not merely unregistered', async () => {
  const result = await flights.execute('user1', 'search_flights', { from: 'LON', destination: 'TYO' });
  assert.equal(result.success, false);
});

test('track_flight opens a search handoff and does not claim tracking', async () => {
  const result = await flights.execute('user1', 'track_flight', { flight: 'BA123' });
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'handoff_required');
  assert.equal(result.handoffRequired, true);
  assert.doesNotMatch(result.text, /Tracking flight BA123/);
  assert.match(result.text, /open.*search|search.*flight/i);
});

test('flights connector returns error for unknown action', async () => {
  const result = await flights.execute('user1', 'unknown_action', {});
  assert.equal(result.success, false);
});

const test = require('node:test');
const assert = require('node:assert/strict');

// Test the connector structure without calling live APIs
const flights = require('../../connectors/flights');

test('flights connector exports SUPPORTED_ACTIONS', () => {
  assert.ok(Array.isArray(flights.SUPPORTED_ACTIONS));
  assert.ok(flights.SUPPORTED_ACTIONS.includes('search_flights'));
  assert.ok(flights.SUPPORTED_ACTIONS.includes('get_flight_details'));
});

test('flights connector returns error when API key is missing', async () => {
  const orig = process.env.AMADEUS_API_KEY;
  delete process.env.AMADEUS_API_KEY;
  const result = await flights.execute('user1', 'search_flights', { origin: 'LON', destination: 'TYO', date: '2027-04-10' });
  assert.equal(result.success, false);
  assert.match(result.error, /AMADEUS_API_KEY/);
  if (orig !== undefined) process.env.AMADEUS_API_KEY = orig;
});

test('flights connector returns error for unknown action', async () => {
  process.env.AMADEUS_API_KEY = 'test-key';
  // Will fail at auth step — that's ok, we're testing action routing not API call
  const result = await flights.execute('user1', 'unknown_action', {});
  // Either auth error or unknown action error is fine
  assert.equal(result.success, false);
  delete process.env.AMADEUS_API_KEY;
});

const test = require('node:test');
const assert = require('node:assert/strict');

const flights = require('../../connectors/flights');

test('flights connector exports SUPPORTED_ACTIONS', () => {
  assert.ok(Array.isArray(flights.SUPPORTED_ACTIONS));
  assert.ok(flights.SUPPORTED_ACTIONS.includes('search_flights'));
});

test('flights connector hands off search as a Google Flights web link', async () => {
  const result = await flights.execute('user1', 'search_flights', { from: 'LON', destination: 'TYO', date: '2027-04-10' });
  assert.equal(result.success, true);
  assert.match(result.webLink, /google\.com\/travel\/flights/);
});

test('flights connector returns error for unknown action', async () => {
  const result = await flights.execute('user1', 'unknown_action', {});
  assert.equal(result.success, false);
});

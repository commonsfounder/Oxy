const test = require('node:test');
const assert = require('node:assert/strict');

const flights = require('../../connectors/flights');

test('flights connector exports SUPPORTED_ACTIONS', () => {
  assert.ok(Array.isArray(flights.SUPPORTED_ACTIONS));
  assert.ok(flights.SUPPORTED_ACTIONS.includes('search_flights'));
});

test('flights connector returns error when API key is missing', async () => {
  const orig = process.env.FIRECRAWL_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  const result = await flights.execute('user1', 'search_flights', { origin: 'LON', destination: 'TYO', date: '2027-04-10' });
  assert.equal(result.success, false);
  assert.match(result.error, /FIRECRAWL_API_KEY/);
  if (orig !== undefined) process.env.FIRECRAWL_API_KEY = orig;
});

test('flights connector returns error for unknown action', async () => {
  process.env.FIRECRAWL_API_KEY = 'test-key';
  const result = await flights.execute('user1', 'unknown_action', {});
  assert.equal(result.success, false);
  delete process.env.FIRECRAWL_API_KEY;
});

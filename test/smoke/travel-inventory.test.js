// Structured travel inventory (api/services/travel-inventory.js).
//
// The provider is exercised through injected transport rather than a live key, so these tests
// prove the two things that are actually ours: that a real provider payload normalizes into
// the candidate shape the rest of travel speaks, and that nothing here ever manufactures an
// answer it does not have. The fixtures are shaped after Duffel's documented responses.

const assert = require('node:assert/strict');
const test = require('node:test');

const inventory = require('../../api/services/travel-inventory');
const { gradeDateMatch } = require('../../api/services/travel-search');

const LIVE = { DUFFEL_ACCESS_TOKEN: 'duffel_live_abc' };
const TEST = { DUFFEL_ACCESS_TOKEN: 'duffel_test_abc' };
const NOW = () => new Date('2026-08-09T12:00:00.000Z');

const FLIGHT_RESPONSE = {
  data: {
    data: {
      offers: [{
        id: 'off_123',
        total_amount: '148.30',
        total_currency: 'GBP',
        expires_at: '2026-08-09T13:00:00Z',
        owner: { name: 'Ryanair', iata_code: 'FR' },
        slices: [
          {
            origin: { iata_code: 'BHX' }, destination: { iata_code: 'PRG' },
            segments: [{ departing_at: '2026-09-18T06:40:00' }]
          },
          {
            origin: { iata_code: 'PRG' }, destination: { iata_code: 'BHX' },
            segments: [{ departing_at: '2026-09-21T19:10:00' }, { departing_at: '2026-09-21T22:00:00' }]
          }
        ]
      }]
    }
  }
};

// ── Configuration is never assumed ─────────────────────────────────────────────────────
test('with no key the provider says so instead of returning nothing', async () => {
  const result = await inventory.searchFlights({ origin: 'BHX', destination: 'PRG', start: '2026-09-18', env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.configured, false);
  assert.match(result.reason, /DUFFEL_ACCESS_TOKEN/);
  assert.deepEqual(result.options, []);
});

test('a test token is never mistaken for real inventory', async () => {
  assert.equal(inventory.providerMode(TEST), 'test');
  assert.equal(inventory.providerMode(LIVE), 'live');
  assert.equal(inventory.providerMode({}), null);

  const result = await inventory.searchFlights({
    origin: 'BHX', destination: 'PRG', start: '2026-09-18', end: '2026-09-21',
    env: TEST, now: NOW, post: async () => FLIGHT_RESPONSE
  });
  assert.equal(result.mode, 'test');
  assert.match(result.options[0].source, /test mode/i);
  assert.match(result.options[0].caveat, /not a real fare/i);
});

// ── Flights ────────────────────────────────────────────────────────────────────────────
test('a real offer normalizes into the shape the rest of travel already speaks', async () => {
  const result = await inventory.searchFlights({
    origin: 'BHX', destination: 'PRG', start: '2026-09-18', end: '2026-09-21',
    env: LIVE, now: NOW, post: async () => FLIGHT_RESPONSE
  });
  assert.equal(result.ok, true);
  const [option] = result.options;

  assert.equal(option.kind, 'flight');
  assert.equal(option.airline, 'Ryanair');
  assert.equal(option.origin, 'BHX');
  assert.equal(option.destination, 'PRG');
  assert.equal(option.stops, 0, 'one segment is a direct flight');
  assert.equal(option.price, 148.3);
  assert.equal(option.currency, 'GBP');
  assert.equal(option.priceBasis, 'return');
  assert.equal(option.observedStart, '2026-09-18');
  assert.equal(option.observedEnd, '2026-09-21');
  assert.equal(option.inventory, true, 'this came from a booking system, not from reading a page');
  assert.equal(option.bookable, true);
  assert.equal(option.observedAt, '2026-08-09T12:00:00.000Z');
  assert.equal(option.offerId, 'off_123');
});

test('the offer does not get to declare its own dates correct', async () => {
  // The whole travel date-integrity rule: the verdict is recomputed from observed dates
  // against requested ones. An inventory offer normally IS for the requested dates — but
  // asserting that ourselves is the unverified claim the rule exists to stop.
  const result = await inventory.searchFlights({
    origin: 'BHX', destination: 'PRG', start: '2026-09-18', end: '2026-09-21',
    env: LIVE, now: NOW, post: async () => FLIGHT_RESPONSE
  });
  const [option] = result.options;
  assert.equal(option.matchesRequestedDates, false, 'not claimed at the source');
  assert.equal(gradeDateMatch(option, { start: '2026-09-18', end: '2026-09-21' }), 'exact');
  assert.equal(gradeDateMatch(option, { start: '2026-09-17', end: '2026-09-20' }), 'adjacent');
});

test('an offer with no price or no airline is not an option', async () => {
  const result = await inventory.searchFlights({
    origin: 'BHX', destination: 'PRG', start: '2026-09-18', env: LIVE, now: NOW,
    post: async () => ({ data: { data: { offers: [
      { id: 'a', total_amount: null, owner: { name: 'Ryanair' }, slices: [{ origin: {}, destination: {}, segments: [] }] },
      { id: 'b', total_amount: '99.00', owner: {}, slices: [{ origin: {}, destination: {}, segments: [] }] }
    ] } } })
  });
  assert.deepEqual(result.options, []);
});

test('a one-way search is priced as one way', async () => {
  const result = await inventory.searchFlights({
    origin: 'BHX', destination: 'PRG', start: '2026-09-18', env: LIVE, now: NOW,
    post: async () => ({ data: { data: { offers: [{
      id: 'o', total_amount: '61.00', total_currency: 'GBP', owner: { name: 'Wizz Air' },
      slices: [{ origin: { iata_code: 'BHX' }, destination: { iata_code: 'PRG' }, segments: [{ departing_at: '2026-09-18T06:40:00' }] }]
    }] } } })
  });
  assert.equal(result.options[0].priceBasis, 'one_way');
  assert.equal(result.options[0].observedEnd, null);
});

test('a connecting flight reports its real stop count', async () => {
  const result = await inventory.searchFlights({
    origin: 'BHX', destination: 'PRG', start: '2026-09-18', env: LIVE, now: NOW,
    post: async () => ({ data: { data: { offers: [{
      id: 'o', total_amount: '210.00', total_currency: 'GBP', owner: { name: 'KLM' },
      slices: [{
        origin: { iata_code: 'BHX' }, destination: { iata_code: 'PRG' },
        segments: [{ departing_at: '2026-09-18T06:40:00' }, { departing_at: '2026-09-18T10:15:00' }]
      }]
    }] } } })
  });
  assert.equal(result.options[0].stops, 1, 'two segments is one stop');
});

// ── Stays ──────────────────────────────────────────────────────────────────────────────
const STAY_RESPONSE = {
  data: {
    data: {
      results: [{
        accommodation: {
          name: 'Hotel Josef',
          rating: 4,
          location: { address: { city_name: 'Prague' } },
          rooms: [{ rates: [
            { total_amount: '480.00', total_currency: 'GBP' },
            { total_amount: '399.00', total_currency: 'GBP' }
          ] }]
        }
      }]
    }
  }
};

test('a stay carries the dates, the guests, and both prices people compare on', async () => {
  const result = await inventory.searchStays({
    latitude: 50.087, longitude: 14.421, checkIn: '2026-09-18', checkOut: '2026-09-21',
    guests: 2, env: LIVE, now: NOW, post: async () => STAY_RESPONSE
  });
  const [stay] = result.options;
  assert.equal(stay.name, 'Hotel Josef');
  assert.equal(stay.area, 'Prague');
  assert.equal(stay.totalPrice, 399, 'the cheapest sellable rate, not the first listed');
  assert.equal(stay.pricePerNight, 133, '399 over three nights');
  assert.equal(stay.currency, 'GBP');
  assert.equal(stay.guests, 2);
  assert.equal(stay.observedStart, '2026-09-18');
  assert.equal(stay.observedEnd, '2026-09-21');
  assert.equal(stay.availabilityStated, true);
  assert.equal(stay.inventory, true);
  assert.equal(gradeDateMatch(stay, { start: '2026-09-18', end: '2026-09-21' }), 'exact');
});

test('a stay with no sellable rate is not an option', async () => {
  const result = await inventory.searchStays({
    latitude: 50.087, longitude: 14.421, checkIn: '2026-09-18', checkOut: '2026-09-21',
    env: LIVE, now: NOW,
    post: async () => ({ data: { data: { results: [{ accommodation: { name: 'Sold Out Inn', rooms: [] } }] } } })
  });
  assert.deepEqual(result.options, []);
});

// ── Failure is reported as failure ─────────────────────────────────────────────────────
test('a provider error is never reported as "no flights"', async () => {
  // These are very different answers to give someone.
  const result = await inventory.searchFlights({
    origin: 'BHX', destination: 'PRG', start: '2026-09-18', env: LIVE, now: NOW,
    post: async () => { throw { response: { status: 401, data: { errors: [{ title: 'Unauthorized', message: 'invalid token' }] } } }; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.configured, true, 'a key IS set — it just did not work');
  assert.match(result.reason, /Unauthorized/);
  assert.deepEqual(result.options, []);
});

test('a search missing its dates is refused before any call is made', async () => {
  let called = false;
  const result = await inventory.searchStays({
    latitude: 50, longitude: 14, checkIn: 'sometime in September',
    env: LIVE, post: async () => { called = true; return STAY_RESPONSE; }
  });
  assert.equal(result.ok, false);
  assert.equal(called, false);
  assert.match(result.reason, /check-in and a check-out date/);
});

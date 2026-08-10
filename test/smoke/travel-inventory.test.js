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

test('with no top-level cheapest_rate field, the cheapest room rate is flattened out as a fallback', async () => {
  // Duffel documents cheapest_rate_total_amount as always present, but rooms[].rates[] as
  // NOT guaranteed on the initial search response — this exercises the defensive fallback
  // for a shape Duffel's docs don't actually promise, in case a future response omits it.
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

test('the documented top-level cheapest_rate fields are the primary source, not a fallback', async () => {
  // "You will always know the cheapest rate" — Duffel's own guarantee. This is what a real
  // search result looks like: rooms/rates may be absent entirely on the initial response.
  const result = await inventory.searchStays({
    latitude: 50.087, longitude: 14.421, checkIn: '2026-09-18', checkOut: '2026-09-21',
    guests: 2, env: LIVE, now: NOW,
    post: async () => ({
      data: {
        data: {
          results: [{
            cheapest_rate_total_amount: '286.50',
            cheapest_rate_currency: 'EUR',
            accommodation: { name: 'Hotel Josef', rating: 4, location: { address: { city_name: 'Prague' } } }
          }]
        }
      }
    })
  });
  const [stay] = result.options;
  assert.equal(stay.totalPrice, 286.5);
  assert.equal(stay.currency, 'EUR');
});

// ── Stays needs separate real-inventory access, even with a working token ──────────────
test('a live token without Stays access is diagnosed distinctly from a generic provider error', async () => {
  const result = await inventory.searchStays({
    latitude: 50.087, longitude: 14.421, checkIn: '2026-09-18', checkOut: '2026-09-21',
    env: LIVE, now: NOW,
    post: async () => { throw { response: { status: 403, data: { errors: [{ title: 'Forbidden', message: 'This account does not have Stays access' }] } } }; }
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not yet approved for live Stays/);
  assert.match(result.reason, /duffel\.com\/contact-us/);
  assert.match(result.reason, /Flights are unaffected/);
});

test('a plain 403/401 with no stays/access wording stays a generic error, not misdiagnosed', async () => {
  const result = await inventory.searchStays({
    latitude: 50.087, longitude: 14.421, checkIn: '2026-09-18', checkOut: '2026-09-21',
    env: LIVE, now: NOW,
    post: async () => { throw { response: { status: 401, data: { errors: [{ title: 'Unauthorized', message: 'invalid token' }] } } }; }
  });
  assert.doesNotMatch(result.reason, /Stays/);
  assert.match(result.reason, /Unauthorized/);
});

test('a test-mode token is never diagnosed as missing Stays access — it always has test access', () => {
  const { isLikelyStaysAccessError } = inventory._private;
  // The distinct message only applies to a LIVE token; searchStays itself gates on
  // providerMode(env) === 'live' before ever consulting this, but the recognizer's own
  // shape is tested here independent of that gate.
  assert.equal(isLikelyStaysAccessError({ response: { status: 403, data: { errors: [{ message: 'no stays access' }] } } }), true);
  assert.equal(isLikelyStaysAccessError({ response: { status: 401, data: {} } }), false);
  assert.equal(isLikelyStaysAccessError({ response: { status: 403, data: { errors: [{ message: 'rate limit exceeded' }] } } }), false);
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

// ── Failure taxonomy: not every non-2xx is the same fact ────────────────────────────────
test('classifyProviderError tells auth, rate-limit, malformed, provider-down and network apart', () => {
  const { classifyProviderError } = inventory._private;
  assert.equal(classifyProviderError({ response: { status: 429 } }), 'rate_limited');
  assert.equal(classifyProviderError({ response: { status: 401 } }), 'auth');
  assert.equal(classifyProviderError({ response: { status: 403 } }), 'auth');
  assert.equal(classifyProviderError({ response: { status: 422 } }), 'malformed_request');
  assert.equal(classifyProviderError({ response: { status: 400 } }), 'malformed_request');
  assert.equal(classifyProviderError({ response: { status: 503 } }), 'provider_unavailable');
  assert.equal(classifyProviderError({ message: 'timeout of 30000ms exceeded' }), 'network');
  assert.equal(classifyProviderError({ response: { status: 418 } }), 'unknown');
});

test('a 429 is reported as rate-limited, never as "no flights found"', async () => {
  const result = await inventory.searchFlights({
    origin: 'BHX', destination: 'PRG', start: '2026-09-18', env: LIVE, now: NOW,
    post: async () => { throw { response: { status: 429, headers: {} } }; },
    sleep: async () => {}
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, 'rate_limited');
  assert.match(result.reason, /temporarily rate-limited/);
  assert.match(result.reason, /not the same as finding no flights/);
});

test('an auth failure and a malformed-request failure carry their own errorKind', async () => {
  const auth = await inventory.searchFlights({
    origin: 'BHX', destination: 'PRG', start: '2026-09-18', env: LIVE, now: NOW,
    post: async () => { throw { response: { status: 401, data: { errors: [{ title: 'Unauthorized' }] } } }; }
  });
  assert.equal(auth.errorKind, 'auth');

  const malformed = await inventory.searchStays({
    latitude: 50, longitude: 14, checkIn: 'nonsense', env: LIVE
  });
  assert.equal(malformed.errorKind, 'malformed_request');

  const staysAccess = await inventory.searchStays({
    latitude: 50, longitude: 14, checkIn: '2026-09-18', checkOut: '2026-09-21', env: LIVE, now: NOW,
    post: async () => { throw { response: { status: 403, data: { errors: [{ message: 'no stays access' }] } } }; }
  });
  assert.equal(staysAccess.errorKind, 'stays_access');
});

// ── Rate limiting: bounded retry, real backoff, Retry-After respected ───────────────────
test('a 429 retries and succeeds on the next attempt, honoring the real Retry-After header', async () => {
  let calls = 0;
  const waits = [];
  const result = await inventory.searchFlights({
    origin: 'BHX', destination: 'PRG', start: '2026-09-18', end: '2026-09-21',
    env: LIVE, now: NOW,
    post: async () => {
      calls += 1;
      if (calls === 1) throw { response: { status: 429, headers: { 'retry-after': '1' } } };
      return FLIGHT_RESPONSE;
    },
    sleep: async (ms) => { waits.push(ms); }
  });
  assert.equal(calls, 2, 'exactly one retry, not a fresh call per failure indefinitely');
  assert.deepEqual(waits, [1000], 'the real Retry-After value was honored, not a guessed backoff');
  assert.equal(result.ok, true);
  assert.equal(result.options[0].airline, 'Ryanair');
});

test('repeated 429s are bounded — it gives up and reports rate-limited rather than retrying forever', async () => {
  let calls = 0;
  const result = await inventory.searchFlights({
    origin: 'BHX', destination: 'PRG', start: '2026-09-18', env: LIVE, now: NOW,
    post: async () => { calls += 1; throw { response: { status: 429, headers: {} } }; },
    sleep: async () => {}
  });
  assert.equal(calls, 3, 'a bounded number of attempts, not unbounded retry');
  assert.equal(result.errorKind, 'rate_limited');
});

test('a non-429 failure is never retried — retrying an auth failure would just repeat it slower', async () => {
  let calls = 0;
  const result = await inventory.searchFlights({
    origin: 'BHX', destination: 'PRG', start: '2026-09-18', env: LIVE, now: NOW,
    post: async () => { calls += 1; throw { response: { status: 401, data: {} } }; },
    sleep: async () => { throw new Error('should never sleep for a non-retryable error'); }
  });
  assert.equal(calls, 1);
  assert.equal(result.errorKind, 'auth');
});

test('retryAfterMsFrom reads seconds, an HTTP date, or gives up honestly on neither', () => {
  const { retryAfterMsFrom } = inventory._private;
  assert.equal(retryAfterMsFrom({ response: { headers: { 'retry-after': '5' } } }), 5000);
  assert.equal(retryAfterMsFrom({ response: { headers: {} } }), null);
  assert.equal(retryAfterMsFrom({ response: {} }), null);
  assert.equal(retryAfterMsFrom({}), null);
  const future = new Date(Date.now() + 10000).toUTCString();
  const ms = retryAfterMsFrom({ response: { headers: { 'retry-after': future } } });
  assert.ok(ms > 8000 && ms <= 10000, 'an HTTP-date form is also honored, not just seconds');
});

// ── Price integrity ──────────────────────────────────────────────────────────────────────
test('a flight total is marked as a total, never silently treated as per-person', async () => {
  const result = await inventory.searchFlights({
    origin: 'BHX', destination: 'PRG', start: '2026-09-18', end: '2026-09-21', passengers: 4,
    env: LIVE, now: NOW, post: async () => FLIGHT_RESPONSE
  });
  const [option] = result.options;
  assert.equal(option.priceIsTotal, true);
  assert.equal(option.passengers, 4);
  assert.equal(option.price, 148.3, 'the raw total from Duffel — not divided or multiplied');
});

test('a single-passenger search still records passengers, defaulting sanely', async () => {
  const result = await inventory.searchFlights({
    origin: 'BHX', destination: 'PRG', start: '2026-09-18', env: LIVE, now: NOW,
    post: async () => FLIGHT_RESPONSE
  });
  assert.equal(result.options[0].passengers, 1);
});

test('offer expiry is retained and evaluated, never treated as timeless', async () => {
  const result = await inventory.searchFlights({
    origin: 'BHX', destination: 'PRG', start: '2026-09-18', end: '2026-09-21',
    env: LIVE, now: NOW, post: async () => FLIGHT_RESPONSE
  });
  const [option] = result.options;
  assert.equal(option.expiresAt, '2026-08-09T13:00:00Z');
  assert.equal(option.expired, false, 'expires an hour after this offer was fetched');
});

test('an offer already past its own expiry is flagged rather than presented as current', async () => {
  const stale = { data: { data: { offers: [{
    ...FLIGHT_RESPONSE.data.data.offers[0],
    expires_at: '2026-08-09T11:00:00Z' // an hour BEFORE the fixture's "now"
  }] } } };
  const result = await inventory.searchFlights({
    origin: 'BHX', destination: 'PRG', start: '2026-09-18', end: '2026-09-21',
    env: LIVE, now: NOW, post: async () => stale
  });
  assert.equal(result.options[0].expired, true);
});

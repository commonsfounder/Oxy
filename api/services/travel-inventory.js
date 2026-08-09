'use strict';

// Structured travel inventory: priced options for the dates actually asked for, from a
// booking system rather than from reading web pages.
//
// Why this exists alongside the grounded web search in travel-search.js: that search is
// honest but structurally weak. It reads whatever a page happened to say, so exact-date
// pricing is rare, adjacent dates are common, and nothing it returns is bookable. An
// inventory API answers the question that was asked — these dates, this cabin, this many
// guests — or says there is nothing.
//
// PROVIDER CHOICE (audited August 2026, not inherited):
//   - Amadeus Self-Service, the obvious 2025 answer, closed to new developers in August 2026.
//   - Kiwi Tequila became invite-only partner access in 2026.
//   - Duffel remains genuinely self-serve: sign up, get a key, flights from 300+ airlines and
//     ~2M properties through Stays, one REST API, UK company, prices in GBP/EUR natively.
// So the adapter below speaks Duffel. It is kept behind a narrow interface because that
// audit will go stale too — a second provider means another `normalize*` pair, not a rewrite.
//
// What this module will NOT do: invent a response. With no key configured it reports that it
// is unconfigured and the caller falls back to grounded search, which is honest about being
// evidence rather than inventory.

const axios = require('axios');

const DUFFEL_BASE = 'https://api.duffel.com';
const DUFFEL_VERSION = 'v2';
const REQUEST_TIMEOUT_MS = 30000;

// Duffel issues separate live and test tokens. A test token returns a fictional carrier
// ("Duffel Airways", IATA ZZ) with unrealistic prices — useful for proving the integration
// works, useless as an answer to a real travel question. The distinction is carried all the
// way out to the candidate so nothing downstream can present sandbox data as a real fare.
function providerMode(env = process.env) {
  const token = env.DUFFEL_ACCESS_TOKEN || '';
  if (!token) return null;
  // Duffel's own convention for the two token families.
  return token.startsWith('duffel_test') ? 'test' : 'live';
}

function isConfigured(env = process.env) {
  return Boolean(providerMode(env));
}

function describeUnconfigured(env = process.env) {
  if (isConfigured(env)) return null;
  return 'no travel inventory provider is configured (set DUFFEL_ACCESS_TOKEN)';
}

function headers(env = process.env) {
  return {
    Authorization: `Bearer ${env.DUFFEL_ACCESS_TOKEN}`,
    'Duffel-Version': DUFFEL_VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

function isoDay(value) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? '').trim());
  return match ? match[1] : null;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function nightsBetween(start, end) {
  const a = isoDay(start);
  const b = isoDay(end);
  if (!a || !b) return null;
  const nights = Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  return nights > 0 ? nights : null;
}

// ── Normalizing into the shape the rest of travel already speaks ───────────────────────
//
// Deliberately the SAME candidate shape travel-search.js produces, so ranking, currency
// grouping and date-provenance grading all keep working untouched. Two fields carry the
// difference that matters:
//   inventory: true      — this came from a booking system, not from reading a page
//   observedStart/End    — the dates the OFFER is for, which for an inventory search are the
//                          dates we asked for, so gradeDateMatch can verify rather than trust.

function normalizeFlightOffer(offer = {}, { requestedStart, requestedEnd, mode, observedAt } = {}) {
  const price = toNumber(offer.total_amount);
  const slices = Array.isArray(offer.slices) ? offer.slices : [];
  const outbound = slices[0];
  const inbound = slices[1] || null;
  const airline = String(offer.owner?.name || '').trim();
  if (!price || !airline || !outbound) return null;

  // Duffel counts segments; stops is one fewer. A single-segment slice is a direct flight.
  const segments = Array.isArray(outbound.segments) ? outbound.segments.length : 0;
  const observedStart = isoDay(outbound.segments?.[0]?.departing_at) || isoDay(requestedStart);
  const observedEnd = inbound
    ? (isoDay(inbound.segments?.[0]?.departing_at) || isoDay(requestedEnd))
    : null;

  return {
    kind: 'flight',
    airline,
    stops: segments > 0 ? segments - 1 : null,
    durationMinutes: null,
    price,
    currency: String(offer.total_currency || 'GBP').toUpperCase(),
    priceBasis: inbound ? 'return' : 'one_way',
    origin: outbound.origin?.iata_code || null,
    destination: outbound.destination?.iata_code || null,
    quotedFor: `${outbound.origin?.iata_code || '?'}→${outbound.destination?.iata_code || '?'}${inbound ? ' return' : ' one way'}`,
    observedStart,
    observedEnd,
    // Never asserted here: gradeDateMatch recomputes it from observedStart/End against what
    // was requested. An inventory offer normally IS for the requested dates, but saying so
    // ourselves would be exactly the unverified claim the travel work exists to prevent.
    matchesRequestedDates: false,
    inventory: true,
    bookable: true,
    offerId: offer.id || null,
    expiresAt: offer.expires_at || null,
    observedAt,
    source: mode === 'test' ? 'Duffel (test mode — fictional inventory)' : 'Duffel',
    sourceUrl: null,
    caveat: mode === 'test'
      ? 'Sandbox data from Duffel Airways, not a real fare.'
      : null
  };
}

function normalizeStay(result = {}, { requestedStart, requestedEnd, guests, mode, observedAt } = {}) {
  const accommodation = result.accommodation || {};
  const cheapest = (accommodation.rooms || [])
    .flatMap(room => room.rates || [])
    .map(rate => ({ amount: toNumber(rate.total_amount), currency: rate.total_currency }))
    .filter(rate => rate.amount)
    .sort((a, b) => a.amount - b.amount)[0];

  const total = cheapest?.amount || toNumber(result.cheapest_rate_total_amount);
  const currency = String(cheapest?.currency || result.cheapest_rate_currency || 'GBP').toUpperCase();
  const name = String(accommodation.name || '').trim();
  if (!name || !total) return null;

  const nights = nightsBetween(requestedStart, requestedEnd);

  return {
    kind: 'hotel',
    name,
    area: accommodation.location?.address?.city_name || null,
    rating: Number.isFinite(accommodation.rating) ? accommodation.rating : null,
    // Both, where the stay length is known — a nightly rate is what people compare on and a
    // total is what they actually pay.
    pricePerNight: nights ? Math.round((total / nights) * 100) / 100 : null,
    totalPrice: total,
    currency,
    guests: guests || null,
    quotedFor: nights ? `${nights} night${nights === 1 ? '' : 's'}${guests ? `, ${guests} guest${guests === 1 ? '' : 's'}` : ''}` : '',
    observedStart: isoDay(requestedStart),
    observedEnd: isoDay(requestedEnd),
    matchesRequestedDates: false,
    // An inventory search only returns what is sellable for those dates, which is a genuinely
    // stronger statement than a web page mentioning a price.
    availabilityStated: true,
    inventory: true,
    bookable: true,
    observedAt,
    source: mode === 'test' ? 'Duffel Stays (test mode — fictional inventory)' : 'Duffel Stays',
    sourceUrl: null,
    caveat: mode === 'test' ? 'Sandbox data, not real availability.' : null
  };
}

// ── Searches ───────────────────────────────────────────────────────────────────────────

function unconfiguredResult(env) {
  return { ok: false, configured: false, reason: describeUnconfigured(env), options: [] };
}

function failed(reason) {
  return { ok: false, configured: true, reason, options: [] };
}

async function searchFlights({
  origin, destination, start, end, passengers = 1, cabin = 'economy',
  env = process.env, now = () => new Date(), post = null
} = {}) {
  if (!isConfigured(env)) return unconfiguredResult(env);
  if (!origin || !destination || !isoDay(start)) {
    return failed('a flight search needs an origin, a destination and a departure date');
  }

  const slices = [{ origin, destination, departure_date: isoDay(start) }];
  if (isoDay(end)) slices.push({ origin: destination, destination: origin, departure_date: isoDay(end) });

  const body = {
    data: {
      slices,
      passengers: Array.from({ length: Math.max(1, Number(passengers) || 1) }, () => ({ type: 'adult' })),
      cabin_class: cabin
    }
  };

  const send = post || ((url, payload) => axios.post(url, payload, { headers: headers(env), timeout: REQUEST_TIMEOUT_MS }));
  let response;
  try {
    // return_offers keeps this a single round trip; the alternative is create-then-poll.
    response = await send(`${DUFFEL_BASE}/air/offer_requests?return_offers=true`, body);
  } catch (error) {
    return failed(describeProviderError(error));
  }

  const mode = providerMode(env);
  const observedAt = now().toISOString();
  const offers = response?.data?.data?.offers || [];
  const options = offers
    .map(offer => normalizeFlightOffer(offer, { requestedStart: start, requestedEnd: end, mode, observedAt }))
    .filter(Boolean);

  return { ok: true, configured: true, mode, observedAt, options };
}

async function searchStays({
  latitude, longitude, radiusKm = 8, checkIn, checkOut, guests = 2, rooms = 1,
  env = process.env, now = () => new Date(), post = null
} = {}) {
  if (!isConfigured(env)) return unconfiguredResult(env);
  if (!isoDay(checkIn) || !isoDay(checkOut)) {
    return failed('a stay search needs a check-in and a check-out date');
  }
  if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) {
    return failed('a stay search needs a location to search around');
  }

  const body = {
    data: {
      location: { radius: Math.max(1, Math.round(radiusKm)), geographic_coordinates: { latitude: Number(latitude), longitude: Number(longitude) } },
      check_in_date: isoDay(checkIn),
      check_out_date: isoDay(checkOut),
      rooms: Math.max(1, Number(rooms) || 1),
      guests: Array.from({ length: Math.max(1, Number(guests) || 1) }, () => ({ type: 'adult' }))
    }
  };

  const send = post || ((url, payload) => axios.post(url, payload, { headers: headers(env), timeout: REQUEST_TIMEOUT_MS }));
  let response;
  try {
    response = await send(`${DUFFEL_BASE}/stays/search`, body);
  } catch (error) {
    return failed(describeProviderError(error));
  }

  const mode = providerMode(env);
  const observedAt = now().toISOString();
  const results = response?.data?.data?.results || [];
  const options = results
    .map(result => normalizeStay(result, { requestedStart: checkIn, requestedEnd: checkOut, guests, mode, observedAt }))
    .filter(Boolean);

  return { ok: true, configured: true, mode, observedAt, options };
}

// Provider errors are reported as themselves. A travel search that quietly returns nothing
// because a token expired is indistinguishable from "there are no flights", and those are
// very different answers to give someone.
function describeProviderError(error) {
  const detail = error?.response?.data?.errors?.[0];
  if (detail) return `${detail.title || 'provider error'}: ${detail.message || detail.code || ''}`.trim();
  if (error?.response?.status) return `the travel provider returned ${error.response.status}`;
  return error?.message || 'the travel provider could not be reached';
}

module.exports = {
  isConfigured,
  providerMode,
  describeUnconfigured,
  searchFlights,
  searchStays,
  _private: { normalizeFlightOffer, normalizeStay, describeProviderError, nightsBetween }
};

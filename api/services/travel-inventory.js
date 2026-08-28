'use strict';

// Structured travel inventory: priced, bookable options for the dates actually asked for,
// where the grounded search in travel-search.js can only report what some page happened to say.
//
// The adapter speaks Duffel, behind a narrow interface because that choice will go stale — a
// second provider is another `normalize*` pair, not a rewrite. Flights and Stays do NOT unlock
// together: a DUFFEL_ACCESS_TOKEN gives real flight inventory immediately, while Stays needs
// access requested and approved separately and is test-only until then. searchFlights and
// searchStays stay independent exports for that reason.
//
// With no key configured this reports itself unconfigured rather than inventing a response,
// and the caller falls back to grounded search.

const axios = require('axios');

const DUFFEL_BASE = 'https://api.duffel.com';
const DUFFEL_VERSION = 'v2';
const REQUEST_TIMEOUT_MS = 30000;

// A 429 is not "no flights", it is the provider asking to wait, usually with a Retry-After.
// Bounded to 3 attempts with a capped wait, so a rate-limited search can't stall a chat turn.
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 2000;
const defaultSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// A test token returns a fictional carrier at unrealistic prices — fine for proving the
// integration works. The distinction rides on the candidate so nothing presents it as a fare.
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
// The same candidate shape travel-search.js produces, so ranking and date grading keep working.
// `inventory: true` marks it as coming from a booking system, and observedStart/End are the
// dates the offer is actually for, so gradeDateMatch can verify rather than trust.

function normalizeFlightOffer(offer = {}, { requestedStart, requestedEnd, passengers, mode, observedAt } = {}) {
  // total_amount is Duffel's price for the WHOLE booking — every passenger, taxes included —
  // never a per-person figure. Carrying passengers alongside it is what stops a multi-traveler
  // total from being misread as one person's fare downstream.
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
  const expiresAt = offer.expires_at || null;

  return {
    kind: 'flight',
    airline,
    stops: segments > 0 ? segments - 1 : null,
    durationMinutes: null,
    price,
    priceIsTotal: true,
    passengers: Number.isFinite(passengers) && passengers > 0 ? passengers : 1,
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
    expiresAt,
    // Computed once, at the moment the offer was fetched — a fresh offer is never expired at
    // fetch time, but the field exists so nothing downstream has to re-derive it from a raw
    // timestamp (or forget to) before deciding whether the price is still good.
    expired: expiresAt ? Date.parse(expiresAt) <= Date.parse(observedAt) : null,
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

  // cheapest_rate_total_amount is documented as always present, so it is the primary source.
  // rooms[].rates[] is not guaranteed on a search response (hotel APIs commonly need a second
  // per-property fetch), so flattening it is only a fallback.
  const cheapestField = toNumber(result.cheapest_rate_total_amount);
  const cheapestFromRooms = (accommodation.rooms || [])
    .flatMap(room => room.rates || [])
    .map(rate => ({ amount: toNumber(rate.total_amount), currency: rate.total_currency }))
    .filter(rate => rate.amount)
    .sort((a, b) => a.amount - b.amount)[0];

  const total = cheapestField || cheapestFromRooms?.amount;
  const currency = String(result.cheapest_rate_currency || cheapestFromRooms?.currency || 'GBP').toUpperCase();
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

function failed(reason, errorKind = 'unknown') {
  return { ok: false, configured: true, reason, errorKind, options: [] };
}

function isRateLimited(error) {
  return error?.response?.status === 429;
}

// Retry-After is normally a delay in seconds, but per RFC 9110 it may instead be an HTTP date.
// axios lower-cases response header names, so 'retry-after' is the only form actually seen.
function retryAfterMsFrom(error) {
  const header = error?.response?.headers?.['retry-after'];
  if (header === undefined || header === null || header === '') return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(header);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

// Bounded: at most MAX_ATTEMPTS total calls to `send`, and only 429 is retried — every other
// failure (auth, malformed request, provider down) is thrown straight back, since retrying
// those would just repeat the same failure slower.
async function sendWithRetry(send, url, body, { sleep = defaultSleep } = {}) {
  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await send(url, body);
    } catch (error) {
      lastError = error;
      if (!isRateLimited(error) || attempt === MAX_ATTEMPTS - 1) throw error;
      const wait = Math.min(retryAfterMsFrom(error) ?? BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
      await sleep(wait);
    }
  }
  throw lastError;
}

async function searchFlights({
  origin, destination, start, end, passengers = 1, cabin = 'economy',
  env = process.env, now = () => new Date(), post = null, sleep = defaultSleep
} = {}) {
  if (!isConfigured(env)) return unconfiguredResult(env);
  if (!origin || !destination || !isoDay(start)) {
    return failed('a flight search needs an origin, a destination and a departure date', 'malformed_request');
  }

  const partySize = Math.max(1, Number(passengers) || 1);
  const slices = [{ origin, destination, departure_date: isoDay(start) }];
  if (isoDay(end)) slices.push({ origin: destination, destination: origin, departure_date: isoDay(end) });

  const body = {
    data: {
      slices,
      passengers: Array.from({ length: partySize }, () => ({ type: 'adult' })),
      cabin_class: cabin
    }
  };

  const send = post || ((url, payload) => axios.post(url, payload, { headers: headers(env), timeout: REQUEST_TIMEOUT_MS }));
  let response;
  try {
    // return_offers keeps this a single round trip; the alternative is create-then-poll.
    response = await sendWithRetry(send, `${DUFFEL_BASE}/air/offer_requests?return_offers=true`, body, { sleep });
  } catch (error) {
    return failed(describeProviderError(error), classifyProviderError(error));
  }

  const mode = providerMode(env);
  const observedAt = now().toISOString();
  const offers = response?.data?.data?.offers || [];
  const options = offers
    .map(offer => normalizeFlightOffer(offer, { requestedStart: start, requestedEnd: end, passengers: partySize, mode, observedAt }))
    .filter(Boolean);

  return { ok: true, configured: true, mode, observedAt, options };
}

async function searchStays({
  latitude, longitude, radiusKm = 8, checkIn, checkOut, guests = 2, rooms = 1,
  env = process.env, now = () => new Date(), post = null, sleep = defaultSleep
} = {}) {
  if (!isConfigured(env)) return unconfiguredResult(env);
  if (!isoDay(checkIn) || !isoDay(checkOut)) {
    return failed('a stay search needs a check-in and a check-out date', 'malformed_request');
  }
  if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) {
    return failed('a stay search needs a location to search around', 'malformed_request');
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
    response = await sendWithRetry(send, `${DUFFEL_BASE}/stays/search`, body, { sleep });
  } catch (error) {
    // A token live for flights can still be test-only for Stays, which needs separate approval.
    // Surfaced distinctly so it reads as "ask for Stays access", not an expired key.
    if (providerMode(env) === 'live' && isLikelyStaysAccessError(error)) {
      return failed('this Duffel account is not yet approved for live Stays (hotel) access — request it at duffel.com/contact-us. Flights are unaffected.', 'stays_access');
    }
    return failed(describeProviderError(error), classifyProviderError(error));
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
  if (isRateLimited(error)) {
    return 'the travel provider is temporarily rate-limited — this is not the same as finding no flights, try again shortly';
  }
  const detail = error?.response?.data?.errors?.[0];
  if (detail) return `${detail.title || 'provider error'}: ${detail.message || detail.code || ''}`.trim();
  if (error?.response?.status) return `the travel provider returned ${error.response.status}`;
  return error?.message || 'the travel provider could not be reached';
}

// A taxonomy, not just a message — so a caller can tell "the account is misconfigured" apart
// from "try again in a second" apart from "the provider itself is down" without parsing prose.
function classifyProviderError(error) {
  if (isRateLimited(error)) return 'rate_limited';
  const status = error?.response?.status;
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 || status === 422) return 'malformed_request';
  if (Number.isFinite(status) && status >= 500) return 'provider_unavailable';
  if (!error?.response) return 'network';
  return 'unknown';
}

// Best-effort, not a documented error code: only a 403 whose text mentions Stays or access
// counts. A 401 — what a bad token looks like — falls through to the generic message.
function isLikelyStaysAccessError(error) {
  if (error?.response?.status !== 403) return false;
  const text = JSON.stringify(error?.response?.data || '').toLowerCase();
  return text.includes('stay') || text.includes('access');
}

module.exports = {
  isConfigured,
  providerMode,
  describeUnconfigured,
  searchFlights,
  searchStays,
  _private: {
    normalizeFlightOffer, normalizeStay, describeProviderError, classifyProviderError,
    isLikelyStaysAccessError, nightsBetween, retryAfterMsFrom, sendWithRetry
  }
};

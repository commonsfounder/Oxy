const SUPPORTED_ACTIONS = ['search_flights', 'get_flight_details', 'get_flight_prices'];

const AMADEUS_BASE = 'https://test.api.amadeus.com'; // ponytail: test env; swap AMADEUS_ENV=production for live

function getAxios() { return require('axios'); }

let _token = null;
let _tokenExpiry = 0;

async function getAmadeusToken() {
  const key = process.env.AMADEUS_API_KEY;
  const secret = process.env.AMADEUS_API_SECRET;
  if (!key || !secret) throw new Error('AMADEUS_API_KEY and AMADEUS_API_SECRET are required.');

  if (_token && Date.now() < _tokenExpiry) return _token;

  const base = process.env.AMADEUS_ENV === 'production'
    ? 'https://api.amadeus.com'
    : AMADEUS_BASE;

  const axios = getAxios();
  const resp = await axios.post(`${base}/v1/security/oauth2/token`, new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: key,
    client_secret: secret
  }), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000
  });

  _token = resp.data.access_token;
  _tokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000; // 1 min buffer
  return _token;
}

function amadeusBase() {
  return process.env.AMADEUS_ENV === 'production'
    ? 'https://api.amadeus.com'
    : AMADEUS_BASE;
}

async function searchFlights({ origin, destination, date, returnDate, partySize, cabinClass, maxPrice }) {
  if (!origin || !destination || !date) {
    return { success: false, error: 'origin, destination, and date are required for flight search.' };
  }

  const token = await getAmadeusToken();
  const axios = getAxios();

  const params = {
    originLocationCode: toIATA(origin),
    destinationLocationCode: toIATA(destination),
    departureDate: normalizeDate(date),
    adults: parseInt(partySize || 1, 10),
    currencyCode: 'GBP',
    max: 10
  };
  if (returnDate) params.returnDate = normalizeDate(returnDate);
  if (cabinClass) params.travelClass = cabinClass.toUpperCase();
  if (maxPrice) params.maxPrice = parseInt(maxPrice, 10);

  const resp = await axios.get(`${amadeusBase()}/v2/shopping/flight-offers`, {
    headers: { Authorization: `Bearer ${token}` },
    params,
    timeout: 15000
  });

  const offers = resp.data?.data || [];
  if (!offers.length) return { success: true, data: [], text: `No flights found from ${origin} to ${destination} on ${date}.` };

  const formatted = offers.slice(0, 5).map(formatFlightOffer);
  return {
    success: true,
    data: formatted,
    text: buildFlightSummary(formatted, origin, destination, date)
  };
}

async function getFlightPrices({ origin, destination, date }) {
  // Same as search but returns a price range summary
  const result = await searchFlights({ origin, destination, date });
  if (!result.success || !result.data?.length) return result;
  const prices = result.data.map(f => f.totalPrice).filter(Boolean);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return {
    success: true,
    data: { min, max, currency: 'GBP', sampleSize: prices.length },
    text: `Flights from ${origin} to ${destination} on ${date}: from £${min} to £${max} (${prices.length} options found).`
  };
}

function formatFlightOffer(offer) {
  const itinerary = offer.itineraries?.[0];
  const segments = itinerary?.segments || [];
  const firstSeg = segments[0] || {};
  const lastSeg = segments[segments.length - 1] || {};
  const price = parseFloat(offer.price?.grandTotal || 0);
  const stops = segments.length - 1;

  return {
    id: offer.id,
    airline: firstSeg.carrierCode || 'Unknown',
    flightNumber: `${firstSeg.carrierCode}${firstSeg.number}`,
    departure: firstSeg.departure?.at,
    arrival: lastSeg.arrival?.at,
    origin: firstSeg.departure?.iataCode,
    destination: lastSeg.arrival?.iataCode,
    stops,
    duration: itinerary?.duration,
    totalPrice: price,
    currency: offer.price?.currency || 'GBP',
    cabinClass: offer.travelerPricings?.[0]?.fareDetailsBySegment?.[0]?.cabin || 'ECONOMY',
    seatsRemaining: offer.numberOfBookableSeats
  };
}

function buildFlightSummary(flights, origin, destination, date) {
  const lines = [`Found ${flights.length} flight options from ${origin} to ${destination} on ${date}:`];
  for (const f of flights) {
    const stops = f.stops === 0 ? 'direct' : `${f.stops} stop${f.stops > 1 ? 's' : ''}`;
    lines.push(`- ${f.airline} ${f.flightNumber}: departs ${formatTime(f.departure)}, arrives ${formatTime(f.arrival)}, ${stops}, £${f.totalPrice}`);
  }
  return lines.join('\n');
}

function toIATA(input = '') {
  const s = input.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(s)) return s;
  // Common city → IATA mappings
  const CITY_MAP = {
    'LONDON': 'LON', 'LONDON HEATHROW': 'LHR', 'HEATHROW': 'LHR',
    'LONDON GATWICK': 'LGW', 'GATWICK': 'LGW',
    'LONDON STANSTED': 'STN', 'STANSTED': 'STN',
    'LONDON CITY': 'LCY',
    'MANCHESTER': 'MAN', 'BIRMINGHAM': 'BHX', 'EDINBURGH': 'EDI',
    'GLASGOW': 'GLA', 'BRISTOL': 'BRS', 'LIVERPOOL': 'LPL',
    'TOKYO': 'TYO', 'OSAKA': 'OSA', 'KYOTO': 'UKY',
    'PARIS': 'CDG', 'AMSTERDAM': 'AMS', 'FRANKFURT': 'FRA',
    'MADRID': 'MAD', 'BARCELONA': 'BCN', 'ROME': 'FCO',
    'MILAN': 'MXP', 'LISBON': 'LIS', 'ATHENS': 'ATH',
    'NEW YORK': 'NYC', 'LOS ANGELES': 'LAX', 'CHICAGO': 'ORD',
    'DUBAI': 'DXB', 'SINGAPORE': 'SIN', 'HONG KONG': 'HKG',
    'BANGKOK': 'BKK', 'SYDNEY': 'SYD', 'MELBOURNE': 'MEL',
    'TORONTO': 'YTO', 'VANCOUVER': 'YVR', 'MONTREAL': 'YMQ',
    'CAPE TOWN': 'CPT', 'JOHANNESBURG': 'JNB', 'NAIROBI': 'NBO',
    'DELHI': 'DEL', 'MUMBAI': 'BOM', 'BANGALORE': 'BLR'
  };
  return CITY_MAP[s] || s.slice(0, 3);
}

function normalizeDate(input = '') {
  const s = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Best-effort: if it's "next Friday" etc, can't resolve without current date in connector
  // The AI should pass ISO dates; fuzzy dates are handled upstream
  return s;
}

function formatTime(isoStr) {
  if (!isoStr) return 'TBC';
  try {
    return new Date(isoStr).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
  } catch { return isoStr; }
}

async function execute(userId, action, params) {
  if (!process.env.AMADEUS_API_KEY) {
    return { success: false, error: 'Flight search is not configured (AMADEUS_API_KEY missing).' };
  }
  try {
    if (action === 'search_flights') return await searchFlights(params || {});
    if (action === 'get_flight_prices') return await getFlightPrices(params || {});
    if (action === 'get_flight_details') return await searchFlights({ ...params, max: 1 });
    return { success: false, error: `Unknown flight action: ${action}` };
  } catch (err) {
    const msg = err?.response?.data?.errors?.[0]?.detail || err.message || 'Flight search failed';
    return { success: false, error: msg };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };

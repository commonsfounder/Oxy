const SUPPORTED_ACTIONS = ['search_hotels', 'get_hotel_details', 'check_hotel_availability'];

// Reuses Amadeus credentials — same API key covers flights + hotels
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
    : 'https://test.api.amadeus.com';

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
  _tokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000;
  return _token;
}

function amadeusBase() {
  return process.env.AMADEUS_ENV === 'production'
    ? 'https://api.amadeus.com'
    : 'https://test.api.amadeus.com';
}

// City name → IATA city code (for hotel search, Amadeus uses city codes, not airport codes)
const CITY_CODES = {
  'tokyo': 'TYO', 'paris': 'PAR', 'london': 'LON', 'rome': 'ROM',
  'barcelona': 'BCN', 'madrid': 'MAD', 'amsterdam': 'AMS',
  'berlin': 'BER', 'vienna': 'VIE', 'prague': 'PRG', 'budapest': 'BUD',
  'athens': 'ATH', 'lisbon': 'LIS', 'milan': 'MIL',
  'new york': 'NYC', 'los angeles': 'LAX', 'chicago': 'CHI',
  'dubai': 'DXB', 'singapore': 'SIN', 'hong kong': 'HKG',
  'bangkok': 'BKK', 'sydney': 'SYD', 'melbourne': 'MEL',
  'toronto': 'YTO', 'vancouver': 'YVR',
  'cape town': 'CPT', 'johannesburg': 'JNB',
  'delhi': 'DEL', 'mumbai': 'BOM',
  'edinburgh': 'EDI', 'manchester': 'MAN', 'birmingham': 'BHX'
};

function toCityCode(city = '') {
  const lower = city.toLowerCase().trim();
  if (/^[A-Z]{3}$/i.test(lower)) return lower.toUpperCase();
  return CITY_CODES[lower] || lower.slice(0, 3).toUpperCase();
}

async function searchHotels({ destination, checkIn, checkOut, guests, maxPrice, style, amenities }) {
  if (!destination || !checkIn || !checkOut) {
    return { success: false, error: 'destination, checkIn, and checkOut are required for hotel search.' };
  }

  const token = await getAmadeusToken();
  const axios = getAxios();
  const cityCode = toCityCode(destination);

  // Step 1: get hotel IDs for the city
  const hotelsResp = await axios.get(`${amadeusBase()}/v1/reference-data/locations/hotels/by-city`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { cityCode, radius: 5, radiusUnit: 'KM', ratings: styleToRatings(style), max: 20 },
    timeout: 15000
  });

  const hotelIds = (hotelsResp.data?.data || []).slice(0, 10).map(h => h.hotelId);
  if (!hotelIds.length) {
    return { success: false, error: `No hotels found in ${destination}.` };
  }

  // Step 2: get availability + pricing
  const offersResp = await axios.get(`${amadeusBase()}/v3/shopping/hotel-offers`, {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      hotelIds: hotelIds.join(','),
      checkInDate: normalizeDate(checkIn),
      checkOutDate: normalizeDate(checkOut),
      adults: parseInt(guests || 2, 10),
      currency: 'GBP',
      bestRateOnly: true
    },
    timeout: 15000
  });

  const offers = offersResp.data?.data || [];
  if (!offers.length) {
    return { success: true, data: [], text: `No available hotels found in ${destination} for those dates.` };
  }

  let formatted = offers.map(o => formatHotelOffer(o, checkIn, checkOut));
  if (maxPrice) formatted = formatted.filter(h => !h.pricePerNight || h.pricePerNight <= maxPrice);

  return {
    success: true,
    data: formatted.slice(0, 8),
    text: buildHotelSummary(formatted.slice(0, 5), destination, checkIn, checkOut)
  };
}

async function getHotelDetails({ hotelId, checkIn, checkOut, guests }) {
  if (!hotelId) return { success: false, error: 'hotelId is required.' };
  const token = await getAmadeusToken();
  const axios = getAxios();

  const resp = await axios.get(`${amadeusBase()}/v3/shopping/hotel-offers`, {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      hotelIds: hotelId,
      checkInDate: normalizeDate(checkIn),
      checkOutDate: normalizeDate(checkOut),
      adults: parseInt(guests || 2, 10),
      currency: 'GBP'
    },
    timeout: 12000
  });

  const hotel = resp.data?.data?.[0];
  if (!hotel) return { success: false, error: 'Hotel not found.' };
  return { success: true, data: formatHotelOffer(hotel, checkIn, checkOut) };
}

function formatHotelOffer(offer, checkIn, checkOut) {
  const hotel = offer.hotel || {};
  const room = offer.offers?.[0] || {};
  const price = parseFloat(room.price?.total || 0);
  const nights = nightsBetween(checkIn, checkOut) || 1;
  const perNight = Math.round(price / nights);

  return {
    id: hotel.hotelId,
    name: hotel.name,
    rating: hotel.rating,
    city: hotel.cityCode,
    latitude: hotel.latitude,
    longitude: hotel.longitude,
    checkIn: room.checkInDate,
    checkOut: room.checkOutDate,
    totalPrice: price,
    pricePerNight: perNight,
    currency: room.price?.currency || 'GBP',
    roomType: room.room?.typeEstimated?.category,
    bedType: room.room?.typeEstimated?.bedType,
    amenities: hotel.amenities?.slice(0, 5) || []
  };
}

function buildHotelSummary(hotels, destination, checkIn, checkOut) {
  const nights = nightsBetween(checkIn, checkOut);
  const lines = [`Found ${hotels.length} hotels in ${destination} (${checkIn} to ${checkOut}, ${nights} nights):`];
  for (const h of hotels) {
    const stars = h.rating ? `${'★'.repeat(Math.min(h.rating, 5))} ` : '';
    lines.push(`- ${stars}${h.name}: £${h.pricePerNight}/night (£${h.totalPrice} total)`);
  }
  return lines.join('\n');
}

function styleToRatings(style) {
  if (style === 'budget') return '1,2,3';
  if (style === 'luxury') return '4,5';
  if (style === 'boutique') return '4,5';
  return '3,4,5'; // default mid+
}

function nightsBetween(checkIn, checkOut) {
  if (!checkIn || !checkOut) return 0;
  try {
    return Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);
  } catch { return 0; }
}

function normalizeDate(input = '') {
  const s = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return s;
}

async function execute(userId, action, params) {
  if (!process.env.AMADEUS_API_KEY) {
    return { success: false, error: 'Hotel search is not configured (AMADEUS_API_KEY missing).' };
  }
  try {
    if (action === 'search_hotels') return await searchHotels(params || {});
    if (action === 'get_hotel_details') return await getHotelDetails(params || {});
    if (action === 'check_hotel_availability') return await searchHotels({ ...params, checkHotelId: params?.hotelId });
    return { success: false, error: `Unknown hotel action: ${action}` };
  } catch (err) {
    const msg = err?.response?.data?.errors?.[0]?.detail || err.message || 'Hotel search failed';
    return { success: false, error: msg };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };

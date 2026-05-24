const axios = require('axios');

function normalizeLocation(location) {
  const latitude = Number(location?.latitude ?? location?.lat);
  const longitude = Number(location?.longitude ?? location?.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function looksLikeNearbyPlaceQuery(query) {
  const text = String(query || '').toLowerCase();
  return /\b(nearest|closest|near me|nearby|around me)\b/.test(text) ||
    /\b(gym|restaurant|cafe|coffee|shop|supermarket|store|pharmacy|station|hospital|hotel|school|college|cinema|bank|atm)\b/.test(text);
}

async function geocodeWithGoogle(locationString) {
  const response = await axios.get(
    'https://maps.googleapis.com/maps/api/geocode/json',
    {
      params: { address: locationString, region: 'uk', key: process.env.GOOGLE_MAPS_API_KEY },
      timeout: 10000
    }
  );
  if (response.data.status !== 'OK') {
    throw new Error(`Geocoding failed: ${response.data.status}`);
  }
  const result = response.data.results[0];
  return {
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    formattedAddress: result.formatted_address
  };
}

async function geocodeWithNominatim(locationString) {
  const response = await axios.get('https://nominatim.openstreetmap.org/search', {
    params: { q: locationString, format: 'json', limit: 1, countrycodes: 'gb' },
    headers: { 'User-Agent': 'Oxy-Assistant/1.0' },
    timeout: 10000
  });
  if (!response.data?.length) {
    throw new Error(`No results found for "${locationString}"`);
  }
  const result = response.data[0];
  return {
    lat: parseFloat(result.lat),
    lng: parseFloat(result.lon),
    formattedAddress: result.display_name
  };
}

async function searchPlaceWithGoogle(query, location = null) {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    throw new Error('Google Places is not configured');
  }

  const body = {
    textQuery: query,
    maxResultCount: 3,
    regionCode: 'GB',
    languageCode: 'en-GB'
  };

  const normalizedLocation = normalizeLocation(location);
  if (normalizedLocation) {
    body.locationBias = {
      circle: {
        center: {
          latitude: normalizedLocation.latitude,
          longitude: normalizedLocation.longitude
        },
        radius: 15000
      }
    };
  }

  const response = await axios.post(
    'https://places.googleapis.com/v1/places:searchText',
    body,
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.businessStatus,places.googleMapsUri'
      },
      timeout: 10000
    }
  );

  const places = response.data?.places || [];
  const openPlaces = places.filter(place => place.businessStatus !== 'CLOSED_PERMANENTLY');
  const place = openPlaces[0] || places[0];
  if (!place?.location) {
    throw new Error(`No place results found for "${query}"`);
  }

  return {
    lat: place.location.latitude,
    lng: place.location.longitude,
    formattedAddress: place.formattedAddress || place.displayName?.text || query,
    name: place.displayName?.text || '',
    googleMapsUri: place.googleMapsUri || null,
    source: 'google_places'
  };
}

const geocodeLocation = async (locationString) => {
  try {
    if (process.env.GOOGLE_MAPS_API_KEY) {
      return await geocodeWithGoogle(locationString);
    }
  } catch (err) {
    // Fall through to Nominatim if Google fails or key is invalid
    if (!err.message.includes('REQUEST_DENIED') && !err.message.includes('INVALID_REQUEST')) {
      throw new Error(`Geocoding error: ${err.message}`);
    }
    console.warn('[geocoding] Google Maps failed, falling back to Nominatim:', err.message);
  }

  try {
    return await geocodeWithNominatim(locationString);
  } catch (err) {
    throw new Error(`Geocoding error: ${err.message}`);
  }
};

async function resolvePlaceDestination(destination, options = {}) {
  const query = String(destination || '').trim();
  if (!query) throw new Error('Destination is required');

  const location = normalizeLocation(options.location);
  if (looksLikeNearbyPlaceQuery(query)) {
    if (!location && /\b(nearest|closest|near me|nearby|around me)\b/i.test(query)) {
      throw new Error(`I need your current location to find "${query}".`);
    }
    try {
      return await searchPlaceWithGoogle(query, location);
    } catch (err) {
      if (/\b(nearest|closest|near me|nearby|around me)\b/i.test(query)) {
        throw new Error(`I couldn't find a nearby match for "${query}". Send the exact branch or address.`);
      }
      console.warn('[places] Google Places failed, falling back to geocoding:', err.message);
    }
  }

  return geocodeLocation(query);
}

module.exports = { geocodeLocation, resolvePlaceDestination, looksLikeNearbyPlaceQuery };

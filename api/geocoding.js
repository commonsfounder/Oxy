const axios = require('axios');
const { getGooglePlacesKey } = require('./services/maps-config');

function normalizeLocation(location) {
  const latitude = Number(location?.latitude ?? location?.lat);
  const longitude = Number(location?.longitude ?? location?.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function looksLikeNearbyPlaceQuery(query) {
  const text = String(query || '').toLowerCase();
  return /\b(nearest|closest|near me|nearby|around me)\b/.test(text) ||
    /\b(gym|restaurant|cafe|coffee|shop|supermarket|store|pharmacy|station|hospital|hotel|school|college|cinema|bank|atm|mcdonald'?s|john lewis|the gym group)\b/.test(text);
}

function isExplicitNearbyQuery(query) {
  return /\b(nearest|closest|near me|nearby|around me|to me|from me)\b/i.test(String(query || ''));
}

function cleanPlaceSearchQuery(query) {
  let cleaned = String(query || '')
    .replace(/^(okay|ok|right|cool|great|can you|could you|please|pls)\s+/i, ' ')
    .replace(/^(tell me|show me|let me know|can you find)\s+(where\s+)?/i, ' ')
    .replace(/^(can you\s+)?(tell|show)\s+me\s+(where\s+)?/i, ' ')
    .replace(/^where['’]?s\s+(the\s+)?/i, ' ')
    .replace(/^where\s+(is|are)\s+/i, ' ')
    .replace(/^(what|which)\s+(is\s+)?/i, ' ')
    .replace(/^i\s+need\s+to\s+be\s+at\s+/i, ' ')
    .replace(/^i\s+need\s+to\s+get\s+to\s+/i, ' ')
    .replace(/\b(this|that)\s+(?=\w)/gi, ' ')
    .replace(/\b(get|take|send|book|open)\s+(me\s+)?(an?\s+)?(uber|ride|car|taxi)\s+(to|for)\b/gi, ' ')
    .replace(/\b(get|take|send)\s+me\s+to\b/gi, ' ')
    .replace(/\bnext\s+(nearest|closest)\b/gi, '$1')
    .replace(/\b(the\s+)?nearest\b/gi, ' ')
    .replace(/\b(the\s+)?closest\b/gi, ' ')
    .replace(/\bnear\s+me\b/gi, ' ')
    .replace(/\bnearby\b/gi, ' ')
    .replace(/\baround\s+me\b/gi, ' ')
    .replace(/\b(to|from)\s+me\b/gi, ' ')
    .replace(/\bmy\s+location\b/gi, ' ')
    .replace(/\bcurrent\s+location\b/gi, ' ')
    .replace(/\s+by\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\s+.*$/i, ' ')
    .replace(/\s+what\s+(bus|buses|public transport|transit)\s+.*$/i, ' ')
    .replace(/\b(is|are)\??$/i, ' ')
    .replace(/\bplease\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || String(query || '').trim();
}

function distanceMeters(a, b) {
  const locA = normalizeLocation(a);
  const locB = normalizeLocation(b);
  if (!locA || !locB) return Number.POSITIVE_INFINITY;
  const toRad = deg => deg * Math.PI / 180;
  const r = 6371000;
  const dLat = toRad(locB.latitude - locA.latitude);
  const dLng = toRad(locB.longitude - locA.longitude);
  const lat1 = toRad(locA.latitude);
  const lat2 = toRad(locB.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

function googlePlaceFieldMask() {
  return 'places.displayName,places.formattedAddress,places.location,places.businessStatus,places.googleMapsUri,places.types,places.currentOpeningHours.openNow';
}

function googlePlaceHeaders(key) {
  return {
    'Content-Type': 'application/json',
    'X-Goog-Api-Key': key,
    'X-Goog-FieldMask': googlePlaceFieldMask()
  };
}

function nearbyTypesForQuery(query) {
  const text = cleanPlaceSearchQuery(query).toLowerCase();
  if (/\b(mcdonald|kfc|burger king|restaurant|food|eat|dinner|lunch)\b/.test(text)) return ['restaurant'];
  if (/\b(coffee|cafe|starbucks|costa|nero)\b/.test(text)) return ['cafe'];
  if (/\b(gym|fitness|the gym group)\b/.test(text)) return ['gym'];
  if (/\b(pharmacy|chemist|boots)\b/.test(text)) return ['pharmacy'];
  if (/\b(supermarket|grocery|tesco|sainsbury|aldi|lidl|asda)\b/.test(text)) return ['supermarket'];
  if (/\b(john lewis|selfridges|department store)\b/.test(text)) return ['department_store'];
  if (/\b(shop|store)\b/.test(text)) return ['store'];
  if (/\b(bank)\b/.test(text)) return ['bank'];
  if (/\b(atm|cash machine)\b/.test(text)) return ['atm'];
  if (/\b(hospital|a&e|clinic)\b/.test(text)) return ['hospital'];
  if (/\b(hotel)\b/.test(text)) return ['hotel'];
  if (/\b(cinema|movie)\b/.test(text)) return ['movie_theater'];
  if (/\b(train station|station)\b/.test(text)) return ['train_station'];
  return [];
}

function meaningfulPlaceTokens(query) {
  return cleanPlaceSearchQuery(query)
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter(token => ![
      'the', 'a', 'an', 'place', 'shop', 'store', 'restaurant', 'cafe', 'coffee',
      'gym', 'station', 'near', 'nearest', 'closest', 'to', 'me', 'from', 'is',
      'that', 'this', 'where', 's'
    ].includes(token));
}

function placeMatchesQuery(place, query) {
  const tokens = meaningfulPlaceTokens(query);
  if (!tokens.length) return true;
  const haystack = [
    place.displayName?.text,
    place.formattedAddress,
    ...(place.types || [])
  ].filter(Boolean).join(' ').toLowerCase().replace(/['’]/g, '');
  return tokens.every(token => haystack.includes(token));
}

function rankedGooglePlaceCandidates(places, location, query = '') {
  const normalizedLocation = normalizeLocation(location);
  const openPlaces = places.filter(place =>
    place.businessStatus !== 'CLOSED_PERMANENTLY' &&
    place.currentOpeningHours?.openNow !== false
  );
  const candidates = (openPlaces.length ? openPlaces : places)
    .filter(place => place?.location)
    .map(place => ({
      ...place,
      queryMatch: placeMatchesQuery(place, query),
      distanceMeters: normalizedLocation
        ? distanceMeters(normalizedLocation, { latitude: place.location.latitude, longitude: place.location.longitude })
        : Number.POSITIVE_INFINITY
    }))
    .sort((a, b) => {
      if (a.queryMatch !== b.queryMatch) return a.queryMatch ? -1 : 1;
      return a.distanceMeters - b.distanceMeters;
    });
  const matched = candidates.filter(place => place.queryMatch);
  return matched.length ? matched : candidates;
}

function googlePlaceResult(place, query) {
  if (!place?.location) {
    throw new Error(`No place results found for "${query}"`);
  }
  return {
    lat: place.location.latitude,
    lng: place.location.longitude,
    formattedAddress: place.formattedAddress || place.displayName?.text || query,
    name: place.displayName?.text || '',
    googleMapsUri: place.googleMapsUri || null,
    distanceMeters: Number.isFinite(place.distanceMeters) ? Math.round(place.distanceMeters) : null,
    source: 'google_places'
  };
}

async function searchNearbyPlacesWithGoogle(query, location, key) {
  const normalizedLocation = normalizeLocation(location);
  if (!normalizedLocation) return null;
  const includedTypes = nearbyTypesForQuery(query);
  if (!includedTypes.length) return null;

  const response = await axios.post(
    'https://places.googleapis.com/v1/places:searchNearby',
    {
      includedTypes,
      maxResultCount: 20,
      rankPreference: 'DISTANCE',
      regionCode: 'GB',
      languageCode: 'en-GB',
      locationRestriction: {
        circle: {
          center: {
            latitude: normalizedLocation.latitude,
            longitude: normalizedLocation.longitude
          },
          radius: 15000
        }
      }
    },
    {
      headers: googlePlaceHeaders(key),
      timeout: 10000
    }
  );

  const candidates = rankedGooglePlaceCandidates(response.data?.places || [], normalizedLocation, query);
  return candidates[0] ? googlePlaceResult(candidates[0], query) : null;
}

async function geocodeWithGoogle(locationString) {
  const key = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
  const response = await axios.get(
    'https://maps.googleapis.com/maps/api/geocode/json',
    {
      params: { address: locationString, region: 'uk', key },
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
    params: { q: locationString, format: 'json', limit: 1 },
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

function isPermanentGoogleGeocodingConfigError(err) {
  const message = String(err?.response?.data?.error_message || err?.message || '');
  return /REQUEST_DENIED|API_KEY_INVALID|PERMISSION_DENIED|has not been used|not been enabled|billing/i.test(message);
}

async function searchPlaceWithGoogle(query, location = null) {
  const key = getGooglePlacesKey();
  if (!key) {
    const err = new Error('Google Places is not configured. Set GOOGLE_PLACES_API_KEY or GOOGLE_MAPS_API_KEY and enable Places API (New).');
    err.code = 'PLACES_NOT_CONFIGURED';
    throw err;
  }

  const normalizedLocation = normalizeLocation(location);
  if (normalizedLocation && isExplicitNearbyQuery(query)) {
    const nearby = await searchNearbyPlacesWithGoogle(query, normalizedLocation, key);
    if (nearby) return nearby;
  }

  const body = {
    textQuery: cleanPlaceSearchQuery(query),
    pageSize: 8,
    regionCode: 'GB',
    languageCode: 'en-GB'
  };

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
      headers: googlePlaceHeaders(key),
      timeout: 10000
    }
  );

  const candidates = rankedGooglePlaceCandidates(response.data?.places || [], normalizedLocation, query);
  const place = candidates[0];
  return googlePlaceResult(place, query);
}

const geocodeLocation = async (locationString) => {
  try {
    if (process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY) {
      return await geocodeWithGoogle(locationString);
    }
  } catch (err) {
    if (isPermanentGoogleGeocodingConfigError(err)) {
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
    if (!location && isExplicitNearbyQuery(query)) {
      throw new Error(`I need your current location to find a nearby ${cleanPlaceSearchQuery(query)}.`);
    }
    try {
      return await searchPlaceWithGoogle(query, location);
    } catch (err) {
      if (err.code === 'PLACES_NOT_CONFIGURED') {
        throw err;
      }
      if (/Places API has not been used|API has not been enabled|API_KEY_INVALID|REQUEST_DENIED|PERMISSION_DENIED|billing/i.test(err.response?.data?.error?.message || err.message)) {
        throw new Error('Google Places key is being rejected by the server. Check the Cloud Run API key, billing, and Places API (New) access.');
      }
      if (isExplicitNearbyQuery(query)) {
        throw new Error(`I couldn't find a nearby ${cleanPlaceSearchQuery(query)} from your current location. Try a different place name or enable location.`);
      }
      console.warn('[places] Google Places failed, falling back to geocoding:', err.message);
    }
  }

  return geocodeLocation(query);
}

module.exports = { geocodeLocation, resolvePlaceDestination, looksLikeNearbyPlaceQuery, cleanPlaceSearchQuery, distanceMeters };

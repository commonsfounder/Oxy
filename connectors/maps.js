const axios = require('axios');
const { resolvePlaceDestination, cleanPlaceSearchQuery } = require('../api/geocoding');
const { getGoogleDirectionsKey } = require('../api/services/maps-config');

const SUPPORTED_ACTIONS = ['find_place', 'get_directions'];

function shortAddress(address) {
  return String(address || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(', ');
}

function distanceLabel(meters) {
  const value = Number(meters);
  if (!Number.isFinite(value)) return '';
  if (value < 1000) return `${Math.round(value)} m away`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} km away`;
}

function placeLabel(place, fallback) {
  const name = place?.name || cleanPlaceSearchQuery(fallback);
  const area = shortAddress(place?.formattedAddress || '');
  if (name && area && !area.toLowerCase().startsWith(name.toLowerCase())) {
    return `${name}, ${area}`;
  }
  return name || area || fallback;
}

function mapsLink(place, query) {
  if (place?.googleMapsUri) return place.googleMapsUri;
  const lat = Number(place?.lat);
  const lng = Number(place?.lng);
  const label = encodeURIComponent(place?.name || cleanPlaceSearchQuery(query) || 'Place');
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return `https://maps.apple.com/?ll=${lat},${lng}&q=${label}`;
  }
  return `https://maps.apple.com/?q=${encodeURIComponent(query)}`;
}

function mapsSearchFallback(query, err = null) {
  const cleanedQuery = cleanPlaceSearchQuery(query);
  const link = `https://maps.apple.com/?q=${encodeURIComponent(cleanedQuery)}`;
  const reason = String(err?.message || err || '');
  const setupText = /not configured|GOOGLE_PLACES_API_KEY|GOOGLE_MAPS_API_KEY/i.test(reason)
    ? 'Exact nearest-place ranking needs a Google Places API key on the server.'
    : 'Exact nearest-place ranking needs the server Places key to be accepted.';
  return {
    success: true,
    text: `I can open Maps for ${cleanedQuery}. ${setupText}`,
    actionSummary: 'Maps search ready',
    cardText: 'Open search in Maps',
    deepLink: link,
    webLink: link
  };
}

function directionModeFlag(mode) {
  const normalized = String(mode || '').toLowerCase();
  if (/walk|walking/.test(normalized)) return 'w';
  if (/bus|transit|public|train|tube|tram/.test(normalized)) return 'r';
  return 'd';
}

function mapsDirectionsFallback(destination, params = {}) {
  const cleanedDestination = cleanPlaceSearchQuery(destination);
  const flag = directionModeFlag(params.mode);
  const link = `https://maps.apple.com/?daddr=${encodeURIComponent(cleanedDestination)}&dirflg=${flag}`;
  const modeLabel = flag === 'r' ? 'transit' : flag === 'w' ? 'walking' : 'driving';
  return {
    success: true,
    text: `Opening ${modeLabel} directions to ${cleanedDestination}.`,
    actionSummary: 'Directions ready',
    cardText: `Open ${modeLabel} directions in Maps`,
    deepLink: link,
    webLink: link
  };
}

function parseArrivalTime(value, now = new Date()) {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = match[3]?.toLowerCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  const arrival = new Date(now);
  arrival.setHours(hour, minute, 0, 0);
  if (arrival.getTime() < now.getTime()) arrival.setDate(arrival.getDate() + 1);
  return Math.floor(arrival.getTime() / 1000);
}

function formatTransitStep(step) {
  const transit = step.transit_details;
  if (!transit) return null;
  const line = transit.line?.short_name || transit.line?.name || transit.line?.vehicle?.name || 'transit';
  const from = transit.departure_stop?.name;
  const to = transit.arrival_stop?.name;
  return [line, from && `from ${from}`, to && `to ${to}`].filter(Boolean).join(' ');
}

function summarizeDirectionsRoute(route, modeLabel) {
  const leg = route?.legs?.[0];
  if (!leg) return null;
  const duration = leg.duration?.text;
  const arrival = leg.arrival_time?.text;
  const departure = leg.departure_time?.text;
  const transitSteps = (leg.steps || []).map(formatTransitStep).filter(Boolean).slice(0, 3);
  const headline = [
    duration && `${duration}`,
    departure && arrival && `${departure}-${arrival}`,
    !departure && arrival && `arrive ${arrival}`
  ].filter(Boolean).join(' · ');
  const detail = transitSteps.length
    ? transitSteps.join(' · ')
    : `Open ${modeLabel} directions in Maps`;
  return { headline, detail };
}

async function getGoogleDirections(destination, place, params = {}) {
  const key = getGoogleDirectionsKey();
  const location = params.location;
  const lat = Number(location?.latitude ?? location?.lat);
  const lng = Number(location?.longitude ?? location?.lng);
  if (!key || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const mode = directionModeFlag(params.mode) === 'r'
    ? 'transit'
    : directionModeFlag(params.mode) === 'w'
      ? 'walking'
      : 'driving';
  const requestParams = {
    origin: `${lat},${lng}`,
    destination: place?.formattedAddress || cleanPlaceSearchQuery(destination),
    mode,
    alternatives: true,
    key
  };
  const arrival = parseArrivalTime(params.arrival_time);
  if (arrival && mode === 'transit') requestParams.arrival_time = arrival;

  const response = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
    params: requestParams,
    timeout: 10000
  });
  if (response.data?.status !== 'OK' || !response.data.routes?.length) return null;
  return summarizeDirectionsRoute(response.data.routes[0], mode);
}

function isPlacesSetupError(err) {
  return /Google Places|Places API|GOOGLE_MAPS_API_KEY|PERMISSION_DENIED|REQUEST_DENIED/i.test(String(err?.message || err || ''));
}

async function execute(userId, action, params) {
  try {
    if (action === 'get_directions') {
      const destination = String(params?.destination || params?.query || '').trim();
      if (!destination) return { success: false, error: 'get_directions requires a destination' };
      let place = null;
      try {
        place = await resolvePlaceDestination(destination, { location: params.location });
      } catch (err) {
        if (isPlacesSetupError(err)) return mapsDirectionsFallback(destination, params);
        return mapsDirectionsFallback(destination, params);
      }
      const flag = directionModeFlag(params.mode);
      const modeLabel = flag === 'r' ? 'transit' : flag === 'w' ? 'walking' : 'driving';
      const route = await getGoogleDirections(destination, place, params).catch(err => {
        console.warn('[maps] Google Directions failed:', err.message);
        return null;
      });
      const link = place?.googleMapsUri
        ? `https://maps.apple.com/?daddr=${encodeURIComponent(place.formattedAddress || destination)}&dirflg=${flag}`
        : `https://maps.apple.com/?daddr=${encodeURIComponent(destination)}&dirflg=${flag}`;
      const label = placeLabel(place, destination);
      const routeText = route?.headline ? `${route.headline}: ${route.detail}` : `Opening ${modeLabel} directions to ${label}.`;
      return {
        success: true,
        text: routeText,
        deepLink: link,
        webLink: link,
        actionSummary: 'Directions ready',
        cardText: route?.detail || `Open ${modeLabel} directions in Maps`
      };
    }

    if (action !== 'find_place') return { success: false, error: `Unknown action: ${action}` };

    const query = String(params?.query || params?.destination || '').trim();
    if (!query) return { success: false, error: 'find_place requires a query' };

    let place;
    try {
      place = await resolvePlaceDestination(query, { location: params.location });
    } catch (err) {
      if (isPlacesSetupError(err)) return mapsSearchFallback(query, err);
      throw err;
    }
    const label = placeLabel(place, query);
    const distance = distanceLabel(place.distanceMeters);
    const address = shortAddress(place.formattedAddress || '');
    const detail = [address, distance].filter(Boolean).join(' · ');

    return {
      success: true,
      text: `I found ${label}${distance ? `, ${distance}` : ''}.`,
      name: place.name || '',
      address: place.formattedAddress || '',
      distanceMeters: place.distanceMeters ?? null,
      deepLink: mapsLink(place, query),
      webLink: mapsLink(place, query),
      cardText: detail || 'Open in Maps'
    };
  } catch (err) {
    return { success: false, error: `Maps error: ${err.message}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };

const { resolvePlaceDestination, cleanPlaceSearchQuery } = require('../api/geocoding');

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
      const link = place?.googleMapsUri
        ? `https://maps.apple.com/?daddr=${encodeURIComponent(place.formattedAddress || destination)}&dirflg=${flag}`
        : `https://maps.apple.com/?daddr=${encodeURIComponent(destination)}&dirflg=${flag}`;
      return {
        success: true,
        text: `Opening ${modeLabel} directions to ${placeLabel(place, destination)}.`,
        deepLink: link,
        webLink: link,
        actionSummary: 'Directions ready',
        cardText: `Open ${modeLabel} directions in Maps`
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

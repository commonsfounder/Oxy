const { resolvePlaceDestination, cleanPlaceSearchQuery } = require('../api/geocoding');

const SUPPORTED_ACTIONS = ['find_place'];

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

function mapsSearchFallback(query) {
  const link = `https://maps.apple.com/?q=${encodeURIComponent(query)}`;
  return {
    success: true,
    text: `I can open a Maps search for ${query}. Exact nearby ranking needs Places search enabled on the server.`,
    cardText: 'Open search in Maps',
    deepLink: link,
    webLink: link
  };
}

function isPlacesSetupError(err) {
  return /Google Places|Places API|GOOGLE_MAPS_API_KEY|PERMISSION_DENIED|REQUEST_DENIED/i.test(String(err?.message || err || ''));
}

async function execute(userId, action, params) {
  try {
    if (action !== 'find_place') return { success: false, error: `Unknown action: ${action}` };

    const query = String(params?.query || params?.destination || '').trim();
    if (!query) return { success: false, error: 'find_place requires a query' };

    let place;
    try {
      place = await resolvePlaceDestination(query, { location: params.location });
    } catch (err) {
      if (isPlacesSetupError(err)) return mapsSearchFallback(query);
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

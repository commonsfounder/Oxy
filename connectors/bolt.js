const { estimateUberFare } = require('./uber');
const { geocodeLocation, resolvePlaceDestination } = require('../api/geocoding');

const SUPPORTED_ACTIONS = ['book_bolt'];

// ponytail: Bolt pricing ~15% under Uber on equivalent routes (London/EU baseline)
const BOLT_DISCOUNT = 0.85;

const CURRENT_LOCATION_PHRASES = [
  'current location', 'current address', 'my location', 'here', 'where i am',
  "where i'm at", 'my current location', 'my address', 'my place', 'home'
];

function isCurrentLocation(str) {
  return CURRENT_LOCATION_PHRASES.some(p => str.trim().toLowerCase() === p);
}

function shortAddress(address) {
  return String(address || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(', ');
}

function destinationLabel(place) {
  const name = place?.name || '';
  const area = shortAddress(place?.formattedAddress || '');
  if (name && area && !area.toLowerCase().startsWith(name.toLowerCase())) {
    return `${name}, ${area}`;
  }
  return name || area || 'that destination';
}

function isPlacesSetupError(err) {
  return /Google Places|Places API|GOOGLE_MAPS_API_KEY|PERMISSION_DENIED|REQUEST_DENIED/i.test(String(err?.message || err || ''));
}

function fallbackBoltLink(destination) {
  return {
    success: true,
    text: `Opening Bolt to search for ${destination}. Pick the exact destination in Bolt.`,
    actionSummary: 'Bolt search ready',
    cardText: 'Confirm destination in Bolt',
    deepLink: 'bolt://',
    webLink: 'https://bolt.eu'
  };
}

async function execute(userId, action, params) {
  try {
    switch (action) {
      case 'book_bolt': {
        const { pickup, destination } = params;
        if (!destination) {
          return { success: false, error: 'book_bolt requires a destination' };
        }

        let destCoords;
        try {
          destCoords = await resolvePlaceDestination(destination, { location: params.location });
        } catch (err) {
          if (isPlacesSetupError(err)) return fallbackBoltLink(destination);
          throw err;
        }

        let fromLabel;
        let originCoords = null;
        if (!pickup || isCurrentLocation(pickup)) {
          fromLabel = 'your location';
          const lat = Number(params.location?.lat ?? params.location?.latitude);
          const lng = Number(params.location?.lng ?? params.location?.longitude);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            originCoords = { lat, lng };
          }
        } else {
          const pickupCoords = await geocodeLocation(pickup);
          fromLabel = pickupCoords.formattedAddress;
          originCoords = { lat: pickupCoords.lat, lng: pickupCoords.lng };
        }

        let cardText = destinationLabel(destCoords);
        if (originCoords) {
          try {
            const est = await estimateUberFare(originCoords.lat, originCoords.lng, destCoords.lat, destCoords.lng);
            const boltFare = Math.round(est.estimatedFare * BOLT_DISCOUNT * 100) / 100;
            cardText = `${destinationLabel(destCoords)} · ${est.minutes} min · £${boltFare.toFixed(2)}`;
          } catch {
            // Non-fatal: leave cardText as just the destination.
          }
        }

        return {
          success: true,
          text: `Opening Bolt to ${destinationLabel(destCoords)}. Confirm in Bolt.`,
          cardText,
          deepLink: 'bolt://',
          webLink: 'https://bolt.eu'
        };
      }

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: `Bolt error: ${err.message}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };

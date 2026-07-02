const axios = require('axios');
const { geocodeLocation, resolvePlaceDestination } = require('../api/geocoding');

const SUPPORTED_ACTIONS = ['book_uber'];

const METERS_PER_MILE = 1609.344;
const ROUTES_ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';

/**
 * Estimate an Uber fare between two coordinate pairs using the Google Routes API.
 *
 * Pricing model (GBP): 2.50 base + 1.05/mile + 0.15/minute, floored at 5.00.
 *
 * @returns {Promise<{ estimatedFare: number, miles: number, minutes: number, surgeDisclaimer: string }>}
 * @throws {Error} when the API key is missing, the request fails, or no route is found.
 */
async function estimateUberFare(originLat, originLng, destLat, destLng) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error('estimateUberFare: GOOGLE_MAPS_API_KEY is not set');
  }

  let route;
  try {
    const response = await axios.post(
      ROUTES_ENDPOINT,
      {
        origin: { location: { latLng: { latitude: originLat, longitude: originLng } } },
        destination: { location: { latLng: { latitude: destLat, longitude: destLng } } },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE'
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          // Only request the two fields we need.
          'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration'
        },
        timeout: 8000
      }
    );
    route = response.data?.routes?.[0];
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    throw new Error(`estimateUberFare: Routes API request failed — ${detail}`);
  }

  if (!route || typeof route.distanceMeters !== 'number' || !route.duration) {
    throw new Error('estimateUberFare: no route found between the given coordinates');
  }

  const miles = route.distanceMeters / METERS_PER_MILE;
  // Routes API returns duration as a string like "1234s".
  const minutes = (parseInt(route.duration, 10) || 0) / 60;

  const rawFare = 2.50 + (1.05 * miles) + (0.15 * minutes);
  const fare = Math.max(rawFare, 5.00);

  const round2 = (n) => Math.round(n * 100) / 100;

  return {
    estimatedFare: round2(fare),
    miles: round2(miles),
    minutes: Math.round(minutes),
    surgeDisclaimer: 'Estimate only — fares may vary during peak hours and surge pricing.'
  };
}

const CURRENT_LOCATION_PHRASES = [
  'current location', 'current address', 'my location', 'here', 'where i am',
  'where i\'m at', 'my current location', 'my address', 'my place', 'home'
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

function fallbackUberLink(destination) {
  const enc = encodeURIComponent;
  const query = [
    'action=setPickup',
    'pickup=my_location',
    `dropoff[formatted_address]=${enc(destination)}`
  ].join('&');
  return {
    success: true,
    text: `Opening Uber to search for ${destination}. Pick the exact destination in Uber.`,
    actionSummary: 'Uber search ready',
    cardText: 'Confirm destination in Uber',
    deepLink: `uber://?${query}`,
    webLink: `https://m.uber.com/ul/?${query}`
  };
}

async function execute(userId, action, params) {
  try {
    switch (action) {
      case 'book_uber': {
        const { pickup, destination } = params;
        if (!destination) {
          return { success: false, error: 'book_uber requires a destination' };
        }

        const enc = encodeURIComponent;
        let destCoords;
        try {
          destCoords = await resolvePlaceDestination(destination, { location: params.location });
        } catch (err) {
          if (isPlacesSetupError(err)) return fallbackUberLink(destination);
          throw err;
        }

        // URLSearchParams percent-encodes brackets, breaking Uber's deep link format.
        // Build the query string manually so pickup[latitude] etc. stay literal.
        let queryParts = [
          'action=setPickup',
          `dropoff[latitude]=${destCoords.lat}`,
          `dropoff[longitude]=${destCoords.lng}`,
          `dropoff[formatted_address]=${enc(destCoords.formattedAddress)}`
        ];

        let fromLabel;
        let originCoords = null;
        if (!pickup || isCurrentLocation(pickup)) {
          // Let Uber use device GPS for pickup
          queryParts.splice(1, 0, 'pickup=my_location');
          fromLabel = 'your location';
          // Fall back to the device's current location (if known) for the estimate.
          const lat = Number(params.location?.lat ?? params.location?.latitude);
          const lng = Number(params.location?.lng ?? params.location?.longitude);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            originCoords = { lat, lng };
          }
        } else {
          const pickupCoords = await geocodeLocation(pickup);
          queryParts.splice(1, 0,
            `pickup[latitude]=${pickupCoords.lat}`,
            `pickup[longitude]=${pickupCoords.lng}`,
            `pickup[formatted_address]=${enc(pickupCoords.formattedAddress)}`
          );
          fromLabel = pickupCoords.formattedAddress;
          originCoords = { lat: pickupCoords.lat, lng: pickupCoords.lng };
        }

        const query = queryParts.join('&');

        // Best-effort fare/ETA estimate for the handoff card. Never block the
        // booking if the estimate fails or the origin is unknown.
        let cardText = destinationLabel(destCoords);
        if (originCoords) {
          try {
            const est = await estimateUberFare(originCoords.lat, originCoords.lng, destCoords.lat, destCoords.lng);
            cardText = `${destinationLabel(destCoords)} · ${est.minutes} min · £${est.estimatedFare.toFixed(2)}`;
          } catch (estErr) {
            // Non-fatal: leave cardText as just the destination.
          }
        }

        return {
          success: true,
          text: `Opening Uber to ${destinationLabel(destCoords)}. Confirm in Uber.`,
          cardText,
          deepLink: `uber://?${query}`,
          webLink: `https://m.uber.com/ul/?${query}`
        };
      }

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: `Uber error: ${err.message}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute, estimateUberFare };

const { geocodeLocation, resolvePlaceDestination } = require('../api/geocoding');

const SUPPORTED_ACTIONS = ['book_uber'];

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

async function execute(userId, action, params) {
  try {
    switch (action) {
      case 'book_uber': {
        const { pickup, destination } = params;
        if (!destination) {
          return { success: false, error: 'book_uber requires a destination' };
        }

        const enc = encodeURIComponent;
        const destCoords = await resolvePlaceDestination(destination, { location: params.location });

        // URLSearchParams percent-encodes brackets, breaking Uber's deep link format.
        // Build the query string manually so pickup[latitude] etc. stay literal.
        let queryParts = [
          'action=setPickup',
          `dropoff[latitude]=${destCoords.lat}`,
          `dropoff[longitude]=${destCoords.lng}`,
          `dropoff[formatted_address]=${enc(destCoords.formattedAddress)}`
        ];

        let fromLabel;
        if (!pickup || isCurrentLocation(pickup)) {
          // Let Uber use device GPS for pickup
          queryParts.splice(1, 0, 'pickup=my_location');
          fromLabel = 'your location';
        } else {
          const pickupCoords = await geocodeLocation(pickup);
          queryParts.splice(1, 0,
            `pickup[latitude]=${pickupCoords.lat}`,
            `pickup[longitude]=${pickupCoords.lng}`,
            `pickup[formatted_address]=${enc(pickupCoords.formattedAddress)}`
          );
          fromLabel = pickupCoords.formattedAddress;
        }

        const query = queryParts.join('&');

        return {
          success: true,
          text: `Opening Uber to ${destinationLabel(destCoords)}. Confirm in Uber.`,
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

module.exports = { SUPPORTED_ACTIONS, execute };

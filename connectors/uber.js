const { geocodeLocation } = require('../api/geocoding');

const SUPPORTED_ACTIONS = ['book_uber'];

async function execute(userId, action, params) {
  try {
    switch (action) {
      case 'book_uber': {
        const { pickup, destination } = params;
        if (!pickup || !destination) {
          return { success: false, error: 'book_uber requires pickup and destination' };
        }

        const [pickupCoords, destCoords] = await Promise.all([
          geocodeLocation(pickup),
          geocodeLocation(destination)
        ]);

        const query = new URLSearchParams({
          action: 'setPickup',
          'pickup[latitude]': pickupCoords.lat,
          'pickup[longitude]': pickupCoords.lng,
          'pickup[formatted_address]': pickupCoords.formattedAddress,
          'dropoff[latitude]': destCoords.lat,
          'dropoff[longitude]': destCoords.lng,
          'dropoff[formatted_address]': destCoords.formattedAddress
        }).toString();

        return {
          success: true,
          text: `Opening Uber from ${pickupCoords.formattedAddress} to ${destCoords.formattedAddress} — confirm in the app`,
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

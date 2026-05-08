const axios = require('axios');

const geocodeLocation = async (locationString) => {
  try {
    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/geocode/json',
      {
        params: {
          address: locationString,
          region: 'uk',
          key: process.env.GOOGLE_MAPS_API_KEY
        }
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

  } catch (error) {
    throw new Error(`Geocoding error: ${error.message}`);
  }
};

module.exports = { geocodeLocation };

const axios = require('axios');

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

module.exports = { geocodeLocation };

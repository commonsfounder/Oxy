function getGooglePlacesKey(env = process.env) {
  return env.GOOGLE_PLACES_API_KEY || env.GOOGLE_MAPS_API_KEY || '';
}

module.exports = { getGooglePlacesKey };

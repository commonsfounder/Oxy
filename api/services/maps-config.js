function getGooglePlacesKey(env = process.env) {
  return env.GOOGLE_PLACES_API_KEY || env.GOOGLE_MAPS_API_KEY || '';
}

function getGoogleDirectionsKey(env = process.env) {
  return env.GOOGLE_DIRECTIONS_API_KEY || env.GOOGLE_ROUTES_API_KEY || env.GOOGLE_MAPS_API_KEY || env.GOOGLE_PLACES_API_KEY || '';
}

module.exports = { getGooglePlacesKey, getGoogleDirectionsKey };

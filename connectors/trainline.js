const { getGoogleDirectionsKey } = require('../api/services/maps-config');

async function execute(userId, action, params) {
  try {
    if (action !== 'search_trains') return { success: false, error: `Unknown action: ${action}` };

    const { origin, destination } = params;
    if (!origin || !destination) return { success: false, error: 'search_trains requires origin and destination' };

    if (!getGoogleDirectionsKey()) {
      return {
        success: false,
        outcome: 'unavailable',
        unavailable: true,
        text: `I couldn't get a train route summary from ${origin} to ${destination} because route data is not configured on the server.`,
        cardText: 'No train route summary available',
        actionSummary: 'Route unavailable',
        trains: [],
        transportApiDisabled: true,
        routeContext: {
          origin,
          destination,
          mode: 'rail',
          reason: 'google_directions_key_missing'
        }
      };
    }

    const maps = require('./maps');
    const planned = await maps.execute(userId, 'plan_trip', {
      ...params,
      origin,
      destination,
      preference: params?.preference || 'fastest'
    });
    return {
      ...planned,
      actionSummary: planned?.actionSummary === 'Route unavailable' ? 'Route unavailable' : 'Train route checked',
      cardText: planned?.cardText || 'Train route checked',
      trains: [],
      transportApiDisabled: true
    };
  } catch (err) {
    return { success: false, error: `Trainline error: ${err.message}` };
  }
}

module.exports = { execute };

const SUPPORTED_ACTIONS = ['order_uber_eats'];

function buildSearchQuery(params = {}) {
  return [
    params.query,
    params.restaurant,
    params.item,
    params.cuisine
  ].filter(Boolean).join(' ').trim();
}

async function execute(userId, action, params) {
  try {
    if (action !== 'order_uber_eats') {
      return { success: false, error: `Unknown action: ${action}` };
    }

    const query = buildSearchQuery(params);
    if (!query) {
      return { success: false, error: 'order_uber_eats requires a restaurant, item, cuisine, or query' };
    }

    const webLink = `https://www.ubereats.com/search?q=${encodeURIComponent(query)}`;

    return {
      success: true,
      text: `Opening Uber Eats for ${query} — confirm the order in the app.`,
      deepLink: webLink,
      webLink
    };
  } catch (err) {
    return { success: false, error: `Uber Eats error: ${err.message}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };

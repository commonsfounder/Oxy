const SUPPORTED_ACTIONS = ['order_uber_eats'];

function buildSearchQuery(params = {}) {
  return [
    params.query,
    params.restaurant,
    params.item,
    params.cuisine
  ].filter(Boolean).join(' ').trim();
}

function uberEatsWebLink(query) {
  return `https://www.ubereats.com/search?q=${encodeURIComponent(query)}`;
}

function uberEatsDeepLink(query) {
  return `ubereats://search?q=${encodeURIComponent(query)}`;
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

    return {
      success: true,
      text: `Trying Uber Eats for ${query}.`,
      deepLink: uberEatsDeepLink(query),
      webLink: uberEatsWebLink(query)
    };
  } catch (err) {
    return { success: false, error: `Uber Eats error: ${err.message}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };

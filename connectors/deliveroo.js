const SUPPORTED_ACTIONS = ['order_deliveroo'];

function buildSearchQuery(params = {}) {
  return [
    params.query,
    params.restaurant,
    params.item,
    params.cuisine
  ].filter(Boolean).join(' ').trim();
}

function deliverooWebLink(query) {
  return `https://deliveroo.co.uk/search?q=${encodeURIComponent(query)}`;
}

function deliverooDeepLink(query) {
  return `deliveroo://search?q=${encodeURIComponent(query)}`;
}

async function execute(userId, action, params) {
  try {
    if (action !== 'order_deliveroo') {
      return { success: false, error: `Unknown action: ${action}` };
    }

    const query = buildSearchQuery(params);
    if (!query) {
      return { success: false, error: 'order_deliveroo requires a restaurant, item, cuisine, or query' };
    }

    return {
      success: true,
      text: `Trying Deliveroo for ${query}.`,
      deepLink: deliverooDeepLink(query),
      webLink: deliverooWebLink(query)
    };
  } catch (err) {
    return { success: false, error: `Deliveroo error: ${err.message}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };

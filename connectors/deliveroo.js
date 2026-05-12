const SUPPORTED_ACTIONS = ['order_deliveroo'];

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
    if (action !== 'order_deliveroo') {
      return { success: false, error: `Unknown action: ${action}` };
    }

    const query = buildSearchQuery(params);
    if (!query) {
      return { success: false, error: 'order_deliveroo requires a restaurant, item, cuisine, or query' };
    }

    const webLink = `https://deliveroo.co.uk/search?q=${encodeURIComponent(query)}`;

    return {
      success: true,
      text: `Opening Deliveroo for ${query} — confirm the order in the app.`,
      deepLink: webLink,
      webLink
    };
  } catch (err) {
    return { success: false, error: `Deliveroo error: ${err.message}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };

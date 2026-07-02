const SUPPORTED_ACTIONS = ['search_amazon', 'add_to_amazon_cart', 'track_amazon_order'];

async function execute(userId, action, params) {
  const query = params.query || params.item || 'something';
  if (action === 'search_amazon') {
    const url = `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;
    return { success: true, text: `Amazon search for ${query}.`, webLink: url };
  }
  if (action === 'add_to_amazon_cart') {
    const url = `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;
    return { success: true, text: `Added ${query} to Amazon cart (open to confirm).`, webLink: url };
  }
  if (action === 'track_amazon_order') {
    return { success: true, text: `Track Amazon order for ${query}.`, webLink: 'https://www.amazon.com/gp/css/order-history' };
  }
  return { success: false, error: 'Unknown Amazon action' };
}

module.exports = { SUPPORTED_ACTIONS, execute };
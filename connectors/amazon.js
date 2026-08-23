async function execute(userId, action, params) {
  const query = params.query || params.item || 'something';
  if (action === 'search_amazon') {
    const url = `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;
    return { success: false, outcome: 'handoff_required', handoffRequired: true, text: `Open Amazon to search for ${query}.`, webLink: url };
  }
  if (action === 'add_to_amazon_cart') {
    const url = `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;
    return { success: false, outcome: 'handoff_required', handoffRequired: true, text: `Open Amazon to add ${query} to your cart.`, webLink: url };
  }
  if (action === 'track_amazon_order') {
    return { success: false, outcome: 'handoff_required', handoffRequired: true, text: `Open Amazon order history to track ${query}.`, webLink: 'https://www.amazon.com/gp/css/order-history' };
  }
  return { success: false, error: 'Unknown Amazon action' };
}

module.exports = { execute };

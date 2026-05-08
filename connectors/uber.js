const SUPPORTED_ACTIONS = ['book_uber'];

async function execute(userId, action, params) {
  switch (action) {
    case 'book_uber': {
      const { pickup, dropoff, product_type } = params;
      if (!dropoff) return { success: false, error: 'book_uber requires a dropoff destination' };

      const query = new URLSearchParams({ action: 'setPickup' });

      if (pickup && pickup.toLowerCase() !== 'current location') {
        query.set('pickup[nickname]', pickup);
      }

      query.set('dropoff[nickname]', dropoff);

      if (product_type) query.set('product_id', product_type);

      const deeplink = `uber://?${query.toString()}`;
      const webFallback = `https://m.uber.com/ul/?${query.toString()}`;

      return { success: true, clientAction: true, deeplink, webFallback, text: `Opening Uber to ${dropoff}` };
    }

    default:
      return { success: false, error: `Unknown Uber action: ${action}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };

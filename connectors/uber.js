const SUPPORTED_ACTIONS = ['book_uber'];

async function execute(userId, action, params) {
  switch (action) {
    case 'book_uber': {
      const { pickup, dropoff, product_type } = params;
      if (!dropoff) return { success: false, error: 'book_uber requires a dropoff destination' };

      const parts = ['action=setPickup'];

      if (pickup && pickup.toLowerCase() !== 'current location') {
        parts.push(`pickup[nickname]=${encodeURIComponent(pickup)}`);
      }

      parts.push(`dropoff[nickname]=${encodeURIComponent(dropoff)}`);

      if (product_type) parts.push(`product_id=${encodeURIComponent(product_type)}`);

      const qs = parts.join('&');
      const deeplink = `uber://?${qs}`;
      const webFallback = `https://m.uber.com/ul/?${qs}`;

      return { success: true, clientAction: true, deeplink, webFallback, text: `Opening Uber to ${dropoff}` };
    }

    default:
      return { success: false, error: `Unknown Uber action: ${action}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };

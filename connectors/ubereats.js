// Uber Eats connector.
//
// Two layers:
//  • order_uber_eats — legacy "just open the app" deep-link shortcut. No session.
//  • ubereats_*       — the real conversational ordering flow, backed by the
//                       @striderlabs/mcp-ubereats MCP server (live session,
//                       cart, and checkout). See connectors/mcp/ubereats-client.js.
//
// The ubereats_checkout action is review-gated by the action runner: on first
// emit it becomes a pending-review card and does NOT run. It only reaches this
// connector after the user approves, so checkout here places the real order
// (confirm: true). The total the user reviews comes from ubereats_view_cart.
const axios = require('axios');
const { callTool } = require('./mcp/ubereats-client');

const SUPPORTED_ACTIONS = [
  'order_uber_eats',
  'ubereats_status',
  'ubereats_set_address',
  'ubereats_search',
  'ubereats_get_restaurant',
  'ubereats_add_to_cart',
  'ubereats_view_cart',
  'ubereats_clear_cart',
  'ubereats_checkout',
  'ubereats_track_order'
];

// ── Legacy deep-link shortcut ────────────────────────────────────────────────
function buildSearchQuery(params = {}) {
  return [params.query, params.restaurant, params.item, params.cuisine]
    .filter(Boolean).join(' ').trim();
}

function executeOrderUberEats(params) {
  const query = buildSearchQuery(params);
  if (!query) {
    return { success: false, error: 'order_uber_eats requires a restaurant, item, cuisine, or query' };
  }
  const restaurantFirst = (params.restaurant || params.query || params.cuisine || params.item || '').trim();
  const hasRestaurantAndItem = Boolean(params.restaurant && (params.item || params.query));
  const appQuery = hasRestaurantAndItem ? restaurantFirst : query;
  const text = hasRestaurantAndItem
    ? `I'll open ${params.restaurant} in Uber Eats so you can jump straight into the menu and grab ${params.item || params.query}.`
    : `Trying Uber Eats for ${query}.`;
  return {
    success: true,
    text,
    deepLink: `ubereats://search?q=${encodeURIComponent(appQuery)}`,
    webLink: `https://www.ubereats.com/search?q=${encodeURIComponent(query)}`
  };
}

// ── Real MCP-backed flow ─────────────────────────────────────────────────────
async function call(userId, toolName, args, fallbackText) {
  const { text, isError } = await callTool(userId, toolName, args);
  if (isError) return { success: false, error: text || `${toolName} failed` };
  return { success: true, text: text || fallbackText || 'Done.' };
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

// Reverse-geocode the device's GPS (passed as params.location by the action
// runner) into a street address Uber Eats can use, via the same Google key the
// maps connector uses. Returns null if no coords / no key / lookup fails.
async function addressFromLocation(location) {
  const lat = Number(location?.latitude ?? location?.lat);
  const lng = Number(location?.longitude ?? location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const key = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return null;
  try {
    const res = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { latlng: `${lat},${lng}`, key },
      timeout: 8000
    });
    return res.data?.results?.[0]?.formatted_address || null;
  } catch {
    return null;
  }
}

// Uber Eats shows zero restaurants until a delivery address is set. Set it from
// the device location once per user (per process) so searching just works
// without the user typing an address. Best-effort: never blocks the search.
const addressEnsured = new Set();
async function ensureAddressFromLocation(userId, location) {
  if (addressEnsured.has(userId)) return;
  const address = await addressFromLocation(location);
  if (!address) return;
  const result = await call(userId, 'ubereats_set_address', { address });
  if (result.success) addressEnsured.add(userId);
}

async function execute(userId, action, params = {}) {
  try {
    switch (action) {
      case 'order_uber_eats':
        return executeOrderUberEats(params);

      case 'ubereats_status':
        // Returns login status; includes a login URL if not authenticated.
        return call(userId, 'ubereats_status', {}, 'Checked your Uber Eats session.');

      case 'ubereats_set_address': {
        // Use the typed address if given, else derive it from device location.
        const address = clean(params.address) || await addressFromLocation(params.location);
        if (!address) {
          return { success: false, error: 'ubereats_set_address needs an address or device location' };
        }
        const result = await call(userId, 'ubereats_set_address', { address }, `Set delivery address to ${address}.`);
        if (result.success) addressEnsured.add(userId);
        return result;
      }

      case 'ubereats_search': {
        const query = clean(params.query || params.dish || params.food);
        const cuisine = clean(params.cuisine);
        if (!query && !cuisine) {
          return { success: false, error: 'ubereats_search requires a query or cuisine' };
        }
        // Auto-set the delivery address from device location first, or Uber
        // returns nothing and the scraper stalls on an empty page.
        await ensureAddressFromLocation(userId, params.location);
        return call(userId, 'ubereats_search', { query, cuisine }, 'Here are some places.');
      }

      case 'ubereats_get_restaurant': {
        const restaurantId = clean(params.restaurantId || params.restaurant || params.id);
        if (!restaurantId) {
          return { success: false, error: 'ubereats_get_restaurant requires a restaurantId from search results' };
        }
        return call(userId, 'ubereats_get_restaurant', { restaurantId }, 'Loaded the menu.');
      }

      case 'ubereats_add_to_cart': {
        const restaurantId = clean(params.restaurantId || params.restaurant);
        const itemName = clean(params.itemName || params.item || params.dish);
        if (!restaurantId || !itemName) {
          return { success: false, error: 'ubereats_add_to_cart requires restaurantId and itemName' };
        }
        const quantity = Number(params.quantity) > 0 ? Number(params.quantity) : 1;
        const args = { restaurantId, itemName, quantity };
        const notes = clean(params.specialInstructions);
        if (notes) args.specialInstructions = notes;
        return call(userId, 'ubereats_add_to_cart', args, `Added ${quantity}× ${itemName}.`);
      }

      case 'ubereats_view_cart':
        return call(userId, 'ubereats_view_cart', {}, 'Here is your cart.');

      case 'ubereats_clear_cart':
        return call(userId, 'ubereats_clear_cart', {}, 'Cleared your cart.');

      case 'ubereats_checkout':
        // Reaches here only after review approval — place the real order.
        return call(userId, 'ubereats_checkout', { confirm: true }, 'Order placed.');

      case 'ubereats_track_order': {
        const orderId = clean(params.orderId || params.order || params.id);
        if (!orderId) return { success: false, error: 'ubereats_track_order requires an orderId' };
        return call(userId, 'ubereats_track_order', { orderId }, 'Here is your order status.');
      }

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: `Uber Eats error: ${err.message || err}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };

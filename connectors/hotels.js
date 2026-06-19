const SUPPORTED_ACTIONS = ['search_hotels', 'get_hotel_details', 'check_hotel_availability'];

function getAxios() { return require('axios'); }

const FIRECRAWL = 'https://api.firecrawl.dev/v1';

async function firecrawlSearch(query, limit = 5) {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error('FIRECRAWL_API_KEY is required.');
  const axios = getAxios();
  const resp = await axios.post(`${FIRECRAWL}/search`, { query, limit }, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    timeout: 20000
  });
  return resp.data?.data || [];
}

async function searchHotels({ destination, checkIn, checkOut, guests, maxPrice, style }) {
  if (!destination || !checkIn || !checkOut) {
    return { success: false, error: 'destination, checkIn, and checkOut are required.' };
  }
  const budget = maxPrice ? ` under £${maxPrice}` : '';
  const tier = style ? ` ${style}` : '';
  const query = `${tier} hotels in ${destination} ${checkIn} to ${checkOut} ${guests || 2} guests${budget} book GBP`;
  const results = await firecrawlSearch(query, 6);
  if (!results.length) return { success: true, data: [], text: `No hotels found in ${destination} for those dates.` };

  const data = results.map(r => ({ title: r.metadata?.title, url: r.url, snippet: r.metadata?.description }));
  const sources = data.map(r => r.title || r.url).filter(Boolean).slice(0, 3).join(', ');
  return {
    success: true,
    data,
    text: `Found ${data.length} hotel options in ${destination} (${checkIn} → ${checkOut}) from: ${sources}.`
  };
}

async function execute(userId, action, params) {
  if (!process.env.FIRECRAWL_API_KEY) {
    return { success: false, error: 'Hotel search is not configured (FIRECRAWL_API_KEY missing).' };
  }
  try {
    if (action === 'search_hotels' || action === 'get_hotel_details' || action === 'check_hotel_availability') {
      return await searchHotels(params || {});
    }
    return { success: false, error: `Unknown hotel action: ${action}` };
  } catch (err) {
    return { success: false, error: err.message || 'Hotel search failed.' };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };

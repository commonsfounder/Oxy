const SUPPORTED_ACTIONS = ['search_flights', 'get_flight_prices'];

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

async function searchFlights({ origin, destination, date, returnDate, partySize, cabinClass }) {
  if (!origin || !destination || !date) {
    return { success: false, error: 'origin, destination, and date are required.' };
  }
  const pax = parseInt(partySize || 1, 10);
  const cabin = cabinClass ? ` ${cabinClass}` : '';
  const ret = returnDate ? ` return ${returnDate}` : ' one way';
  const query = `flights from ${origin} to ${destination} ${date}${ret} ${pax} passenger${pax > 1 ? 's' : ''}${cabin} price GBP`;
  const results = await firecrawlSearch(query, 5);
  if (!results.length) return { success: true, data: [], text: `No flight results found for ${origin} → ${destination} on ${date}.` };

  const text = results.map(r => `**${r.metadata?.title || r.url}**\n${r.metadata?.description || ''}\n${r.url}`).join('\n\n');
  return {
    success: true,
    data: results.map(r => ({ title: r.metadata?.title, url: r.url, snippet: r.metadata?.description })),
    text: `Flight options for ${origin} → ${destination} on ${date}:\n\n${text}`
  };
}

async function execute(userId, action, params) {
  if (!process.env.FIRECRAWL_API_KEY) {
    return { success: false, error: 'Flight search is not configured (FIRECRAWL_API_KEY missing).' };
  }
  try {
    if (action === 'search_flights' || action === 'get_flight_prices') return await searchFlights(params || {});
    return { success: false, error: `Unknown flight action: ${action}` };
  } catch (err) {
    return { success: false, error: err.message || 'Flight search failed.' };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };

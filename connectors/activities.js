const SUPPORTED_ACTIONS = ['search_activities', 'get_activity_details'];

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

async function searchActivities({ destination, interests, budget, date }) {
  if (!destination) return { success: false, error: 'destination is required.' };
  const interestStr = Array.isArray(interests) && interests.length ? interests.join(' ') : '';
  const budgetStr = budget ? ` under £${budget}` : '';
  const dateStr = date ? ` ${date}` : '';
  const query = `things to do in ${destination}${dateStr} ${interestStr}${budgetStr} tickets booking`;
  const results = await firecrawlSearch(query, 6);
  if (!results.length) return { success: true, data: [], text: `No activities found in ${destination}.` };

  const text = results.map(r => `**${r.metadata?.title || r.url}**\n${r.metadata?.description || ''}\n${r.url}`).join('\n\n');
  return {
    success: true,
    data: results.map(r => ({ title: r.metadata?.title, url: r.url, snippet: r.metadata?.description })),
    text: `Activities in ${destination}:\n\n${text}`
  };
}

async function execute(userId, action, params) {
  if (!process.env.FIRECRAWL_API_KEY) {
    return { success: false, error: 'Activity search is not configured (FIRECRAWL_API_KEY missing).' };
  }
  try {
    if (action === 'search_activities' || action === 'get_activity_details') return await searchActivities(params || {});
    return { success: false, error: `Unknown activity action: ${action}` };
  } catch (err) {
    return { success: false, error: err.message || 'Activity search failed.' };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };

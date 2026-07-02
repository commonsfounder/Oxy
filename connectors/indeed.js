const SUPPORTED_ACTIONS = ['search_indeed_jobs'];

function indeedWebLink(query, location) {
  const params = new URLSearchParams({ q: query });
  if (location) params.set('l', location);
  return `https://www.indeed.com/jobs?${params}`;
}

// Indeed's job-search API was deprecated for third parties, so this is a
// deep-link/web-link handoff (Deliveroo pattern) rather than a scraper.
async function execute(userId, action, params) {
  if (action !== 'search_indeed_jobs') {
    return { success: false, error: `Unknown action: ${action}` };
  }

  const query = String(params?.query || params?.role || params?.title || '').trim();
  if (!query) return { success: false, error: 'search_indeed_jobs requires a job title or query' };

  const location = String(params?.location || params?.where || '').trim();
  const webLink = indeedWebLink(query, location);

  return {
    success: true,
    text: `Here's an Indeed search for "${query}"${location ? ` in ${location}` : ''}.`,
    webLink,
    deepLink: webLink
  };
}

module.exports = { SUPPORTED_ACTIONS, execute };

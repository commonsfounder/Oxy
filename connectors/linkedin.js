const SUPPORTED_ACTIONS = ['search_linkedin_jobs', 'share_linkedin_post'];

function linkedinJobsLink(query, location) {
  const params = new URLSearchParams({ keywords: query });
  if (location) params.set('location', location);
  return `https://www.linkedin.com/jobs/search/?${params}`;
}

function linkedinShareLink(url) {
  return `https://www.linkedin.com/sharing/share-offsite/?${new URLSearchParams({ url })}`;
}

// LinkedIn's posting/UGC API requires Marketing Developer Platform partner
// access, so this is a deep-link/web-link handoff (Deliveroo pattern) rather
// than a scraper or unsupported API integration.
async function execute(userId, action, params) {
  switch (action) {
    case 'search_linkedin_jobs': {
      const query = String(params?.query || params?.role || params?.title || '').trim();
      if (!query) return { success: false, error: 'search_linkedin_jobs requires a job title or query' };
      const location = String(params?.location || params?.where || '').trim();
      const webLink = linkedinJobsLink(query, location);
      return {
        success: true,
        text: `Here's a LinkedIn jobs search for "${query}"${location ? ` in ${location}` : ''}.`,
        webLink,
        deepLink: webLink
      };
    }

    case 'share_linkedin_post': {
      const url = String(params?.url || params?.link || '').trim();
      if (!url) return { success: false, error: 'share_linkedin_post requires a url to share' };
      const webLink = linkedinShareLink(url);
      return {
        success: true,
        text: 'Opening LinkedIn to share this link.',
        webLink,
        deepLink: webLink
      };
    }

    default:
      return { success: false, error: `Unknown action: ${action}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };

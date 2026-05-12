const SUPPORTED_ACTIONS = ['search_netflix_title', 'add_to_netflix_list'];

function netflixSearchUrl(title) {
  return `https://www.netflix.com/search?q=${encodeURIComponent(title)}`;
}

async function execute(userId, action, params) {
  try {
    const title = params?.title?.trim();
    if (!title) return { success: false, error: `${action} requires a title` };

    const webLink = netflixSearchUrl(title);

    switch (action) {
      case 'search_netflix_title':
        return {
          success: true,
          text: `Opening Netflix results for ${title}.`,
          deepLink: webLink,
          webLink
        };

      case 'add_to_netflix_list':
        return {
          success: true,
          text: `Opening Netflix for ${title} — add it to My List in the app.`,
          deepLink: webLink,
          webLink
        };

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: `Netflix error: ${err.message}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };

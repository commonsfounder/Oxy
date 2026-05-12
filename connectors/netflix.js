const SUPPORTED_ACTIONS = ['search_netflix_title', 'add_to_netflix_list'];

function netflixSearchUrl(title) {
  return `https://www.netflix.com/search?q=${encodeURIComponent(title)}`;
}

function netflixDeepLink(title) {
  return `nflx://www.netflix.com/search?q=${encodeURIComponent(title)}`;
}

async function execute(userId, action, params) {
  try {
    const title = params?.title?.trim();
    if (!title) return { success: false, error: `${action} requires a title` };

    const webLink = netflixSearchUrl(title);
    const deepLink = netflixDeepLink(title);

    switch (action) {
      case 'search_netflix_title':
        return {
          success: true,
          text: `Trying Netflix for ${title}.`,
          deepLink,
          webLink
        };

      case 'add_to_netflix_list':
        return {
          success: true,
          text: `Trying Netflix for ${title} so you can add it to My List.`,
          deepLink,
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

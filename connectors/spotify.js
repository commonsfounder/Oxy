const SUPPORTED_ACTIONS = ['play_music', 'add_to_music_playlist', 'search_music'];

// Note: This is a stub. Real implementation needs Spotify Web API + user tokens (refresh via env or DB).
// For now it provides better hints + falls back to deep link like other music actions.

function spotifyWebSearch(query) {
  return `https://open.spotify.com/search/${encodeURIComponent(query)}`;
}

function spotifyDeepLink(query) {
  return `spotify:search:${encodeURIComponent(query)}`;
}

async function execute(userId, action, params) {
  const query = (params?.query || params?.song || params?.title || '').trim();
  if (!query) {
    return { success: false, error: `${action} requires a query` };
  }

  const web = spotifyWebSearch(query);
  const deep = spotifyDeepLink(query);

  if (action === 'search_music' || action === 'play_music') {
    return {
      success: true,
      text: `Searching Spotify for ${query}.`,
      deepLink: deep,
      webLink: web,
      cardText: query,
      actionSummary: 'Spotify search ready'
    };
  }

  if (action === 'add_to_music_playlist') {
    const playlist = params?.playlist ? ` to ${params.playlist}` : '';
    return {
      success: true,
      text: `Open Spotify to add ${query}${playlist}.`,
      deepLink: deep,
      webLink: web
    };
  }

  return { success: false, error: 'Unknown Spotify action' };
}

module.exports = { SUPPORTED_ACTIONS, execute };
const axios = require('axios');

const SUPPORTED_ACTIONS = ['search_youtube'];

function youtubeWebLink(query) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

function summarizeVideos(videos, query) {
  if (!videos.length) return `No YouTube results for "${query}"`;
  const lines = videos.map((v, i) => `${i + 1}. ${v.title} — ${v.channel}${v.publishedAt ? ` (${v.publishedAt.slice(0, 10)})` : ''}`);
  return `YouTube results for "${query}":\n${lines.join('\n')}`;
}

// Falls back to a plain web/deep-link search when YOUTUBE_API_KEY isn't configured —
// still useful (opens results), just without titles the model can read out.
async function execute(userId, action, params) {
  if (action !== 'search_youtube') return { success: false, error: `Unknown action: ${action}` };

  const query = String(params?.query || params?.q || params?.search || '').trim();
  if (!query) return { success: false, error: 'search_youtube requires a query' };

  const webLink = youtubeWebLink(query);
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!apiKey) {
    return {
      success: true,
      text: `Here's a YouTube search for "${query}".`,
      webLink,
      deepLink: `youtube://results?search_query=${encodeURIComponent(query)}`
    };
  }

  try {
    const resp = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: { part: 'snippet', q: query, type: 'video', maxResults: 5, key: apiKey },
      timeout: 10000
    });

    const videos = (resp.data?.items || [])
      .filter(item => item.id?.videoId)
      .map(item => ({
        title: item.snippet?.title,
        channel: item.snippet?.channelTitle,
        videoId: item.id.videoId,
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
        publishedAt: item.snippet?.publishedAt
      }));

    return {
      success: true,
      videos,
      text: summarizeVideos(videos, query),
      webLink,
      deepLink: videos[0] ? `youtube://watch?v=${videos[0].videoId}` : `youtube://results?search_query=${encodeURIComponent(query)}`
    };
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    return { success: false, error: `YouTube search failed: ${detail}`, webLink };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };

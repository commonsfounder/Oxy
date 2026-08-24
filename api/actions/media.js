'use strict';

// Music and image actions, lifted out of the switch in api/index.js. These reach for
// nothing index.js owns -- they hand straight off to the connector dispatch in their own
// bodies -- so they take no dependencies at all.

async function playMusic({ userId, action, params, enrichedParams, context, deps, helpers }) {
  
  const query = String(params?.query || params?.song || params?.title || '').trim();
  if (!query) return { success: false, error: 'play_music requires a query' };
  return {
    success: false,
    outcome: 'handoff_required',
    handoffRequired: true,
    text: `Starting playback for ${query}.`,
    cardText: query,
    actionSummary: 'Music requested',
    deepLink: `music://music.apple.com/search?term=${encodeURIComponent(query)}`,
    webLink: `https://music.apple.com/search?term=${encodeURIComponent(query)}`,
    nativeExecution: 'music'
  };
}

async function addToMusicPlaylist({ userId, action, params, enrichedParams, context, deps, helpers }) {
  
  const query = String(params?.query || params?.song || params?.title || '').trim();
  const playlist = String(params?.playlist || params?.playlistName || '').trim();
  if (!query) return { success: false, error: 'add_to_music_playlist requires a query' };
  return {
    success: false,
    outcome: 'handoff_required',
    handoffRequired: true,
    text: playlist
      ? `Opening Apple Music for ${query}. Add it to ${playlist} there.`
      : `Opening Apple Music for ${query}.`,
    cardText: playlist ? `${query} · ${playlist}` : query,
    actionSummary: playlist ? 'Music ready' : 'Music opened',
    deepLink: `music://music.apple.com/search?term=${encodeURIComponent(query)}`,
    webLink: `https://music.apple.com/search?term=${encodeURIComponent(query)}`
  };
}

async function editPhoto({ userId, action, params, enrichedParams, context, deps, helpers }) {
  
  const brief = params?.brief || 'enhance';
  return { success: false, outcome: 'unavailable', unavailable: true, error: `Photo editing is not available yet (${brief}).` };
}

async function analyzeImage({ userId, action, params, enrichedParams, context, deps, helpers }) {
  
  const prompt = params?.prompt || 'Describe this image and extract any actionable info';
  return { success: false, outcome: 'unavailable', unavailable: true, error: `Image analysis needs an uploaded image; no image was provided for "${prompt}".` };
}

module.exports = {
  handlers: {
    play_music: playMusic,
    add_to_music_playlist: addToMusicPlaylist,
    edit_photo: editPhoto,
    analyze_image: analyzeImage
  }
};

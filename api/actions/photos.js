'use strict';

const photoNotes = require('../services/photo-notes');

async function searchPhotos({ userId, params, deps }) {
  const lines = await photoNotes.search(deps.supabase, userId, params?.query);
  if (!lines.length) return { success: true, items: [], text: "I haven't seen anything about that in your photos." };
  return { success: true, items: lines, text: lines.join('\n') };
}

module.exports = { handlers: { search_photos: searchPhotos } };

const axios = require('axios');
const { createSupabaseServiceClient, logMissingRuntimeEnvOnce } = require('../runtime');
const { decryptTokens, encryptTokens } = require('../api/services/token-crypto');

const supabase = createSupabaseServiceClient();
logMissingRuntimeEnvOnce('spotify connector bootstrap');

const SUPPORTED_ACTIONS = [
  'search_spotify',
  'play_spotify',
  'control_spotify_playback',
  'add_to_spotify_queue',
  'add_to_spotify_playlist',
  'get_now_playing_spotify'
];

const API_BASE = 'https://api.spotify.com/v1';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

async function getTokens(userId) {
  try {
    const { data, error } = await supabase
      .from('connectors')
      .select('tokens')
      .eq('user_id', userId)
      .eq('connector_id', 'spotify')
      .eq('enabled', true)
      .limit(1);

    if (!error && data?.length > 0 && data[0].tokens) return decryptTokens(data[0].tokens);
  } catch (err) {
    console.error('[spotify getTokens] DB error:', err.message);
  }
  return {};
}

async function saveTokens(userId, tokens) {
  const { error } = await supabase
    .from('connectors')
    .upsert({ user_id: userId, connector_id: 'spotify', enabled: true, tokens: encryptTokens(tokens), updated_at: new Date().toISOString() },
             { onConflict: 'user_id,connector_id' });
  if (error) throw error;
}

async function markDisconnected(userId) {
  await supabase
    .from('connectors')
    .upsert({ user_id: userId, connector_id: 'spotify', enabled: false, tokens: encryptTokens({}), updated_at: new Date().toISOString() },
             { onConflict: 'user_id,connector_id' });
}

function basicAuthHeader() {
  return `Basic ${Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64')}`;
}

async function getAccessToken(userId) {
  const tokens = await getTokens(userId);

  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 60000) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    throw new Error('Spotify not connected. Connect Spotify from Settings.');
  }

  const attemptRefresh = () => axios.post(TOKEN_URL, new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token
  }).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuthHeader() },
    timeout: 10000
  });

  let resp;
  try {
    resp = await attemptRefresh();
  } catch (err) {
    const desc = err.response?.data?.error_description || err.message;
    if (typeof desc === 'string' && (desc.includes('expired') || desc.includes('revoked') || desc.includes('invalid_grant'))) {
      try { await markDisconnected(userId); } catch (cleanupErr) {
        console.warn('[spotify] disconnect cleanup failed:', cleanupErr.message);
      }
      throw new Error('Spotify session expired. Reconnect Spotify from Settings.');
    }
    await new Promise(r => setTimeout(r, 1000));
    try {
      resp = await attemptRefresh();
    } catch (retryErr) {
      throw new Error(`Failed to refresh Spotify token: ${retryErr.response?.data?.error_description || retryErr.message}`);
    }
  }

  const updated = {
    ...tokens,
    access_token: resp.data.access_token,
    refresh_token: resp.data.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + resp.data.expires_in * 1000
  };
  await saveTokens(userId, updated);
  return updated.access_token;
}

async function spotifyApi(userId, config) {
  const accessToken = await getAccessToken(userId);
  try {
    return await axios({
      ...config,
      baseURL: API_BASE,
      headers: { Authorization: `Bearer ${accessToken}`, ...(config.headers || {}) },
      timeout: 10000
    });
  } catch (err) {
    const status = err.response?.status;
    const reason = err.response?.data?.error?.reason;
    if (status === 404 && reason === 'NO_ACTIVE_DEVICE') {
      throw new Error('No active Spotify device. Open Spotify on a phone, computer, or speaker first.');
    }
    if (status === 403) {
      throw new Error('Spotify playback control requires Spotify Premium.');
    }
    throw new Error(err.response?.data?.error?.message || err.message);
  }
}

async function searchSpotify(userId, query, type = 'track', limit = 5) {
  const resp = await spotifyApi(userId, {
    method: 'GET',
    url: '/search',
    params: { q: query, type, limit }
  });
  return resp.data;
}

function describeTrack(track) {
  const artists = (track.artists || []).map(a => a.name).join(', ');
  return `${track.name} by ${artists}`;
}

async function execute(userId, action, params = {}) {
  try {
    switch (action) {
      case 'search_spotify': {
        const { query, type = 'track' } = params;
        if (!query) return { success: false, error: 'A search query is required.' };
        const data = await searchSpotify(userId, query, type, 5);
        const items = data[`${type}s`]?.items || [];
        if (!items.length) return { success: true, text: `No Spotify results for "${query}".`, results: [] };
        const lines = items.map(item => {
          if (type === 'track') return describeTrack(item);
          if (type === 'artist') return item.name;
          if (type === 'album') return `${item.name} by ${(item.artists || []).map(a => a.name).join(', ')}`;
          return item.name;
        });
        return { success: true, text: `Spotify results for "${query}":\n${lines.join('\n')}`, results: items };
      }

      case 'play_spotify': {
        const { query, type = 'track' } = params;
        if (!query) return { success: false, error: 'What would you like to play?' };
        const data = await searchSpotify(userId, query, type, 1);
        const item = data[`${type}s`]?.items?.[0];
        if (!item) return { success: false, error: `Couldn't find "${query}" on Spotify.` };
        const body = type === 'track' ? { uris: [item.uri] } : { context_uri: item.uri };
        await spotifyApi(userId, { method: 'PUT', url: '/me/player/play', data: body });
        const label = type === 'track' ? describeTrack(item) : item.name;
        return { success: true, text: `Playing ${label} on Spotify.` };
      }

      case 'control_spotify_playback': {
        const command = (params.command || '').toLowerCase();
        const map = {
          pause: { method: 'PUT', url: '/me/player/pause' },
          resume: { method: 'PUT', url: '/me/player/play' },
          play: { method: 'PUT', url: '/me/player/play' },
          next: { method: 'POST', url: '/me/player/next' },
          previous: { method: 'POST', url: '/me/player/previous' }
        };
        const req = map[command];
        if (!req) return { success: false, error: `Unknown playback command "${params.command}".` };
        await spotifyApi(userId, req);
        const verbs = { pause: 'Paused', resume: 'Resumed', play: 'Resumed', next: 'Skipped to next track', previous: 'Skipped to previous track' };
        return { success: true, text: `${verbs[command]} on Spotify.` };
      }

      case 'add_to_spotify_queue': {
        const { query } = params;
        if (!query) return { success: false, error: 'What track should I queue?' };
        const data = await searchSpotify(userId, query, 'track', 1);
        const track = data.tracks?.items?.[0];
        if (!track) return { success: false, error: `Couldn't find "${query}" on Spotify.` };
        await spotifyApi(userId, { method: 'POST', url: '/me/player/queue', params: { uri: track.uri } });
        return { success: true, text: `Queued ${describeTrack(track)} on Spotify.` };
      }

      case 'add_to_spotify_playlist': {
        const { query, playlist } = params;
        if (!query || !playlist) return { success: false, error: 'A track and a playlist name are required.' };
        const data = await searchSpotify(userId, query, 'track', 1);
        const track = data.tracks?.items?.[0];
        if (!track) return { success: false, error: `Couldn't find "${query}" on Spotify.` };

        const playlistsResp = await spotifyApi(userId, { method: 'GET', url: '/me/playlists', params: { limit: 50 } });
        const match = (playlistsResp.data.items || []).find(p => p.name.toLowerCase() === playlist.toLowerCase())
          || (playlistsResp.data.items || []).find(p => p.name.toLowerCase().includes(playlist.toLowerCase()));
        if (!match) return { success: false, error: `Couldn't find a Spotify playlist named "${playlist}".` };

        await spotifyApi(userId, { method: 'POST', url: `/playlists/${match.id}/tracks`, data: { uris: [track.uri] } });
        return { success: true, text: `Added ${describeTrack(track)} to "${match.name}" on Spotify.` };
      }

      case 'get_now_playing_spotify': {
        const resp = await spotifyApi(userId, { method: 'GET', url: '/me/player/currently-playing' });
        if (!resp.data || !resp.data.item) {
          return { success: true, text: 'Nothing is currently playing on Spotify.' };
        }
        const track = resp.data.item;
        const status = resp.data.is_playing ? 'Playing' : 'Paused';
        return { success: true, text: `${status}: ${describeTrack(track)} (${track.album?.name || ''}) on Spotify.` };
      }

      default:
        return { success: false, error: `Unsupported Spotify action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute, saveTokens, getTokens };

const axios = require('axios');
const { createSupabaseServiceClient, logMissingRuntimeEnvOnce } = require('../runtime');
const { decryptTokens, encryptTokens } = require('../api/services/token-crypto');

const supabase = createSupabaseServiceClient();
logMissingRuntimeEnvOnce('calendly connector bootstrap');

const SUPPORTED_ACTIONS = ['list_calendly_events'];

const API_BASE = 'https://api.calendly.com';
const TOKEN_URL = 'https://auth.calendly.com/oauth/token';

async function getTokens(userId) {
  try {
    const { data, error } = await supabase
      .from('connectors')
      .select('tokens')
      .eq('user_id', userId)
      .eq('connector_id', 'calendly')
      .eq('enabled', true)
      .limit(1);
    if (!error && data?.length > 0 && data[0].tokens) return decryptTokens(data[0].tokens);
  } catch (err) {
    console.error('[calendly getTokens] DB error:', err.message);
  }
  return {};
}

async function saveTokens(userId, tokens) {
  const { error } = await supabase
    .from('connectors')
    .upsert({ user_id: userId, connector_id: 'calendly', enabled: true, tokens: encryptTokens(tokens), updated_at: new Date().toISOString() },
             { onConflict: 'user_id,connector_id' });
  if (error) throw error;
}

async function markDisconnected(userId) {
  await supabase
    .from('connectors')
    .upsert({ user_id: userId, connector_id: 'calendly', enabled: false, tokens: encryptTokens({}), updated_at: new Date().toISOString() },
             { onConflict: 'user_id,connector_id' });
}

function basicAuthHeader() {
  return `Basic ${Buffer.from(`${process.env.CALENDLY_CLIENT_ID}:${process.env.CALENDLY_CLIENT_SECRET}`).toString('base64')}`;
}

async function getAccessToken(userId) {
  const tokens = await getTokens(userId);
  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 60000) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) {
    throw new Error('Calendly not connected. Connect Calendly from Settings.');
  }
  let resp;
  try {
    resp = await axios.post(TOKEN_URL, new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuthHeader() },
      timeout: 10000
    });
  } catch (err) {
    const desc = err.response?.data?.error || err.message;
    if (typeof desc === 'string' && /invalid_grant|expired|revoked/.test(desc)) {
      try { await markDisconnected(userId); } catch {}
      throw new Error('Calendly session expired. Reconnect Calendly from Settings.');
    }
    throw new Error(`Failed to refresh Calendly token: ${desc}`);
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

async function calendlyApi(userId, config) {
  const accessToken = await getAccessToken(userId);
  return axios({
    ...config,
    baseURL: API_BASE,
    headers: { Authorization: `Bearer ${accessToken}`, ...(config.headers || {}) },
    timeout: 10000
  });
}

async function execute(userId, action, params) {
  try {
    switch (action) {
      case 'list_calendly_events': {
        const me = await calendlyApi(userId, { method: 'GET', url: '/users/me' });
        const userUri = me.data?.resource?.uri;
        if (!userUri) return { success: false, error: 'Could not resolve Calendly user.' };

        const events = await calendlyApi(userId, {
          method: 'GET',
          url: '/scheduled_events',
          params: { user: userUri, status: 'active', sort: 'start_time:asc', count: Number(params?.limit) || 5 }
        });
        const list = (events.data?.collection || []).map(e => ({
          name: e.name,
          start: e.start_time,
          end: e.end_time,
          location: e.location?.location || e.location?.type || null,
          status: e.status
        }));
        if (list.length === 0) {
          return { success: true, text: 'No upcoming Calendly bookings.', cardText: 'No upcoming bookings' };
        }
        const summary = list.map(e => `${e.name} — ${new Date(e.start).toLocaleString()}`).join('; ');
        return { success: true, text: `Upcoming Calendly: ${summary}`, cardText: `${list.length} upcoming booking${list.length > 1 ? 's' : ''}`, events: list };
      }
      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: `Calendly error: ${err.response?.data?.message || err.message}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute, getTokens, saveTokens };

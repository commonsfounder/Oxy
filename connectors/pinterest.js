const axios = require('axios');
const { createSupabaseServiceClient, logMissingRuntimeEnvOnce } = require('../runtime');
const { decryptTokens, encryptTokens } = require('../api/services/token-crypto');

const supabase = createSupabaseServiceClient();
logMissingRuntimeEnvOnce('pinterest connector bootstrap');

const SUPPORTED_ACTIONS = ['list_pinterest_boards'];

const API_BASE = 'https://api.pinterest.com/v5';
const TOKEN_URL = 'https://api.pinterest.com/v5/oauth/token';

async function getTokens(userId) {
  try {
    const { data, error } = await supabase
      .from('connectors')
      .select('tokens')
      .eq('user_id', userId)
      .eq('connector_id', 'pinterest')
      .eq('enabled', true)
      .limit(1);
    if (!error && data?.length > 0 && data[0].tokens) return decryptTokens(data[0].tokens);
  } catch (err) {
    console.error('[pinterest getTokens] DB error:', err.message);
  }
  return {};
}

async function saveTokens(userId, tokens) {
  const { error } = await supabase
    .from('connectors')
    .upsert({ user_id: userId, connector_id: 'pinterest', enabled: true, tokens: encryptTokens(tokens), updated_at: new Date().toISOString() },
             { onConflict: 'user_id,connector_id' });
  if (error) throw error;
}

async function markDisconnected(userId) {
  await supabase
    .from('connectors')
    .upsert({ user_id: userId, connector_id: 'pinterest', enabled: false, tokens: encryptTokens({}), updated_at: new Date().toISOString() },
             { onConflict: 'user_id,connector_id' });
}

function basicAuthHeader() {
  return `Basic ${Buffer.from(`${process.env.PINTEREST_CLIENT_ID}:${process.env.PINTEREST_CLIENT_SECRET}`).toString('base64')}`;
}

async function getAccessToken(userId) {
  const tokens = await getTokens(userId);
  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 60000) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) {
    throw new Error('Pinterest not connected. Connect Pinterest from Settings.');
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
    const desc = err.response?.data?.message || err.response?.data?.error || err.message;
    if (typeof desc === 'string' && /invalid_grant|expired|revoked/.test(desc)) {
      try { await markDisconnected(userId); } catch {}
      throw new Error('Pinterest session expired. Reconnect Pinterest from Settings.');
    }
    throw new Error(`Failed to refresh Pinterest token: ${desc}`);
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

async function pinterestApi(userId, config) {
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
      case 'list_pinterest_boards': {
        const resp = await pinterestApi(userId, {
          method: 'GET',
          url: '/boards',
          params: { page_size: Number(params?.limit) || 10 }
        });
        const list = (resp.data?.items || []).map(b => ({
          id: b.id,
          name: b.name,
          description: b.description || null,
          pinCount: b.pin_count
        }));
        if (list.length === 0) {
          return { success: true, text: 'No Pinterest boards yet.', cardText: 'No boards' };
        }
        const summary = list.map(b => b.name).join(', ');
        return { success: true, text: `Pinterest boards: ${summary}`, cardText: `${list.length} board${list.length > 1 ? 's' : ''}`, boards: list };
      }
      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: `Pinterest error: ${err.response?.data?.message || err.message}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute, getTokens, saveTokens };

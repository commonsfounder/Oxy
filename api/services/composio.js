'use strict';

// Hosted catalogue of third-party apps: Composio holds the sign-in and the tool list, so a new
// app needs no developer registration on our side. Off until COMPOSIO_API_KEY is set.

const axios = require('axios');

const BASE_URL = 'https://backend.composio.dev/api/v3.1';
const TIMEOUT_MS = 30000;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const TOOL_SLUG = /^[A-Z0-9][A-Z0-9_]{1,127}$/;
// A tool whose name starts with one of these only reads; anything else is treated as an action.
const READ_VERBS = /^[A-Z0-9]+_(GET|LIST|SEARCH|FETCH|FIND|READ|RETRIEVE|LOOKUP|QUERY|VIEW|CHECK)(_|$)/;

function createComposio({ env = process.env, http = null } = {}) {
  const apiKey = env.COMPOSIO_API_KEY || '';
  const configured = Boolean(apiKey);
  const authConfigs = new Map(Object.entries(parseJson(env.COMPOSIO_AUTH_CONFIGS)));

  const send = http || (async (method, path, { query, body } = {}) => {
    const res = await axios({ method, url: `${BASE_URL}${path}`, params: query, paramsSerializer: { indexes: null }, data: body, timeout: TIMEOUT_MS, headers: { 'x-api-key': apiKey } });
    return res.data;
  });

  function requireConfigured() {
    if (!configured) throw Object.assign(new Error('The app catalogue is not set up yet.'), { unavailable: true });
  }

  // Composio-managed sign-in, created once per app and remembered for this process. A fixed id can be pinned in COMPOSIO_AUTH_CONFIGS.
  async function authConfigFor(toolkit) {
    if (authConfigs.has(toolkit)) return authConfigs.get(toolkit);
    const created = await send('POST', '/auth_configs', { body: { toolkit: { slug: toolkit }, auth_config: { type: 'use_composio_managed_auth' } } });
    const id = created?.auth_config?.id;
    if (!id) throw new Error(`Could not set up sign-in for ${toolkit}.`);
    authConfigs.set(toolkit, id);
    return id;
  }

  async function startConnection(userId, toolkit, { callbackUrl } = {}) {
    requireConfigured();
    if (!SLUG.test(String(toolkit || ''))) throw new Error('Pick an app to connect.');
    const slug = String(toolkit).toLowerCase();
    const link = await send('POST', '/connected_accounts/link', {
      body: { auth_config_id: await authConfigFor(slug), user_id: userId, ...(callbackUrl ? { callback_url: callbackUrl } : {}) }
    });
    if (!link?.redirect_url) throw new Error('The sign-in page could not be created.');
    return { redirectUrl: link.redirect_url, connectedAccountId: link.connected_account_id || null, expiresAt: link.expires_at || null };
  }

  async function listConnections(userId) {
    requireConfigured();
    const res = await send('GET', '/connected_accounts', { query: { user_ids: [userId] } });
    return ownedBy(res, userId).map(item => ({ id: item.id, toolkit: item.toolkit?.slug || null, status: item.status || null, connected: item.status === 'ACTIVE' }));
  }

  // Signs the user out of one app by deleting its connected accounts.
  async function disconnect(userId, toolkit) {
    requireConfigured();
    if (!SLUG.test(String(toolkit || ''))) throw new Error('Pick an app to disconnect.');
    const res = await send('GET', '/connected_accounts', { query: { user_ids: [userId], toolkit_slugs: [String(toolkit).toLowerCase()] } });
    const ids = ownedBy(res, userId).filter(item => item.toolkit?.slug === String(toolkit).toLowerCase()).map(item => item.id).filter(Boolean);
    for (const id of ids) await send('DELETE', `/connected_accounts/${id}`);
    return { removed: ids.length };
  }

  async function execute(userId, toolSlug, args = {}) {
    requireConfigured();
    if (!TOOL_SLUG.test(String(toolSlug || ''))) throw new Error('That is not a valid app tool name.');
    const res = await send('POST', `/tools/execute/${toolSlug}`, { body: { user_id: userId, arguments: args && typeof args === 'object' ? args : {} } });
    return { successful: res?.successful === true, data: res?.data ?? null, error: res?.error || null };
  }

  return { configured, startConnection, listConnections, disconnect, execute, isReadTool: (slug) => READ_VERBS.test(String(slug || '')) };
}

// Never trust the server-side filter alone: keep only accounts that name this user.
function ownedBy(res, userId) {
  return (res?.items || []).filter(item => item && item.user_id === userId);
}

function parseJson(text) {
  try { const v = JSON.parse(text || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

module.exports = { createComposio, READ_VERBS };

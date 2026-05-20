require('dotenv').config();

const { dispatch } = require('../connectors');
const { getAuthenticatedUserId, requireSessionAuth } = require('../auth');
const { createSupabaseServiceClient, logMissingRuntimeEnvOnce } = require('../runtime');

const supabase = createSupabaseServiceClient();
logMissingRuntimeEnvOnce('proxy bootstrap');
const USER_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

module.exports = async function handler(req, res) {
  const allowedOrigin = process.env.APP_URL || '';
  if (!allowedOrigin) {
    return res.status(500).json({ error: 'CORS not configured' });
  }
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Token');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  let authorized = false;
  requireSessionAuth(req, res, () => { authorized = true; });
  if (!authorized) return;

  const { userId, action, params = {} } = req.body || {};

  if (!action) return res.status(400).json({ error: 'action is required' });
  if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) {
    return res.status(400).json({ error: 'Valid userId is required' });
  }
  if (userId !== getAuthenticatedUserId(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Action allowlist guard: validate action is a known own property of the registry
  const { registry: connectorRegistry } = require('../connectors');
  if (!Object.prototype.hasOwnProperty.call(connectorRegistry, action)) {
    return res.status(400).json({ error: 'Unknown action' });
  }

  try {
    const result = await dispatch(userId, action, params);

    await supabase.from('action_log').insert({
      user_id: userId,
      action: JSON.stringify({ action, params }),
      status: result.success ? 'executed' : 'failed',
      created_at: new Date().toISOString()
    });

    res.json(result);
  } catch (err) {
    await supabase.from('action_log').insert({
      user_id: userId,
      action: JSON.stringify({ action, params }),
      status: 'failed',
      created_at: new Date().toISOString()
    });
    console.error('[proxy] dispatch error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

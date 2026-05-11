require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { dispatch } = require('../connectors');
const { getAuthenticatedUserId, requireSessionAuth } = require('../auth');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const USER_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

module.exports = async function handler(req, res) {
  const allowedOrigin = process.env.APP_URL || `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
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
    res.status(500).json({ success: false, error: err.message });
  }
};

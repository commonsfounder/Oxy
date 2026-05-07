const { createClient } = require('@supabase/supabase-js');
const { dispatch } = require('../connectors');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { userId = 'default', action, params = {} } = req.body || {};

  if (!action) return res.status(400).json({ error: 'action is required' });

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

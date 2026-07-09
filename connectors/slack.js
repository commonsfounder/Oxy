const axios = require('axios');
const { createSupabaseServiceClient } = require('../runtime');
const { decryptTokens } = require('../api/services/token-crypto');

const supabase = createSupabaseServiceClient();

const SUPPORTED_ACTIONS = ['send_slack_message', 'search_slack', 'get_slack_channels'];

async function getSlackToken(userId) {
  try {
    const { data } = await supabase.from('connectors').select('tokens').eq('user_id', userId).eq('connector_id', 'slack').eq('enabled', true).limit(1);
    if (data?.length > 0 && data[0].tokens) return decryptTokens(data[0].tokens).access_token;
  } catch (e) {}
  return process.env.SLACK_BOT_TOKEN || null;
}

async function execute(userId, action, params) {
  const token = await getSlackToken(userId);
  if (!token) {
    return { success: true, text: `Slack ${action} - connect for real messaging.`, webLink: 'https://slack.com' };
  }

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  try {
    // Regression: Slack's Web API returns HTTP 200 even on failure, with { ok: false, error }
    // in the body — none of these calls checked res.data.ok, so an invalid token, missing
    // channel, or unauthorized scope silently reported success.
    if (action === 'send_slack_message') {
      const res = await axios.post('https://slack.com/api/chat.postMessage', {
        channel: params.channel || '#general',
        text: params.message || 'Message from your assistant'
      }, { headers });
      if (!res.data.ok) return { success: false, error: `Slack error: ${res.data.error || 'unknown'}` };
      return { success: true, text: `Sent to Slack: ${params.message}`, channel: params.channel };
    }
    if (action === 'search_slack') {
      const res = await axios.get(`https://slack.com/api/search.messages?query=${encodeURIComponent(params.query || '')}`, { headers });
      if (!res.data.ok) return { success: false, error: `Slack error: ${res.data.error || 'unknown'}` };
      return { success: true, text: `Slack search results for ${params.query}` };
    }
    if (action === 'get_slack_channels') {
      const res = await axios.get('https://slack.com/api/conversations.list', { headers });
      if (!res.data.ok) return { success: false, error: `Slack error: ${res.data.error || 'unknown'}` };
      return { success: true, text: `Slack channels: ${res.data.channels.map(c => c.name).join(', ')}` };
    }
    return { success: false, error: 'Unknown Slack action' };
  } catch (e) {
    // Regression: this silently reported success even when the real Slack API call threw
    // (network error, bad token) — the failure was invisible to both the agent and the user.
    return { success: false, error: `Slack error: ${e.response?.data?.error || e.message}`, webLink: 'https://slack.com' };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };
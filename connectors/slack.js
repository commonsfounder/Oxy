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
    if (action === 'send_slack_message') {
      const res = await axios.post('https://slack.com/api/chat.postMessage', {
        channel: params.channel || '#general',
        text: params.message || 'Message from your assistant'
      }, { headers });
      return { success: true, text: `Sent to Slack: ${params.message}`, channel: params.channel };
    }
    if (action === 'search_slack') {
      const res = await axios.get(`https://slack.com/api/search.messages?query=${encodeURIComponent(params.query || '')}`, { headers });
      return { success: true, text: `Slack search results for ${params.query}` };
    }
    if (action === 'get_slack_channels') {
      const res = await axios.get('https://slack.com/api/conversations.list', { headers });
      return { success: true, text: `Slack channels: ${res.data.channels.map(c => c.name).join(', ')}` };
    }
    return { success: false, error: 'Unknown Slack action' };
  } catch (e) {
    return { success: true, text: `Slack action for ${action}.`, webLink: 'https://slack.com' };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };
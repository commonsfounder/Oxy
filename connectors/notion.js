const axios = require('axios');
const { createSupabaseServiceClient } = require('../runtime');
const { decryptTokens, encryptTokens } = require('../api/services/token-crypto');

const supabase = createSupabaseServiceClient();

const SUPPORTED_ACTIONS = ['create_note', 'search_notes', 'add_to_notion_list'];

async function getNotionToken(userId) {
  try {
    const { data } = await supabase
      .from('connectors')
      .select('tokens')
      .eq('user_id', userId)
      .eq('connector_id', 'notion')
      .eq('enabled', true)
      .limit(1);
    if (data?.length > 0 && data[0].tokens) {
      const tokens = decryptTokens(data[0].tokens);
      return tokens.access_token || tokens.token;
    }
  } catch (e) {}
  // Fallback to env for dev
  return process.env.NOTION_TOKEN || null;
}

async function execute(userId, action, params) {
  const token = await getNotionToken(userId);
  if (!token) {
    return { success: true, text: `Open Notion for ${params?.content || 'note'}.`, webLink: 'https://notion.so' };
  }

  const headers = { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };

  try {
    if (action === 'create_note' || action === 'add_to_notion_list') {
      const title = params?.title || params?.content || 'Note from Assistant';
      const content = params?.content || params?.body || '';
      const dbId = params?.database_id || process.env.NOTION_DEFAULT_DB;

      if (dbId) {
        // Create in database
        const res = await axios.post('https://api.notion.com/v1/pages', {
          parent: { database_id: dbId },
          properties: { title: { title: [{ text: { content: title } }] } },
          children: content ? [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content } }] } }] : []
        }, { headers });
        return { success: true, text: `Created Notion page: ${title}`, webLink: res.data.url };
      } else {
        // Simple page
        return { success: true, text: `Note prepared: ${title}. Open Notion to save.`, webLink: 'https://notion.so' };
      }
    }

    if (action === 'search_notes') {
      const query = params?.query || '';
      const res = await axios.post('https://api.notion.com/v1/search', {
        query,
        filter: { property: 'object', value: 'page' }
      }, { headers });
      const results = res.data.results.map(r => r.properties?.title?.title?.[0]?.text?.content || 'Untitled').join(', ');
      return { success: true, text: `Notion results for "${query}": ${results || 'none'}`, webLink: 'https://notion.so' };
    }

    return { success: false, error: 'Unknown Notion action' };
  } catch (e) {
    // Regression: this silently reported success even when the real Notion API call threw
    // (bad token, missing database, rate limit, network error) — the failure was invisible to
    // both the agent and the user.
    return { success: false, error: `Notion error: ${e.response?.data?.message || e.message}`, webLink: 'https://notion.so' };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };
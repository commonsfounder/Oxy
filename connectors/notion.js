const axios = require('axios');
const { createSupabaseServiceClient, logMissingRuntimeEnvOnce } = require('../runtime');
const { decryptTokens, encryptTokens } = require('../api/services/token-crypto');

const supabase = createSupabaseServiceClient();
logMissingRuntimeEnvOnce('notion connector bootstrap');

const SUPPORTED_ACTIONS = ['search_notion', 'create_notion_page', 'append_notion_page'];

const API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

async function getTokens(userId) {
  try {
    const { data, error } = await supabase
      .from('connectors')
      .select('tokens')
      .eq('user_id', userId)
      .eq('connector_id', 'notion')
      .eq('enabled', true)
      .limit(1);

    if (!error && data?.length > 0 && data[0].tokens) return decryptTokens(data[0].tokens);
  } catch (err) {
    console.error('[notion getTokens] DB error:', err.message);
  }
  return {};
}

async function saveTokens(userId, tokens) {
  const { error } = await supabase
    .from('connectors')
    .upsert({ user_id: userId, connector_id: 'notion', enabled: true, tokens: encryptTokens(tokens), updated_at: new Date().toISOString() },
             { onConflict: 'user_id,connector_id' });
  if (error) throw error;
}

// Notion OAuth tokens do not expire and there is no refresh flow. A 401 from
// the API means the user revoked the integration from their workspace.
async function getAccessToken(userId) {
  const tokens = await getTokens(userId);
  if (!tokens.access_token) {
    throw new Error('Notion not connected. Connect Notion from Settings.');
  }
  return tokens.access_token;
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json'
  };
}

function richTextToPlain(richText = []) {
  return (richText || []).map(rt => rt.plain_text || rt.text?.content || '').join('');
}

function getPageTitle(page) {
  if (page.object === 'database') {
    return richTextToPlain(page.title) || 'Untitled';
  }
  const props = page.properties || {};
  for (const value of Object.values(props)) {
    if (value?.type === 'title') return richTextToPlain(value.title) || 'Untitled';
  }
  return 'Untitled';
}

function findTitlePropertyKey(properties = {}) {
  for (const [key, value] of Object.entries(properties)) {
    if (value?.type === 'title') return key;
  }
  return 'Name';
}

function contentToBlocks(content) {
  return String(content || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => ({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: line.slice(0, 2000) } }] }
    }));
}

async function findEntry(headers, query) {
  const resp = await axios.post(`${API}/search`, {
    query: query || undefined,
    page_size: query ? 5 : 1,
    sort: { direction: 'descending', timestamp: 'last_edited_time' }
  }, { headers, timeout: 15000 });
  return resp.data?.results || [];
}

async function execute(userId, action, params) {
  let token;
  try {
    token = await getAccessToken(userId);
  } catch (err) {
    return { success: false, error: err.message };
  }
  const headers = authHeaders(token);

  try {
    switch (action) {
      case 'search_notion': {
        const query = String(params?.query || '').trim();
        if (!query) return { success: false, error: 'search_notion requires a query' };
        const results = (await findEntry(headers, query)).map(item => ({
          title: getPageTitle(item),
          object: item.object,
          url: item.url,
          lastEdited: item.last_edited_time
        }));
        return {
          success: true,
          results,
          text: results.length
            ? `Found ${results.length} Notion result${results.length === 1 ? '' : 's'} for "${query}":\n${results.map((r, i) => `${i + 1}. ${r.title}`).join('\n')}`
            : `No Notion results for "${query}"`
        };
      }

      case 'create_notion_page': {
        const title = String(params?.title || '').trim();
        if (!title) return { success: false, error: 'create_notion_page requires a title' };

        const parentQuery = String(params?.parent_title || params?.parent || '').trim();
        const candidates = await findEntry(headers, parentQuery);
        const parentEntry = candidates.find(c => c.object === 'page' || c.object === 'database');
        if (!parentEntry) {
          return {
            success: false,
            error: parentQuery
              ? `No Notion page or database found matching "${parentQuery}". Share it with the Oxy integration from Notion's connection settings.`
              : 'No accessible Notion pages found. Share at least one page with the Oxy integration from Notion\'s connection settings.'
          };
        }

        const children = contentToBlocks(params?.content);
        let body;
        if (parentEntry.object === 'database') {
          const titleKey = findTitlePropertyKey(parentEntry.properties);
          body = {
            parent: { database_id: parentEntry.id },
            properties: { [titleKey]: { title: [{ text: { content: title } }] } }
          };
        } else {
          body = {
            parent: { page_id: parentEntry.id },
            properties: { title: { title: [{ text: { content: title } }] } }
          };
        }
        if (children.length) body.children = children;

        const resp = await axios.post(`${API}/pages`, body, { headers, timeout: 15000 });
        return { success: true, text: `Created Notion page "${title}"`, url: resp.data.url, pageId: resp.data.id };
      }

      case 'append_notion_page': {
        const content = String(params?.content || '').trim();
        if (!content) return { success: false, error: 'append_notion_page requires content' };

        const pageQuery = String(params?.page_title || params?.page || params?.title || '').trim();
        let pageId = params?.page_id;
        let pageTitle = pageQuery;
        if (!pageId) {
          if (!pageQuery) return { success: false, error: 'append_notion_page requires a page_title or page_id' };
          const candidates = await findEntry(headers, pageQuery);
          const page = candidates.find(c => c.object === 'page');
          if (!page) return { success: false, error: `No Notion page found matching "${pageQuery}"` };
          pageId = page.id;
          pageTitle = getPageTitle(page);
        }

        const children = contentToBlocks(content);
        if (!children.length) return { success: false, error: 'append_notion_page requires non-empty content' };

        const resp = await axios.patch(`${API}/blocks/${pageId}/children`, { children }, { headers, timeout: 15000 });
        return { success: true, text: `Added to Notion page "${pageTitle || pageId}"`, blockCount: resp.data?.results?.length || 0 };
      }

      default:
        return { success: false, error: `Unknown Notion action: ${action}` };
    }
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) {
      return { success: false, error: 'Notion not connected. Reconnect Notion from Settings.' };
    }
    const detail = err.response?.data?.message || err.message;
    return { success: false, error: `Notion API error: ${detail}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute, saveTokens, getTokens };

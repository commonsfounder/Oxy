const axios = require('axios');
const { createSupabaseServiceClient, logMissingRuntimeEnvOnce } = require('../runtime');
const { decryptTokens, encryptTokens } = require('../api/services/token-crypto');

const supabase = createSupabaseServiceClient();
logMissingRuntimeEnvOnce('github connector bootstrap');

const SUPPORTED_ACTIONS = ['search_github', 'get_github_notifications', 'create_github_issue', 'comment_github_issue'];

const API = 'https://api.github.com';

async function getTokens(userId) {
  try {
    const { data, error } = await supabase
      .from('connectors')
      .select('tokens')
      .eq('user_id', userId)
      .eq('connector_id', 'github')
      .eq('enabled', true)
      .limit(1);

    if (!error && data?.length > 0 && data[0].tokens) return decryptTokens(data[0].tokens);
  } catch (err) {
    console.error('[github getTokens] DB error:', err.message);
  }
  return {};
}

async function saveTokens(userId, tokens) {
  const { error } = await supabase
    .from('connectors')
    .upsert({ user_id: userId, connector_id: 'github', enabled: true, tokens: encryptTokens(tokens), updated_at: new Date().toISOString() },
             { onConflict: 'user_id,connector_id' });
  if (error) throw error;
}

// GitHub OAuth-App tokens do not expire and there is no refresh flow, so we just
// hand back the stored access token. A 401 from the API means the user revoked it.
async function getAccessToken(userId) {
  const tokens = await getTokens(userId);
  if (!tokens.access_token) {
    throw new Error('GitHub not connected. Connect GitHub from Settings.');
  }
  return tokens.access_token;
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Oxy'
  };
}

function splitRepo(repo) {
  const [owner, name] = String(repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').split('/');
  if (!owner || !name) return null;
  return { owner, name };
}

function summarizeIssue(item) {
  return {
    title: item.title,
    number: item.number,
    state: item.state,
    repo: item.repository_url ? item.repository_url.replace('https://api.github.com/repos/', '') : undefined,
    isPullRequest: Boolean(item.pull_request),
    url: item.html_url,
    updatedAt: item.updated_at
  };
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
      case 'search_github': {
        const query = String(params?.query || '').trim();
        if (!query) return { success: false, error: 'search_github requires a query' };
        const resp = await axios.get(`${API}/search/issues`, {
          headers,
          params: { q: query, per_page: 10, sort: 'updated', order: 'desc' },
          timeout: 15000
        });
        const items = (resp.data?.items || []).map(summarizeIssue);
        return {
          success: true,
          text: items.length ? `Found ${items.length} GitHub result${items.length === 1 ? '' : 's'}.` : 'No GitHub results.',
          results: items
        };
      }

      case 'get_github_notifications': {
        const resp = await axios.get(`${API}/notifications`, {
          headers,
          params: { per_page: 15, all: false },
          timeout: 15000
        });
        const notifications = (resp.data || []).map(n => ({
          reason: n.reason,
          title: n.subject?.title,
          type: n.subject?.type,
          repo: n.repository?.full_name,
          updatedAt: n.updated_at
        }));
        return {
          success: true,
          text: notifications.length ? `You have ${notifications.length} unread GitHub notification${notifications.length === 1 ? '' : 's'}.` : 'No unread GitHub notifications.',
          notifications
        };
      }

      case 'create_github_issue': {
        const repo = splitRepo(params?.repo);
        const title = String(params?.title || '').trim();
        if (!repo) return { success: false, error: 'create_github_issue requires repo as "owner/name"' };
        if (!title) return { success: false, error: 'create_github_issue requires a title' };
        const body = { title };
        if (params?.body) body.body = String(params.body);
        const resp = await axios.post(`${API}/repos/${repo.owner}/${repo.name}/issues`, body, { headers, timeout: 15000 });
        return {
          success: true,
          text: `Opened issue #${resp.data.number} in ${repo.owner}/${repo.name}.`,
          issueNumber: resp.data.number,
          url: resp.data.html_url
        };
      }

      case 'comment_github_issue': {
        const repo = splitRepo(params?.repo);
        const issueNumber = params?.issue_number;
        const body = String(params?.body || '').trim();
        if (!repo) return { success: false, error: 'comment_github_issue requires repo as "owner/name"' };
        if (!issueNumber) return { success: false, error: 'comment_github_issue requires issue_number' };
        if (!body) return { success: false, error: 'comment_github_issue requires a body' };
        const resp = await axios.post(`${API}/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments`,
          { body }, { headers, timeout: 15000 });
        return {
          success: true,
          text: `Commented on ${repo.owner}/${repo.name}#${issueNumber}.`,
          url: resp.data.html_url
        };
      }

      default:
        return { success: false, error: `Unknown GitHub action: ${action}` };
    }
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) {
      return { success: false, error: 'GitHub not connected. Reconnect GitHub from Settings.' };
    }
    const detail = err.response?.data?.message || err.message;
    return { success: false, error: `GitHub API error: ${detail}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute, saveTokens, getTokens };

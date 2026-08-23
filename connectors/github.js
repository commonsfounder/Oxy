const axios = require('axios');
const { createSupabaseServiceClient } = require('../runtime');
const { decryptTokens } = require('../api/services/token-crypto');

const supabase = createSupabaseServiceClient();

async function getGitHubToken(userId) {
  try {
    const { data } = await supabase.from('connectors')
      .select('tokens')
      .eq('user_id', userId)
      .eq('connector_id', 'github')
      .eq('enabled', true)
      .limit(1);
    if (data?.length > 0 && data[0].tokens) {
      const tokens = decryptTokens(data[0].tokens);
      return tokens.access_token || tokens.token || null;
    }
  } catch {}

  // A process-wide token is useful for local development only. Production execution must
  // belong to the user's connected GitHub account, otherwise the agent becomes a confused
  // deputy that can write to the operator's repository for any user.
  if (process.env.NODE_ENV !== 'production') return process.env.GITHUB_TOKEN || null;
  return null;
}

async function execute(userId, action, params) {
  const token = await getGitHubToken(userId);
  if (!token) {
    return {
      success: false,
      error: 'GitHub is not connected for this user.',
      recoveryAction: { type: 'open_connector_settings', connectorId: 'github' },
      webLink: `https://github.com/${params?.repo || ''}`
    };
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Oxy-Millie'
  };

  try {
    const repo = String(params?.repo || '').trim();
    if (!repo) return { success: false, error: 'repo required' };

    if (action === 'create_github_issue' || (action === 'github_action' && params?.action === 'create_issue')) {
      const title = params?.title || params?.content || 'Task from Assistant';
      const body = params?.body || params?.content || '';
      const res = await axios.post(`https://api.github.com/repos/${repo}/issues`, { title, body }, { headers });
      return { success: true, text: `Created issue: ${res.data.html_url}`, webLink: res.data.html_url };
    }

    if (action === 'get_github_prs') {
      const res = await axios.get(`https://api.github.com/repos/${repo}/pulls?state=open`, { headers });
      const prs = Array.isArray(res.data) ? res.data.slice(0, 20).map(p => ({
        number: p.number,
        title: String(p.title || '').slice(0, 180),
        url: p.html_url
      })) : [];
      return {
        success: true,
        text: `Open PRs in ${repo}: ${prs.length ? prs.map(p => p.title).join(', ') : 'none'}`,
        pullRequests: prs,
        webLink: `https://github.com/${repo}/pulls`
      };
    }

    if (action === 'github_action' && (!params?.action || params.action === 'status')) {
      const res = await axios.get(`https://api.github.com/repos/${repo}`, { headers });
      return {
        success: true,
        text: `${repo} is ${res.data.private ? 'private' : 'public'} with ${res.data.open_issues_count || 0} open issues.`,
        repository: {
          fullName: res.data.full_name,
          private: Boolean(res.data.private),
          defaultBranch: res.data.default_branch,
          openIssues: Number(res.data.open_issues_count || 0)
        },
        webLink: res.data.html_url || `https://github.com/${repo}`
      };
    }

    return { success: false, error: 'Unknown GitHub action' };
  } catch (e) {
    // Regression: this silently reported success even when the real GitHub API call threw
    // (bad token, repo not found, rate limit, network error) — the failure was invisible to
    // both the agent and the user.
    return { success: false, error: `GitHub error: ${e.response?.data?.message || e.message}`, webLink: `https://github.com/${params?.repo || ''}` };
  }
}

module.exports = { execute };

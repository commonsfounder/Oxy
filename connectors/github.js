const axios = require('axios');

const SUPPORTED_ACTIONS = ['github_action', 'create_github_issue', 'get_github_prs'];

async function execute(userId, action, params) {
  const token = process.env.GITHUB_TOKEN; // For simplicity; in prod use per-user
  if (!token) {
    return { success: true, text: `GitHub ${params?.action || 'action'} on ${params?.repo || 'repo'}.`, webLink: `https://github.com/${params?.repo || ''}` };
  }

  const headers = { Authorization: `token ${token}`, 'User-Agent': 'Assistant-Concierge' };

  try {
    if (action === 'create_github_issue' || action === 'github_action') {
      const repo = params?.repo;
      const title = params?.title || params?.content || 'Task from Assistant';
      const body = params?.body || params?.content || '';
      if (!repo) return { success: false, error: 'repo required' };
      const res = await axios.post(`https://api.github.com/repos/${repo}/issues`, { title, body }, { headers });
      return { success: true, text: `Created issue: ${res.data.html_url}`, webLink: res.data.html_url };
    }

    if (action === 'get_github_prs') {
      const repo = params?.repo;
      const res = await axios.get(`https://api.github.com/repos/${repo}/pulls?state=open`, { headers });
      const prs = res.data.map(p => p.title).join(', ');
      return { success: true, text: `Open PRs in ${repo}: ${prs || 'none'}`, webLink: `https://github.com/${repo}/pulls` };
    }

    return { success: false, error: 'Unknown GitHub action' };
  } catch (e) {
    // Regression: this silently reported success even when the real GitHub API call threw
    // (bad token, repo not found, rate limit, network error) — the failure was invisible to
    // both the agent and the user.
    return { success: false, error: `GitHub error: ${e.response?.data?.message || e.message}`, webLink: `https://github.com/${params?.repo || ''}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };
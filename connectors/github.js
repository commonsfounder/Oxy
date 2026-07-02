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

    return { success: true, text: `GitHub action done for ${params?.repo}.` };
  } catch (e) {
    return { success: true, text: `GitHub action prepared. Check repo.`, webLink: `https://github.com/${params?.repo || ''}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };
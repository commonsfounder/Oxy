const axios = require('axios');
const { createSupabaseServiceClient, logMissingRuntimeEnvOnce } = require('../runtime');
const { decryptTokens, encryptTokens } = require('../api/services/token-crypto');

const supabase = createSupabaseServiceClient();
logMissingRuntimeEnvOnce('linear connector bootstrap');

const SUPPORTED_ACTIONS = ['search_linear_issues', 'get_linear_issues', 'create_linear_issue', 'comment_linear_issue'];

const API = 'https://api.linear.app/graphql';

async function getTokens(userId) {
  try {
    const { data, error } = await supabase
      .from('connectors')
      .select('tokens')
      .eq('user_id', userId)
      .eq('connector_id', 'linear')
      .eq('enabled', true)
      .limit(1);

    if (!error && data?.length > 0 && data[0].tokens) return decryptTokens(data[0].tokens);
  } catch (err) {
    console.error('[linear getTokens] DB error:', err.message);
  }
  return {};
}

async function saveTokens(userId, tokens) {
  const { error } = await supabase
    .from('connectors')
    .upsert({ user_id: userId, connector_id: 'linear', enabled: true, tokens: encryptTokens(tokens), updated_at: new Date().toISOString() },
             { onConflict: 'user_id,connector_id' });
  if (error) throw error;
}

// Linear OAuth tokens are long-lived and do not have a refresh flow, so we just
// hand back the stored access token. A 401 from the API means it was revoked.
async function getAccessToken(userId) {
  const tokens = await getTokens(userId);
  if (!tokens.access_token) {
    throw new Error('Linear not connected. Connect Linear from Settings.');
  }
  return tokens.access_token;
}

async function linearGraphQL(userId, query, variables = {}) {
  const token = await getAccessToken(userId);
  let resp;
  try {
    resp = await axios.post(API, { query, variables }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
  } catch (err) {
    if (err.response?.status === 401) {
      throw new Error('Linear not connected. Reconnect Linear from Settings.');
    }
    throw new Error(err.response?.data?.errors?.[0]?.message || err.message);
  }
  if (resp.data.errors?.length) {
    throw new Error(resp.data.errors[0].message);
  }
  return resp.data.data;
}

function summarizeIssue(issue) {
  return {
    identifier: issue.identifier,
    title: issue.title,
    state: issue.state?.name,
    priority: issue.priority,
    url: issue.url
  };
}

async function resolveTeamId(userId, teamHint) {
  const data = await linearGraphQL(userId, `
    query {
      teams(first: 50) { nodes { id name key } }
    }
  `);
  const teams = data.teams?.nodes || [];
  if (!teams.length) return null;
  if (teamHint) {
    const hint = teamHint.toLowerCase();
    const match = teams.find(t => t.name.toLowerCase() === hint || t.key.toLowerCase() === hint)
      || teams.find(t => t.name.toLowerCase().includes(hint));
    if (match) return match.id;
    return null;
  }
  return teams[0].id;
}

async function execute(userId, action, params = {}) {
  try {
    switch (action) {
      case 'search_linear_issues': {
        const query = String(params?.query || '').trim();
        if (!query) return { success: false, error: 'search_linear_issues requires a query' };
        const data = await linearGraphQL(userId, `
          query($q: String!) {
            issues(filter: { title: { containsIgnoreCase: $q } }, first: 10) {
              nodes { identifier title url state { name } priority }
            }
          }
        `, { q: query });
        const issues = (data.issues?.nodes || []).map(summarizeIssue);
        return {
          success: true,
          text: issues.length ? `Found ${issues.length} Linear issue${issues.length === 1 ? '' : 's'}.` : `No Linear issues match "${query}".`,
          results: issues
        };
      }

      case 'get_linear_issues': {
        const data = await linearGraphQL(userId, `
          query {
            viewer {
              assignedIssues(first: 10, orderBy: updatedAt) {
                nodes { identifier title url state { name } priority }
              }
            }
          }
        `);
        const issues = (data.viewer?.assignedIssues?.nodes || []).map(summarizeIssue);
        return {
          success: true,
          text: issues.length ? `You have ${issues.length} assigned Linear issue${issues.length === 1 ? '' : 's'}.` : 'No Linear issues assigned to you.',
          results: issues
        };
      }

      case 'create_linear_issue': {
        const title = String(params?.title || '').trim();
        if (!title) return { success: false, error: 'create_linear_issue requires a title' };
        const teamId = await resolveTeamId(userId, params?.team);
        if (!teamId) return { success: false, error: params?.team ? `Couldn't find a Linear team named "${params.team}".` : 'No Linear team available.' };
        const input = { teamId, title };
        if (params?.description) input.description = String(params.description);
        const data = await linearGraphQL(userId, `
          mutation($input: IssueCreateInput!) {
            issueCreate(input: $input) {
              success
              issue { identifier url title }
            }
          }
        `, { input });
        if (!data.issueCreate?.success) return { success: false, error: 'Failed to create Linear issue.' };
        const issue = data.issueCreate.issue;
        return { success: true, text: `Created Linear issue ${issue.identifier}: ${issue.title}.`, url: issue.url, identifier: issue.identifier };
      }

      case 'comment_linear_issue': {
        const identifier = String(params?.issue || '').trim();
        const body = String(params?.body || '').trim();
        if (!identifier) return { success: false, error: 'comment_linear_issue requires an issue identifier (e.g. ENG-123)' };
        if (!body) return { success: false, error: 'comment_linear_issue requires a body' };
        // Resolve human identifier (e.g. "ENG-123") → internal UUID; commentCreate requires UUID.
        const resolveData = await linearGraphQL(userId, `
          query($id: String!) { issue(id: $id) { id } }
        `, { id: identifier });
        const issueUuid = resolveData.issue?.id;
        if (!issueUuid) return { success: false, error: `Issue ${identifier} not found in Linear.` };
        const data = await linearGraphQL(userId, `
          mutation($input: CommentCreateInput!) {
            commentCreate(input: $input) {
              success
              comment { url }
            }
          }
        `, { input: { issueId: issueUuid, body } });
        if (!data.commentCreate?.success) return { success: false, error: `Failed to comment on ${identifier}.` };
        return { success: true, text: `Commented on ${identifier}.`, url: data.commentCreate.comment?.url };
      }

      default:
        return { success: false, error: `Unknown Linear action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute, saveTokens, getTokens };

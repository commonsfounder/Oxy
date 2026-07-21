const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Regression: notion.js, github.js, and slack.js all had a catch block that
// silently reported success: true when the real API call threw — a real failure (bad token,
// missing resource, rate limit, network error) was invisible to both the agent and the user.
// slack.js additionally never checked Slack's own res.data.ok flag (Slack returns HTTP 200
// even on failure, with { ok: false, error } in the body).

const originalLoad = Module._load;

function withMockedAxios(axiosMock, fn) {
  Module._load = function mockAxios(request, parent, isMain) {
    if (request === 'axios') return axiosMock;
    if (request === '../runtime') {
      return {
        createSupabaseServiceClient: () => ({
          from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: [] }) }) }) }) }) })
        }),
        logMissingRuntimeEnvOnce: () => {}
      };
    }
    if (request === '../api/services/token-crypto') {
      return { decryptTokens: (t) => t, encryptTokens: (t) => t };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return fn();
  } finally {
    Module._load = originalLoad;
  }
}

test('notion connector reports failure when the real API call throws', async () => {
  process.env.NOTION_TOKEN = 'test-token';
  const notion = withMockedAxios(
    { post: async () => { throw new Error('request failed with status code 401'); }, get: async () => ({ data: {} }) },
    () => require('../../connectors/notion')
  );
  const result = await notion.execute('user-1', 'search_notes', { query: 'x' });
  assert.equal(result.success, false);
  assert.match(result.error, /401/);
  delete process.env.NOTION_TOKEN;
  delete require.cache[require.resolve('../../connectors/notion')];
});

test('github connector reports failure when the real API call throws', async () => {
  process.env.GITHUB_TOKEN = 'test-token';
  const github = withMockedAxios(
    { post: async () => { throw new Error('Not Found'); }, get: async () => ({ data: {} }) },
    () => require('../../connectors/github')
  );
  const result = await github.execute('user-1', 'create_github_issue', { repo: 'a/b', title: 't' });
  assert.equal(result.success, false);
  assert.match(result.error, /Not Found/);
  delete process.env.GITHUB_TOKEN;
  delete require.cache[require.resolve('../../connectors/github')];
});

test('github connector reports failure for an unrecognized action instead of fabricating success', async () => {
  process.env.GITHUB_TOKEN = 'test-token';
  const github = withMockedAxios(
    { post: async () => ({ data: {} }), get: async () => ({ data: {} }) },
    () => require('../../connectors/github')
  );
  const result = await github.execute('user-1', 'not_a_real_action', {});
  assert.equal(result.success, false);
  delete process.env.GITHUB_TOKEN;
  delete require.cache[require.resolve('../../connectors/github')];
});

test('slack connector reports failure when Slack returns HTTP 200 with ok:false', async () => {
  process.env.SLACK_BOT_TOKEN = 'test-token';
  const slack = withMockedAxios(
    { post: async () => ({ data: { ok: false, error: 'channel_not_found' } }), get: async () => ({ data: { ok: false, error: 'invalid_auth' } }) },
    () => require('../../connectors/slack')
  );
  const result = await slack.execute('user-1', 'send_slack_message', { channel: '#nope', message: 'hi' });
  assert.equal(result.success, false);
  assert.match(result.error, /channel_not_found/);
  delete process.env.SLACK_BOT_TOKEN;
  delete require.cache[require.resolve('../../connectors/slack')];
});

test('slack connector reports failure when the real API call throws', async () => {
  process.env.SLACK_BOT_TOKEN = 'test-token';
  const slack = withMockedAxios(
    { post: async () => { throw new Error('socket hang up'); }, get: async () => ({ data: {} }) },
    () => require('../../connectors/slack')
  );
  const result = await slack.execute('user-1', 'send_slack_message', { channel: '#general', message: 'hi' });
  assert.equal(result.success, false);
  assert.match(result.error, /socket hang up/);
  delete process.env.SLACK_BOT_TOKEN;
  delete require.cache[require.resolve('../../connectors/slack')];
});


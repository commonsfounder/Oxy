const assert = require('node:assert/strict');
const test = require('node:test');
const { createComposio } = require('../../api/services/composio');
const connector = require('../../connectors/composio');

function fake(responses = {}) {
  const calls = [];
  const http = async (method, path, opts) => { calls.push({ method, path, ...opts }); const r = responses[`${method} ${path}`]; return typeof r === 'function' ? r(opts) : r; };
  return { http, calls };
}

test('without a key the catalogue is unavailable and nothing is sent', async () => {
  const { http, calls } = fake();
  const c = createComposio({ env: {}, http });
  assert.equal(c.configured, false);
  await assert.rejects(c.startConnection('u1', 'linear'), /not set up/);
  assert.equal((await connector.execute('u1', 'connected_app_read', { tool: 'LINEAR_LIST_ISSUES' }, c)).unavailable, true);
  assert.equal(calls.length, 0);
});

test('connecting an app creates a managed sign-in once and returns the page to open', async () => {
  const { http, calls } = fake({
    'POST /auth_configs': { auth_config: { id: 'ac_1' } },
    'POST /connected_accounts/link': { redirect_url: 'https://connect.example/x', connected_account_id: 'ca_1' }
  });
  const c = createComposio({ env: { COMPOSIO_API_KEY: 'k' }, http });
  const first = await c.startConnection('u1', 'Linear');
  assert.equal(first.redirectUrl, 'https://connect.example/x');
  await c.startConnection('u2', 'linear');
  assert.equal(calls.filter(x => x.path === '/auth_configs').length, 1);
  assert.deepEqual(calls[1].body, { auth_config_id: 'ac_1', user_id: 'u1' });
  await assert.rejects(c.startConnection('u1', '../etc'), /Pick an app/);
});

test('connections list reports which apps are signed in', async () => {
  const { http } = fake({ 'GET /connected_accounts': { items: [{ id: 'a', status: 'ACTIVE', toolkit: { slug: 'linear' } }, { id: 'b', status: 'INITIATED', toolkit: { slug: 'asana' } }] } });
  const out = await createComposio({ env: { COMPOSIO_API_KEY: 'k' }, http }).listConnections('u1');
  assert.deepEqual(out.map(x => [x.toolkit, x.connected]), [['linear', true], ['asana', false]]);
});

test('the read action refuses tools that change things; the act action runs them', async () => {
  const { http, calls } = fake({ 'POST /tools/execute/LINEAR_CREATE_ISSUE': { successful: true, data: { id: 1 } }, 'POST /tools/execute/LINEAR_LIST_ISSUES': { successful: true, data: [] } });
  const c = createComposio({ env: { COMPOSIO_API_KEY: 'k' }, http });
  const refused = await connector.execute('u1', 'connected_app_read', { tool: 'LINEAR_CREATE_ISSUE' }, c);
  assert.equal(refused.success, false);
  assert.equal(calls.length, 0);
  assert.equal((await connector.execute('u1', 'connected_app_read', { tool: 'LINEAR_LIST_ISSUES' }, c)).success, true);
  assert.equal((await connector.execute('u1', 'connected_app_act', { tool: 'LINEAR_CREATE_ISSUE', arguments: { title: 't' } }, c)).success, true);
  assert.equal(calls.at(-1).body.user_id, 'u1');
});

test('a tool name that is not a plain slug is rejected before any request', async () => {
  const { http, calls } = fake();
  const c = createComposio({ env: { COMPOSIO_API_KEY: 'k' }, http });
  const out = await connector.execute('u1', 'connected_app_act', { tool: '../admin' }, c);
  assert.equal(out.success, false);
  assert.equal(calls.length, 0);
});

test('a failed app call is reported as failed, not success', async () => {
  const { http } = fake({ 'POST /tools/execute/ASANA_GET_TASK': { successful: false, data: null, error: 'not found' } });
  const out = await connector.execute('u1', 'connected_app_read', { tool: 'ASANA_GET_TASK' }, createComposio({ env: { COMPOSIO_API_KEY: 'k' }, http }));
  assert.equal(out.success, false);
  assert.match(out.error, /not found/);
});

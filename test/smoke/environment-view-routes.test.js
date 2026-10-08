const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_KEY ||= 'test-key';
process.env.OXY_SESSION_SECRET ||= 'test-session-secret';
const app = require('../../api/index');
const { createSessionToken } = require('../../auth');
const sessions = require('../../api/services/browser-session');
let server;

test.before(async () => { server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); }); });
test.after(async () => { sessions._liveSessions.clear(); await new Promise(resolve => server.close(resolve)); });

function get(path, owner) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: server.address().port, path,
      headers: owner ? { authorization: `Bearer ${createSessionToken(owner)}` } : {} }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }));
    }); req.on('error', reject);
  });
}

test('the observer route requires sign-in and does not trust a requested user identity', async () => {
  sessions.createSession('owner', { browser: { isConnected: () => true, close: async () => {} },
    page: { isClosed: () => false, locator: () => ({}), screenshot: async () => Buffer.from('actual-capture'), url: () => 'https://example.com', title: async () => 'Example' } });
  assert.equal((await get('/agent/environment')).status, 401);
  const foreign = await get('/agent/environment?userId=owner', 'other');
  assert.equal(foreign.status, 200);
  assert.equal(foreign.body.state, 'disconnected');
  assert.equal(foreign.body.frame, null);
  const own = await get('/agent/environment?userId=other', 'owner');
  assert.equal(own.body.state, 'live');
  assert.equal(own.headers['cache-control'], 'no-store');
  assert.equal(Buffer.from(own.body.frame.data, 'base64').toString(), 'actual-capture');
});

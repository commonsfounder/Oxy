const test = require('node:test');
const assert = require('node:assert/strict');
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_KEY ||= 'test-key';
process.env.OXY_SESSION_SECRET ||= 'test-session-secret';
const app = require('../../api/index');
const { createSessionToken } = require('../../auth');
const sandboxes = require('../../api/services/browser-sandbox');
let server;
let base;

test.before(async () => {
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { sandboxes._entries.clear(); await new Promise((resolve) => server.close(resolve)); });

test('opening the live browser needs sign-in and a running sandbox browser', async () => {
  const anonymous = await fetch(`${base}/agent/browser/live`, { method: 'POST' });
  assert.equal(anonymous.status, 401);
  const headers = { authorization: `Bearer ${createSessionToken('owner')}` };
  assert.equal((await fetch(`${base}/agent/browser/live`, { method: 'POST', headers })).status, 404);

  sandboxes._entries.set('owner', { sandbox: { getHost: (p) => `h:${p}` }, sandboxId: 's' });
  const res = await fetch(`${base}/agent/browser/live`, { method: 'POST', headers });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const { url, expiresInSeconds } = await res.json();
  assert.match(url, /^\/agent\/browser\/live\//);
  assert.equal(expiresInSeconds, 600);
});

test('live view pages refuse a missing or forged link', async () => {
  assert.equal((await fetch(`${base}/agent/browser/live/not-a-token/vnc.html`)).status, 404);
});

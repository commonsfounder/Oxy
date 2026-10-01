// The home view reads this route; it must be private and must report unknown as unknown.

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
process.env.OXY_SESSION_SECRET = process.env.OXY_SESSION_SECRET || 'test-session-secret';

const app = require('../../api/index');
const { createSessionToken } = require('../../auth');

function withServer(fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      try { resolve(await fn(`http://127.0.0.1:${port}`)); } catch (err) { reject(err); } finally { server.close(); }
    });
  });
}

test('household needs a signed-in user', async () => {
  await withServer(async base => {
    const res = await fetch(`${base}/agent/household`);
    assert.equal(res.status, 401);
  });
});

test('with nothing known, presence is unknown and the lists are empty', async () => {
  const realFetch = global.fetch;
  global.fetch = async (input, init) => {
    const url = String(input?.url || input);
    if (url.startsWith(process.env.SUPABASE_URL)) {
      const single = (init?.headers && JSON.stringify(init.headers).includes('vnd.pgrst.object'));
      return new Response(single ? 'null' : '[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  };
  try {
    await withServer(async base => {
      const token = createSessionToken('home-user', 0);
      const res = await fetch(`${base}/agent/household`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.presence.state, 'unknown');
      assert.deepEqual(body.people, []);
      assert.deepEqual(body.openCommitments, []);
      assert.deepEqual(body.activePlans, []);
    });
  } finally {
    global.fetch = realFetch;
  }
});

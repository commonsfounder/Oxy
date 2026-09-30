// "Stop" has to be a real control: the route exists, needs a signed-in user, and does not
// pretend to have stopped something it cannot find.

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
      try {
        resolve(await fn(`http://127.0.0.1:${port}`));
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

test('stopping a task needs a signed-in user', async () => {
  await withServer(async baseURL => {
    const res = await fetch(`${baseURL}/agent/tasks/task-1/stop`, { method: 'POST' });
    assert.equal(res.status, 401);
  });
});

test('stopping a task that does not exist is not reported as stopped', async () => {
  const realFetch = global.fetch;
  global.fetch = async (input, init) => {
    const url = String(input?.url || input);
    if (url.startsWith(process.env.SUPABASE_URL)) {
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  };
  try {
    await withServer(async baseURL => {
      const token = createSessionToken('stop-user', 0);
      const res = await fetch(`${baseURL}/agent/tasks/missing/stop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.notEqual(body.cancelled, true);
    });
  } finally {
    global.fetch = realFetch;
  }
});

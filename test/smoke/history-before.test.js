// The single thread scrolls back through everything ever said, so /history must be able to page
// backwards: `before` returns only messages older than the timestamp the app already shows.

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

test('/history/:userId passes `before` to the conversations query', async () => {
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (input, init) => {
    const url = String(input?.url || input);
    if (url.startsWith(process.env.SUPABASE_URL)) {
      seen.push(url);
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  };
  try {
    await withServer(async baseURL => {
      const token = createSessionToken('history-user', 0);
      const before = '2026-09-01T10:00:00.000Z';
      const res = await fetch(`${baseURL}/history/history-user?limit=50&before=${encodeURIComponent(before)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(res.status, 200);
      const conversationCalls = seen.filter(url => url.includes('/rest/v1/conversations'));
      assert.ok(conversationCalls.length > 0, 'expected a conversations query');
      const decoded = decodeURIComponent(conversationCalls[0]);
      assert.match(decoded, /created_at=lt\.2026-09-01T10:00:00\.000Z/);
    });
  } finally {
    global.fetch = realFetch;
  }
});

test('/history/:userId ignores an unparseable `before` instead of failing', async () => {
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (input, init) => {
    const url = String(input?.url || input);
    if (url.startsWith(process.env.SUPABASE_URL)) {
      seen.push(url);
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  };
  try {
    await withServer(async baseURL => {
      const token = createSessionToken('history-user', 0);
      const res = await fetch(`${baseURL}/history/history-user?before=not-a-date`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(res.status, 200);
      const conversationCalls = seen.filter(url => url.includes('/rest/v1/conversations'));
      assert.ok(!decodeURIComponent(conversationCalls[0] || '').includes('created_at=lt.'));
    });
  } finally {
    global.fetch = realFetch;
  }
});

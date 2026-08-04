const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
process.env.OXY_SESSION_SECRET = process.env.OXY_SESSION_SECRET || 'test-secret';

const app = require('../../api');

/*
 * The continuity endpoints take a whole vendor export, so they carry a much larger body
 * limit than the rest of the API. body-parser marks a request as read once it runs, which
 * means a default-limit parser mounted in front would 413 the upload before the larger one
 * ever saw it — the global parser has to SKIP these paths, not run first.
 *
 * These assertions go through the real app over a real socket, because the failure being
 * guarded against is entirely a middleware-ordering effect.
 */
function post(server, path, body) {
  const payload = Buffer.from(JSON.stringify(body));
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length } },
      (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function withServer(run) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ~4MB: far past the default body-parser limit, well inside the continuity limit.
const BIG = { zipBase64: 'A'.repeat(4 * 1024 * 1024) };

test('an ordinary route still rejects an oversized body', async () => {
  await withServer(async (server) => {
    const res = await post(server, '/chat', BIG);
    assert.equal(res.status, 413, `expected the default limit to reject this, got ${res.status}`);
  });
});

test('a continuity route is not 413d by the default parser in front of it', async () => {
  await withServer(async (server) => {
    for (const path of ['/agent/continuity/preview', '/agent/continuity/import']) {
      const res = await post(server, path, BIG);
      assert.notEqual(res.status, 413, `${path} was rejected by the default body limit`);
      // Unauthenticated, so it stops at the session check — which is the right order:
      // a 12MB body should never be parsed for a caller that has not authenticated.
      assert.equal(res.status, 401, `${path} returned ${res.status}`);
    }
  });
});

test('ordinary routes still parse normal JSON bodies', async () => {
  await withServer(async (server) => {
    const res = await post(server, '/chat', { message: 'hello' });
    assert.notEqual(res.status, 413);
    assert.notEqual(res.status, 500, 'a normal body must still reach the handler parsed');
  });
});

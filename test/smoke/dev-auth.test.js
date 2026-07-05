const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';
process.env.OXY_SESSION_SECRET = process.env.OXY_SESSION_SECRET || 'test-session-secret';

const app = require('../../api/index');
const { verifySignedPayload } = require('../../auth');

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

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

test('dev demo auth is unavailable when the explicit dev flag is off', async () => {
  const originalFlag = process.env.OXY_ENABLE_DEV_AUTH;
  const originalNodeEnv = process.env.NODE_ENV;
  delete process.env.OXY_ENABLE_DEV_AUTH;
  process.env.NODE_ENV = 'development';

  await withServer(async baseURL => {
    const res = await fetch(`${baseURL}/auth/dev/demo-login`, { method: 'POST' });
    assert.equal(res.status, 404);
  });

  restoreEnv('OXY_ENABLE_DEV_AUTH', originalFlag);
  restoreEnv('NODE_ENV', originalNodeEnv);
});

test('dev demo auth returns a signed deterministic demo session when enabled', async () => {
  const originalFlag = process.env.OXY_ENABLE_DEV_AUTH;
  const originalSeedFlag = process.env.OXY_DEV_AUTH_SEED_USER;
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.OXY_ENABLE_DEV_AUTH = 'true';
  delete process.env.OXY_DEV_AUTH_SEED_USER;
  process.env.NODE_ENV = 'development';

  await withServer(async baseURL => {
    const res = await fetch(`${baseURL}/auth/dev/demo-login`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.demo, true);
    assert.equal(body.userId, 'demo-test-user');
    assert.equal(typeof body.token, 'string');

    const payload = verifySignedPayload(body.token);
    assert.equal(payload.type, 'session');
    assert.equal(payload.userId, 'demo-test-user');
    assert.equal(payload.tokenVersion, undefined);
  });

  restoreEnv('OXY_ENABLE_DEV_AUTH', originalFlag);
  restoreEnv('OXY_DEV_AUTH_SEED_USER', originalSeedFlag);
  restoreEnv('NODE_ENV', originalNodeEnv);
});

test('dev demo auth stays unavailable in production even if the flag is set', async () => {
  const originalFlag = process.env.OXY_ENABLE_DEV_AUTH;
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.OXY_ENABLE_DEV_AUTH = 'true';
  process.env.NODE_ENV = 'production';

  await withServer(async baseURL => {
    const res = await fetch(`${baseURL}/auth/dev/demo-login`, { method: 'POST' });
    assert.equal(res.status, 404);
  });

  restoreEnv('OXY_ENABLE_DEV_AUTH', originalFlag);
  restoreEnv('NODE_ENV', originalNodeEnv);
});

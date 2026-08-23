// /health is what proves — cheaply, without a live probe of any third party — whether the
// deployed service has the configuration it needs. It has to stay fast and independent of
// external uptime (a Gmail outage must never turn into a Fly.io restart signal), so this
// only checks configuration PRESENCE, never live reachability.

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
process.env.OXY_SESSION_SECRET = process.env.OXY_SESSION_SECRET || 'test-session-secret';

const app = require('../../api/index');

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

test('/health reports connector configuration without ever calling out to them', async () => {
  await withServer(async baseURL => {
    const res = await fetch(`${baseURL}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.connectors, 'missing connectors section');
    assert.equal(typeof body.connectors.google.configured, 'boolean');
    assert.equal(typeof body.connectors.telegram.configured, 'boolean');
    assert.equal(typeof body.connectors.travel.configured, 'boolean');
    assert.ok(Array.isArray(body.notifications.channelsConfigured));
    assert.ok(Array.isArray(body.notifications.unavailable));
  });
});

test('/health never includes a secret value, only booleans and reasons', async () => {
  const originalGmailSecret = process.env.GMAIL_CLIENT_SECRET;
  process.env.GMAIL_CLIENT_SECRET = 'super-secret-value-should-never-leak';
  process.env.GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID || 'test-client-id';
  try {
    await withServer(async baseURL => {
      const res = await fetch(`${baseURL}/health`);
      const raw = await res.text();
      assert.equal(raw.includes('super-secret-value-should-never-leak'), false);
      const body = JSON.parse(raw);
      assert.equal(body.connectors.google.configured, true);
    });
  } finally {
    if (originalGmailSecret === undefined) delete process.env.GMAIL_CLIENT_SECRET;
    else process.env.GMAIL_CLIENT_SECRET = originalGmailSecret;
  }
});

test('/health reflects missing Google/Telegram configuration honestly', async () => {
  const saved = {
    GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET,
    TELEGRAM_API_ID: process.env.TELEGRAM_API_ID, TELEGRAM_API_HASH: process.env.TELEGRAM_API_HASH
  };
  delete process.env.GMAIL_CLIENT_ID; delete process.env.GMAIL_CLIENT_SECRET;
  delete process.env.TELEGRAM_API_ID; delete process.env.TELEGRAM_API_HASH;
  try {
    await withServer(async baseURL => {
      const res = await fetch(`${baseURL}/health`);
      const body = await res.json();
      assert.equal(body.connectors.google.configured, false);
      assert.equal(body.connectors.telegram.configured, false);
      assert.equal(body.notifications.channelsConfigured.includes('telegram'), false);
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('/version stays the lightweight standalone endpoint it always was', async () => {
  await withServer(async baseURL => {
    const res = await fetch(`${baseURL}/version`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.app, 'oxy');
  });
});

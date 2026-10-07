const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
process.env.OXY_SESSION_SECRET ||= 'test-session-secret';
process.env.OXY_BROWSER_WARM_POOL = 'false'; // a spare Chromium would keep the test process alive
const sandboxes = require('../../api/services/browser-sandbox');
const liveView = require('../../api/services/browser-live-view');
const sessions = require('../../api/services/browser-session');

const CDP = 9433;
let chrome;

// A fake of the slice of the E2B SDK this code uses, backed by a real Chromium on loopback.
function fakeSdk({ existing = [] } = {}) {
  const calls = { create: [], connect: [], pause: [], kill: [], list: 0 };
  const box = (id) => ({ sandboxId: id, trafficAccessToken: 'tok', getHost: (p) => `127.0.0.1:${p}`, commands: { run: async () => { calls.ran = (calls.ran || 0) + 1; } } });
  const sdk = {
    calls,
    list: () => { calls.list += 1; return { hasNext: false, nextItems: async () => existing }; },
    create: async (template, opts) => { calls.create.push({ template, opts }); return box('sbx-new'); },
    connect: async (id, opts) => { calls.connect.push({ id, opts }); return box(id); },
    pause: async (id) => { calls.pause.push(id); return true; },
    kill: async (id) => { calls.kill.push(id); return true; },
  };
  return sdk;
}

test.before(async () => {
  chrome = await chromium.launch({ args: [`--remote-debugging-port=${CDP}`] });
  sandboxes._setEndpoint((_, port) => (port === sandboxes.CDP_PORT ? `http://127.0.0.1:${CDP}` : `http://127.0.0.1:${port}`));
});
test.after(async () => { await chrome.close(); });
test.afterEach(() => {
  for (const entry of sandboxes._entries.values()) clearTimeout(entry.pauseTimer);
  sandboxes._entries.clear();
  delete process.env.OXY_E2B_PAUSE_DELAY_MS;
});

test('a new user gets a sandbox with an opaque tag, a pause-on-timeout lifecycle and private URLs', async () => {
  const sdk = fakeSdk();
  sandboxes._setSdk(sdk);
  const got = await sandboxes.acquire('user-a@example.com');
  assert.equal(got.backend, 'e2b');
  assert.equal(sdk.calls.create.length, 1);
  const { template, opts } = sdk.calls.create[0];
  assert.equal(template, 'oxy-browser');
  assert.deepEqual(opts.lifecycle, { onTimeout: 'pause' });
  assert.equal(opts.network.allowPublicTraffic, false);
  assert.ok(!JSON.stringify(opts).includes('user-a@example.com'), 'the user id must not reach E2B');
  assert.equal(opts.metadata.user, sandboxes.userTag('user-a@example.com'));
  await got.browser.close();
});

test('the sandbox browser is driven over CDP and exposes its persistent profile context', async () => {
  sandboxes._setSdk(fakeSdk());
  const got = await sandboxes.acquire('user-b');
  assert.ok(got.browser.isConnected());
  assert.ok(got.persistentContext, 'the profile context is returned');
  const page = await got.persistentContext.newPage();
  await page.setContent('<title>sandboxed</title><button>go</button>');
  assert.equal(await page.title(), 'sandboxed');
  await page.close();
  await got.browser.close();
});

test('a returning user resumes their existing sandbox instead of creating another', async () => {
  const sdk = fakeSdk({ existing: [{ sandboxId: 'sbx-old', startedAt: new Date('2026-01-01'), state: 'paused' }] });
  sandboxes._setSdk(sdk);
  const got = await sandboxes.acquire('user-c');
  assert.equal(sdk.calls.create.length, 0);
  assert.equal(sdk.calls.connect[0].id, 'sbx-old');
  assert.equal(got.sandboxId, 'sbx-old');
  await got.browser.close();
});

test('concurrent opens for one user share a single boot', async () => {
  const sdk = fakeSdk();
  sandboxes._setSdk(sdk);
  const [one, two] = await Promise.all([sandboxes.acquire('user-d'), sandboxes.acquire('user-d')]);
  assert.equal(sdk.calls.create.length, 1);
  assert.equal(one, two);
  await one.browser.close();
});

test('release pauses after the delay, and reacquiring inside the delay cancels the pause', async () => {
  process.env.OXY_E2B_PAUSE_DELAY_MS = '80';
  const sdk = fakeSdk();
  sandboxes._setSdk(sdk);
  const first = await sandboxes.acquire('user-e');
  await first.browser.close();
  first.release();
  const again = await sandboxes.acquire('user-e');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(sdk.calls.pause, [], 'an active user is never paused');
  await again.browser.close();
  again.release();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(sdk.calls.pause, ['sbx-new']);
});

test('deleting an account kills every sandbox that belongs to the user', async () => {
  const sdk = fakeSdk({ existing: [{ sandboxId: 'sbx-1' }, { sandboxId: 'sbx-2' }] });
  sandboxes._setSdk(sdk);
  const result = await sandboxes.destroyForUser('user-f');
  assert.equal(result.destroyed, 2);
  assert.deepEqual(sdk.calls.kill.sort(), ['sbx-1', 'sbx-2']);
});

test('closing a session releases its sandbox; a failed sandbox falls back to local unless strict', async () => {
  let released = 0;
  sessions.createSession('user-g', { browser: { isConnected: () => true, close: async () => {} }, page: {}, release: () => { released += 1; } });
  await sessions.closeSession('user-g');
  assert.equal(released, 1);

  const prior = { ...process.env };
  process.env.OXY_BROWSER_BACKEND = 'e2b';
  process.env.E2B_API_KEY = 'test';
  sandboxes._setSdk({ list: () => { throw new Error('E2B unreachable'); } });
  try {
    process.env.OXY_BROWSER_BACKEND_STRICT = '1';
    await assert.rejects(() => sessions.acquireBrowser('user-h'), /E2B unreachable/);
    delete process.env.OXY_BROWSER_BACKEND_STRICT;
    const local = await sessions.acquireBrowser('user-h');
    assert.equal(local.backend, 'local');
    await local.browser.close();
    await sessions.closeWarmPool();
  } finally {
    for (const key of ['OXY_BROWSER_BACKEND', 'E2B_API_KEY', 'OXY_BROWSER_BACKEND_STRICT']) {
      if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
    }
  }
});

test('live-view links are signed, expire, and only exist while a sandbox browser does', () => {
  assert.equal(liveView.createLink('nobody'), null);
  const token = liveView.issueToken('owner', 1000);
  assert.equal(liveView.verifyToken(token, 2000), 'owner');
  assert.equal(liveView.verifyToken(token, 1000 + 11 * 60 * 1000), null, 'expired');
  const [body, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ u: 'victim', e: 9e15 })).toString('base64url');
  assert.equal(liveView.verifyToken(`${forged}.${mac}`, 2000), null);
  assert.equal(liveView.verifyToken(`${body}.x`, 2000), null);
  assert.equal(liveView.verifyToken('garbage', 2000), null);

  sandboxes._entries.set('owner', { sandbox: { getHost: (p) => `h:${p}`, trafficAccessToken: 't' }, sandboxId: 's' });
  const link = liveView.createLink('owner');
  assert.match(link.url, /^\/agent\/browser\/live\/[^/]+\/vnc\.html\?/);
  assert.ok(link.url.includes(encodeURIComponent('agent/browser/live/')));
});

test('the browser primitives work end to end on a sandbox browser, and closing lets the sandbox pause', async () => {
  process.env.OXY_E2B_PAUSE_DELAY_MS = '50';
  process.env.SUPABASE_URL ||= 'http://127.0.0.1:1';
  process.env.SUPABASE_KEY ||= 'test-key';
  const http = require('node:http');
  const site = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/next'
      ? '<title>Next</title><h1>Arrived</h1>'
      : '<title>Start</title><h1>Start</h1><a href="/next">Read more</a><button id="x">Press</button>');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const prior = { backend: process.env.OXY_BROWSER_BACKEND, key: process.env.E2B_API_KEY };
  process.env.OXY_BROWSER_BACKEND = 'e2b';
  process.env.E2B_API_KEY = 'test';
  const sdk = fakeSdk();
  sandboxes._setSdk(sdk);
  const env = require('../../api/services/browser-environment');
  try {
    const opened = await env.open('user-e2e', { url: `http://127.0.0.1:${site.address().port}/` });
    assert.equal(sessions.getSession('user-e2e').release instanceof Function, true);
    const link = opened.elements.find((el) => /Read more/.test(el.text));
    assert.ok(link, 'the page was perceived through the sandbox browser');
    await env.act('user-e2e', { action: 'click', elementId: link.id });
    assert.match((await env.observe('user-e2e')).url, /\/next$/);
    await env.close('user-e2e');
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(sdk.calls.pause, ['sbx-new']);
  } finally {
    await sessions.closeSession('user-e2e');
    site.close();
    for (const [key, value] of [['OXY_BROWSER_BACKEND', prior.backend], ['E2B_API_KEY', prior.key]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('the live view proxies pages and the VNC socket for the owner only, adding the sandbox token', async () => {
  const http = require('node:http');
  const { WebSocketServer } = require('ws');
  const seen = { headers: null };
  const upstream = http.createServer((req, res) => { seen.headers = req.headers; res.setHeader('content-type', 'text/html'); res.end(`<p>viewer ${req.url}</p>`); });
  const upstreamWs = new WebSocketServer({ server: upstream });
  upstreamWs.on('connection', (socket) => socket.on('message', (data) => socket.send(`echo:${data}`)));
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const viewPort = upstream.address().port;
  sandboxes._setEndpoint((_, port) => `http://127.0.0.1:${port === sandboxes.VIEW_PORT ? viewPort : port}`);
  sandboxes._entries.set('owner', { sandbox: { getHost: () => 'unused', trafficAccessToken: 'sandbox-secret' }, sandboxId: 's' });

  const front = http.createServer((req, res) => { req.originalUrl = req.url; liveView.proxyHttp(req, { status: (c) => { res.statusCode = c; return res; }, setHeader: (k, v) => res.setHeader(k, v), end: (b) => res.end(b) }); });
  front.on('upgrade', (req, socket, head) => { if (!liveView.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${front.address().port}`;
  try {
    const token = liveView.issueToken('owner');
    const ok = await fetch(`${base}/agent/browser/live/${token}/vnc.html?x=1`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '<p>viewer /vnc.html?x=1</p>');
    assert.equal(seen.headers['e2b-traffic-access-token'], 'sandbox-secret');
    assert.equal((await fetch(`${base}/agent/browser/live/${token}x/vnc.html`)).status, 404);
    const stranger = liveView.issueToken('someone-else');
    assert.equal((await fetch(`${base}/agent/browser/live/${stranger}/vnc.html`)).status, 404);

    const { WebSocket } = require('ws');
    const echoed = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`${base.replace('http', 'ws')}/agent/browser/live/${token}/websockify`, ['binary']);
      socket.on('open', () => socket.send('hello'));
      socket.on('message', (data) => { socket.close(); resolve(String(data)); });
      socket.on('error', reject);
    });
    assert.equal(echoed, 'echo:hello');
    const rejected = await new Promise((resolve) => {
      const socket = new WebSocket(`${base.replace('http', 'ws')}/agent/browser/live/${stranger}/websockify`);
      socket.on('open', () => resolve('opened'));
      socket.on('error', () => resolve('rejected'));
    });
    assert.equal(rejected, 'rejected');
  } finally {
    front.close(); upstream.close(); upstreamWs.close();
  }
});

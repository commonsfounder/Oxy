'use strict';

// Local observer proof with a real browser and authenticated HTTP reads. No external task runs.
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_KEY = 'local-test-key';
process.env.OXY_SESSION_SECRET = 'local-observer-test-secret';
const app = require('../../api/index');
const { createSessionToken } = require('../../auth');
const browserSessions = require('../../api/services/browser-session');

async function main() {
  const out = process.argv[2] || '/private/tmp/adam-environment-view';
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  let server;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.setContent('<!doctype html><html><head><title>Observer verification</title><style>body{margin:60px;font:24px system-ui;color:#101721;background:#f6f9fd}h1{font-size:40px}button,input{font:inherit;padding:16px;margin:20px 0}output{font-size:60px;display:block}</style></head><body><h1>Observer verification</h1><p>Local test page · no external task</p><output id="state">Before the action</output><button onclick="document.getElementById(\'state\').textContent=\'After the action\'">Change state</button><p><input type="password" value="never-visible-secret"></p></body></html>');
    browserSessions.createSession('viewer-demo', { browser, context, page, agentTaskId: 'test-task' });
    const task = { id: 'test-task', goal: 'Local observer verification', status: 'running', results: [], metadata: {} };
    const serverApp = require('express')();
    serverApp.post('/__observer-test/change', async (_req, res) => {
      await page.locator('#state').evaluate(node => { node.textContent = 'Visible update'; });
      res.json({ updated: true });
    });
    serverApp.use((req, _res, next) => {
      if (process.env.OXY_OBSERVER_PREVIEW === '1') req.headers.authorization = `Bearer ${createSessionToken('viewer-demo')}`;
      next();
    });
    serverApp.get('/agent/tasks', (_req, res) => res.json({ tasks: [task] }));
    serverApp.get('/agent/tasks/test-task', (_req, res) => res.json({ task }));
    serverApp.get('/agent/tasks/test-task/environment', async (_req, res) => res.json(await require('../../api/services/environment-view').getEnvironmentView('viewer-demo', { taskId: 'test-task' })));
    serverApp.get('/agent/state', (_req, res) => res.json({ handling: [{ id: 'local-task', kind: 'task', taskId: 'test-task', title: 'Local observer verification' }], needsYou: [], changed: [], completed: [], counts: { needsYou: 0, handling: 1, changed: 0, completed: 0 }, generatedAt: new Date().toISOString(), lastSeenAt: null }));
    serverApp.get('/agent/displays', (_req, res) => res.json({ displays: [] }));
    serverApp.get('/agent/tasks/test-task/runtime', (_req, res) => res.json({ runtime: null }));
    serverApp.get('/history/:id', (_req, res) => res.json({ history: [] }));
    serverApp.use(app);
    server = await new Promise(resolve => { const instance = serverApp.listen(0, '127.0.0.1', () => resolve(instance)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const read = async (user = 'viewer-demo') => fetch(base + '/agent/environment', { headers: { authorization: `Bearer ${createSessionToken(user)}` } });
    if (process.env.OXY_OBSERVER_PREVIEW !== '1') {
      assert.equal((await fetch(base + '/agent/environment')).status, 401);
      const other = await (await read('other-owner')).json();
      assert.equal(other.frame, null);
      console.log('PASS real HTTP observer is authenticated and owner scoped');
    }
    const before = await (await read()).json();
    assert.equal(before.state, 'live');
    fs.writeFileSync(out + '/before.jpg', Buffer.from(before.frame.data, 'base64'));
    await require('../../api/services/browser-environment').act('viewer-demo', { action: 'click', elementId: 0 });
    // Exceed the capture coalescing interval before reading the changed screen.
    await new Promise(resolve => setTimeout(resolve, 1100));
    const after = await (await read()).json();
    assert.equal(after.state, 'live');
    assert.notEqual(before.frame.data, after.frame.data);
    assert.notEqual(before.capturedAt, after.capturedAt);
    assert.equal(after.lastAction.label, 'Clicked Change state');
    fs.writeFileSync(out + '/after.jpg', Buffer.from(after.frame.data, 'base64'));
    console.log('PASS live screen pixels and capture time change after a real browser action');
    if (process.env.OXY_OBSERVER_PREVIEW !== '1') {
      await require('../../api/services/browser-environment').act('viewer-demo', { action: 'type', elementId: 1, value: 'private-input-value', submit: false });
      await new Promise(resolve => setTimeout(resolve, 1100));
      const typed = await (await read()).json();
      assert.equal(typed.lastAction.label, 'Entered text in a field');
      assert.ok(!JSON.stringify(typed).includes('private-input-value'));
      console.log('PASS observer action labels never echo input values');
    }
    if (process.env.OXY_OBSERVER_PREVIEW === '1') {
      fs.writeFileSync(out + '/base-url.txt', base);
      console.log('PREVIEW ' + base + ' (local test auth adapter; real browser captures)');
      await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
    } else {
      await browserSessions.closeSession('viewer-demo');
      const closed = await (await read()).json();
      assert.equal(closed.state, 'disconnected');
      assert.equal(closed.frame, null);
      console.log('PASS closed session clears the live frame');
    }
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await browserSessions.closeSession('viewer-demo');
    await browser.close();
    await browserSessions.closeWarmPool();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

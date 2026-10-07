const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
process.env.OXY_BROWSER_WARM_POOL = 'false';
process.env.SUPABASE_URL ||= 'http://127.0.0.1:1';
process.env.SUPABASE_KEY ||= 'test-key';
const env = require('../../api/services/browser-environment');
const sessions = require('../../api/services/browser-session');

const PAGES = {
  '/': '<title>Start</title><a href="/a">Alpha</a> <a href="/b">Beta</a><div style="height:3000px"></div><a href="/far">Far away</a>',
  '/covered': '<title>Covered</title><a href="/a" style="position:absolute;left:10px;top:10px;width:120px;height:30px">Hidden link</a>'
    + '<div style="position:absolute;left:0;top:0;width:300px;height:100px;background:#eee;pointer-events:auto"></div>',
  '/a': '<title>Alpha page</title><h1>Alpha</h1>',
  '/b': '<title>Beta page</title><h1>Beta</h1>',
  '/far': '<title>Far page</title><h1>Far</h1>',
};
let server;
let base;
test.before(async () => {
  server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGES[req.url.split('?')[0]] || 'missing'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await sessions.closeSession('clicker'); server.close(); });

test('a fully visible, uncovered control gets a click point and the click lands on that control', async () => {
  const seen = await env.open('clicker', { url: `${base}/` });
  const beta = seen.elements.find((el) => el.text === 'Beta');
  assert.ok(beta.fastClick, 'visible and on top: a click point is measured');
  const after = await env.act('clicker', { action: 'click', elementId: beta.id });
  assert.equal(after.title, 'Beta page');
  assert.equal(after.changed.url, true);
});

test('a control below the fold has no click point and still works through the careful path', async () => {
  const seen = await env.open('clicker', { url: `${base}/` });
  const far = seen.elements.find((el) => el.text === 'Far away');
  assert.equal(far.fastClick, undefined);
  const after = await env.act('clicker', { action: 'click', elementId: far.id });
  assert.equal(after.title, 'Far page');
});

test('a control something else is sitting on top of gets no click point', async () => {
  const seen = await env.open('clicker', { url: `${base}/covered` });
  const link = seen.elements.find((el) => el.text === 'Hidden link');
  if (link) assert.equal(link.fastClick, undefined, 'a covered link must not be clicked by coordinates');
});

test('one read returns controls, text, title and the bot-wall verdict together', async () => {
  const seen = await env.open('clicker', { url: `${base}/` });
  assert.equal(seen.title, 'Start');
  assert.match(seen.text, /Alpha/);
  assert.equal(seen.blocked, null);
  const walled = env.looksLikeBlockWall({ text: 'Access Denied', bodyLen: 20 });
  assert.equal(walled, true);
});

test('a text box with no label or placeholder is still offered, so it can be typed into', async () => {
  PAGES['/bare-search'] = '<title>Bare</title><form action="/a"><input type="search" name="search" id="searchInput"><button>Go</button></form>';
  const seen = await env.open('clicker', { url: `${base}/bare-search` });
  const box = seen.elements.find((el) => el.isInput);
  assert.ok(box, 'the unlabelled search box is listed');
  assert.match(box.text, /search/i);
  const typed = await env.act('clicker', { action: 'type', elementId: box.id, value: 'Paris' });
  assert.equal(typed.title, 'Alpha page', 'typing and Enter submitted the form');
});

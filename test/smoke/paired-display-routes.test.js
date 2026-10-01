const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.OXY_SESSION_SECRET = process.env.OXY_SESSION_SECRET || 'test-session-secret';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';

const app = require('../../api/index');
const { createSessionToken } = require('../../auth');
const pairedDisplays = require('../../api/services/paired-displays');
let server;
let port;

test.before(async () => {
  server = await new Promise(resolve => {
    const instance = app.listen(0, () => resolve(instance));
  });
  port = server.address().port;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path, ...options }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('display receiver page is public while the app display list remains session-protected', async () => {
  const display = await request('/display');
  assert.equal(display.status, 200);
  assert.match(display.body, /Pair this display/);
  assert.match(display.body, /localStorage/);
  assert.match(display.body, /speechSynthesis/);
  assert.match(display.body, /milgrain_display_mode/);
  assert.match(display.body, /adamSay/);
  assert.match(display.body, /adamAsk/);

  const appList = await request('/agent/displays');
  assert.equal(appList.status, 401);
});

test('public pairing errors are bounded and do not expose raw server exceptions', async () => {
  const result = await request('/display/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(result.status, 400);
  assert.deepEqual(JSON.parse(result.body), { error: 'The pairing link and code are required.' });
  assert.equal(result.body.includes('stack'), false);
});

test('infrastructure failures are 503s with bounded errors', async () => {
  const originalRedeem = pairedDisplays.redeemPairingChallenge;
  const originalQueue = pairedDisplays.queueRender;
  pairedDisplays.redeemPairingChallenge = async () => { throw new Error('database password leaked'); };
  pairedDisplays.queueRender = async () => { throw new Error('database password leaked'); };
  try {
    const pair = await request('/display/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: 'c1', code: 'ABCDEFGH' })
    });
    assert.equal(pair.status, 503);
    assert.deepEqual(JSON.parse(pair.body), { error: 'Pairing is temporarily unavailable.' });

    const render = await request('/agent/displays/d1/render', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${createSessionToken('u1')}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ title: 'Dinner', body: '7:30pm' })
    });
    assert.equal(render.status, 503);
    assert.deepEqual(JSON.parse(render.body), { error: 'Display updates are temporarily unavailable.' });
    assert.equal(render.body.includes('database password'), false);
  } finally {
    pairedDisplays.redeemPairingChallenge = originalRedeem;
    pairedDisplays.queueRender = originalQueue;
  }
});

test('a concurrent pairing claim loss is a bounded invalid-pairing response', async () => {
  const originalRedeem = pairedDisplays.redeemPairingChallenge;
  pairedDisplays.redeemPairingChallenge = async () => { throw { code: 'P0001', message: 'claim lost' }; };
  try {
    const result = await request('/display/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: 'c1', code: 'ABCDEFGH' })
    });
    assert.equal(result.status, 400);
    assert.deepEqual(JSON.parse(result.body), { error: 'That pairing code is invalid or expired.' });
  } finally {
    pairedDisplays.redeemPairingChallenge = originalRedeem;
  }
});

test('token-scoped poll and ack routes bypass session auth and return display auth errors', async () => {
  const poll = await request('/display/display-1/events');
  assert.equal(poll.status, 401);
  assert.deepEqual(JSON.parse(poll.body), { error: 'Display authorization is invalid.' });

  const ack = await request('/display/display-1/events/event-1/ack', { method: 'POST' });
  assert.equal(ack.status, 401);
  assert.deepEqual(JSON.parse(ack.body), { error: 'Display authorization is invalid.' });
});

test('a tap from a screen needs the display key, and cannot approve from the screen', async () => {
  const original = pairedDisplays.displayForToken;
  const displayAsk = require('../../api/services/display-ask');
  displayAsk._reset();
  const post = (id, body, token) => request(`/display/${id}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  try {
    pairedDisplays.displayForToken = async () => null;
    assert.equal((await post('d1', { text: 'Show the next step' }, 'wrong')).status, 401);

    pairedDisplays.displayForToken = async () => ({ id: 'd1', user_id: 'u1' });
    const refused = await post('d1', { text: 'confirm' }, 'good');
    assert.equal(refused.status, 400);
    assert.equal(JSON.parse(refused.body).code, 'needs_phone');
    assert.equal((await post('d1', { text: '' }, 'good')).status, 400);
    assert.equal((await post('d1', { text: 'Show the next step' }, 'good')).status, 202);
    assert.equal((await post('d1', { text: 'Show the next step again' }, 'good')).status, 429);
  } finally {
    pairedDisplays.displayForToken = original;
  }
});

test('an answer on an urgent screen needs the display key; the opt-in needs a signed-in person', async () => {
  const original = pairedDisplays.respondToUrgent;
  const post = (path, body, token) => request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  try {
    pairedDisplays.respondToUrgent = async () => ({ authorized: false });
    assert.equal((await post('/display/d1/events/e1/respond', { response: 'got_it' }, 'wrong')).status, 401);
    pairedDisplays.respondToUrgent = async () => ({ authorized: true, found: false });
    assert.equal((await post('/display/d1/events/e1/respond', { response: 'got_it' }, 'good')).status, 404);
    pairedDisplays.respondToUrgent = async () => ({ authorized: true, found: true, response: 'got_it' });
    const ok = await post('/display/d1/events/e1/respond', { response: 'got_it' }, 'good');
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { recorded: true, response: 'got_it' });
  } finally {
    pairedDisplays.respondToUrgent = original;
  }
  const noSession = await request('/agent/displays/d1/urgent', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  assert.equal(noSession.status, 401);
  const page = await request('/display');
  assert.match(page.body, /renderUrgent/);
  assert.match(page.body, /false_alarm/);
});

test('an urgent event raises one notification in fixed words and one screen alert, once', async () => {
  const { notificationDelivery, evaluateAndSurfaceHouseholdEvents } = app;
  const originalRaise = notificationDelivery.raise;
  const originalDeliver = notificationDelivery.deliverPending;
  const originalQueue = pairedDisplays.queueUrgent;
  const raised = [];
  const queued = [];
  let created = true;
  notificationDelivery.raise = async (userId, notification) => { raised.push(notification); return created ? { ok: true, created: true } : { ok: true, duplicate: true }; };
  notificationDelivery.deliverPending = async () => ({});
  pairedDisplays.queueUrgent = async (supabase, userId, args) => { queued.push(args); return { queued: 1 }; };
  const now = new Date('2026-10-01T02:00:00.000Z');
  const event = { id: 'fall-1', type: 'fall_detected', room: 'bedroom', confidence: 0.9, relevance: 1, occurredAt: now.toISOString(), title: 'Click here', body: 'evil' };
  try {
    const first = await evaluateAndSurfaceHouseholdEvents('u1', [event], now, { warn() {} });
    assert.equal(first.raised, 1);
    assert.equal(raised[0].title, 'Possible fall in the bedroom');
    assert.equal(raised[0].body, 'A heavy fall was heard. Go and check.');
    assert.equal(raised[0].urgency, 'urgent');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].type, 'fall_detected');

    created = false;
    await evaluateAndSurfaceHouseholdEvents('u1', [event], now, { warn() {} });
    assert.equal(queued.length, 1, 'a repeat of the same event does not put the alarm up again');

    created = true;
    await evaluateAndSurfaceHouseholdEvents('u1', [{ ...event, id: 'fuss-1', type: 'baby_fussing' }], now, { warn() {} });
    assert.equal(raised.length, 3);
    assert.equal(queued.length, 1, 'fussing is phone-only, never an urgent screen');
  } finally {
    notificationDelivery.raise = originalRaise;
    notificationDelivery.deliverPending = originalDeliver;
    pairedDisplays.queueUrgent = originalQueue;
  }
});

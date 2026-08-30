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

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.SUPABASE_URL ||= 'http://127.0.0.1:9';
process.env.SUPABASE_KEY ||= 'test';
process.env.OXY_SESSION_SECRET ||= 'test-secret-test-secret-test-secret';

const pairing = require('../../api/services/device-pairing');

const T0 = Date.parse('2026-10-13T09:30:00Z');
const created = [];
const createPairing = async (userId, name) => {
  created.push([userId, name]);
  return { display: { id: `disp-${created.length}`, name }, token: `tok-${created.length}` };
};

test('the box shows a code, the person types it in the app, and the box collects its token once', async () => {
  pairing._reset();
  created.length = 0;
  const started = pairing.startDevicePairing({ name: 'Kitchen', source: 'ip1', now: T0 });
  assert.match(started.code, /^[A-HJKMNP-Z2-9]{3} [A-HJKMNP-Z2-9]{3}$/, 'easy to read: no 0/O or 1/I/L');
  assert.equal(started.pollSeconds, 3);

  assert.deepEqual(pairing.pollDevicePairing({ ...started, now: T0 + 1000 }), { status: 'pending' });
  const display = await pairing.claimDevicePairing({ userId: 'u1', code: started.code.toLowerCase().replace(' ', '-'), createPairing, now: T0 + 2000 });
  assert.deepEqual(display, { id: 'disp-1', name: 'Kitchen' });
  assert.deepEqual(created, [['u1', 'Kitchen']]);

  assert.deepEqual(pairing.pollDevicePairing({ ...started, now: T0 + 3000 }), { status: 'paired', displayId: 'disp-1', name: 'Kitchen', token: 'tok-1' });
  assert.deepEqual(pairing.pollDevicePairing({ ...started, now: T0 + 4000 }), { status: 'expired' }, 'the token is handed over only once');
});

test('only the box that asked can collect, codes are single-use, and everything expires', async () => {
  pairing._reset();
  const started = pairing.startDevicePairing({ source: 'ip1', now: T0 });
  assert.deepEqual(pairing.pollDevicePairing({ requestId: started.requestId, pollSecret: 'guess', now: T0 }), { status: 'expired' });
  assert.deepEqual(pairing.pollDevicePairing({ requestId: started.requestId, now: T0 }), { status: 'expired' });

  await pairing.claimDevicePairing({ userId: 'u1', code: started.code, createPairing, now: T0 + 1000 });
  await assert.rejects(pairing.claimDevicePairing({ userId: 'u2', code: started.code, createPairing, now: T0 + 2000 }), { code: 'invalid_code' });

  const late = pairing.startDevicePairing({ source: 'ip2', now: T0 });
  await assert.rejects(pairing.claimDevicePairing({ userId: 'u1', code: late.code, createPairing, now: T0 + pairing.TTL_MS + 1 }), { code: 'invalid_code' });
  assert.deepEqual(pairing.pollDevicePairing({ ...late, now: T0 + pairing.TTL_MS + 1 }), { status: 'expired' });
});

test('a failed pairing leaves the code usable; guessing and flooding are limited', async () => {
  pairing._reset();
  const started = pairing.startDevicePairing({ source: 'ip1', now: T0 });
  await assert.rejects(pairing.claimDevicePairing({ userId: 'u1', code: started.code, createPairing: async () => { throw new Error('db down'); }, now: T0 }), /db down/);
  assert.deepEqual(pairing.pollDevicePairing({ ...started, now: T0 }), { status: 'pending' });
  await pairing.claimDevicePairing({ userId: 'u1', code: started.code, createPairing, now: T0 + 1 });

  for (let i = 0; i < 9; i++) await assert.rejects(pairing.claimDevicePairing({ userId: 'u9', code: 'ZZZ ZZZ', createPairing, now: T0 }), { code: 'invalid_code' });
  await assert.rejects(pairing.claimDevicePairing({ userId: 'u9', code: 'ZZZ ZZZ', createPairing, now: T0 }), { code: 'invalid_code' });
  await assert.rejects(pairing.claimDevicePairing({ userId: 'u9', code: 'ZZZ ZZZ', createPairing, now: T0 }), { code: 'too_fast' });

  for (let i = 0; i < 5; i++) pairing.startDevicePairing({ source: 'flood', now: T0 });
  assert.throws(() => pairing.startDevicePairing({ source: 'flood', now: T0 }), { code: 'too_fast' });
  assert.doesNotThrow(() => pairing.startDevicePairing({ source: 'flood', now: T0 + 61000 }));
});

test('through the real routes: the box asks, the signed-in app claims, the box collects', async () => {
  pairing._reset();
  const pairedDisplays = require('../../api/services/paired-displays');
  const calls = [];
  pairedDisplays.createPairingChallenge = async (_s, userId, { displayName }) => { calls.push(['challenge', userId, displayName]); return { id: 'chal-9', code: 'ABC123' }; };
  pairedDisplays.redeemPairingChallenge = async (_s, body) => { calls.push(['redeem', body.challengeId, body.code, body.displayName]); return { display: { id: 'disp-9', name: body.displayName }, token: 'tok-9' }; };
  const app = require('../../api/index');
  const { createSessionToken } = require('../../auth');
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    const started = await (await post('/devices/pairing', { name: 'Kitchen' })).json();
    assert.match(started.code, /^\w{3} \w{3}$/);
    assert.equal((await post('/devices/pairing/poll', { requestId: started.requestId, pollSecret: started.pollSecret })).status, 200);

    assert.equal((await post('/agent/devices/claim', { code: started.code })).status, 401, 'claiming needs a signed-in person');
    const claimed = await post('/agent/devices/claim', { code: started.code }, { Authorization: `Bearer ${createSessionToken('user-7')}` });
    assert.equal(claimed.status, 200);
    assert.deepEqual(await claimed.json(), { display: { id: 'disp-9', name: 'Kitchen' } });
    assert.deepEqual(calls, [['challenge', 'user-7', 'Kitchen'], ['redeem', 'chal-9', 'ABC123', 'Kitchen']]);

    const collected = await post('/devices/pairing/poll', { requestId: started.requestId, pollSecret: started.pollSecret });
    assert.deepEqual(await collected.json(), { status: 'paired', displayId: 'disp-9', name: 'Kitchen', token: 'tok-9' });
    assert.equal((await post('/devices/pairing/poll', { requestId: started.requestId, pollSecret: started.pollSecret })).status, 410);

    const wrong = await post('/agent/devices/claim', { code: 'ZZZ ZZZ' }, { Authorization: `Bearer ${createSessionToken('user-7')}` });
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json()).code, 'invalid_code');
  } finally {
    server.close();
  }
});

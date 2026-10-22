const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { sendApns, isDeadToken, apnsHost } = require('../../api/services/apns');

function fakeConnect(status, reason) {
  return () => {
    const client = new EventEmitter();
    client.close = () => {};
    client.request = (headers) => {
      client.lastHeaders = headers;
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.close = () => {};
      req.end = () => setImmediate(() => {
        req.emit('response', { ':status': status });
        if (reason) req.emit('data', JSON.stringify({ reason }));
        req.emit('end');
      });
      return req;
    };
    fakeConnect.last = client;
    return client;
  };
}

test('a push is sent over http2 to the device path with the app topic', async () => {
  const result = await sendApns({ host: 'https://x', authToken: 'jwt', topic: 'ai.oxy.app', deviceToken: 'abc', payload: { aps: {} }, connect: fakeConnect(200) });
  assert.equal(result.ok, true);
  assert.equal(fakeConnect.last.lastHeaders[':path'], '/3/device/abc');
  assert.equal(fakeConnect.last.lastHeaders['apns-topic'], 'ai.oxy.app');
});

test('Apple refusing a token is reported with its reason, and only unregistered tokens count as dead', async () => {
  const result = await sendApns({ host: 'https://x', authToken: 'jwt', topic: 't', deviceToken: 'abc', payload: {}, connect: fakeConnect(400, 'BadDeviceToken') });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'BadDeviceToken');
  assert.equal(isDeadToken(result), false);
  assert.equal(isDeadToken({ status: 410, reason: 'Unregistered' }), true);
  assert.equal(isDeadToken({ status: 403, reason: 'InvalidProviderToken' }), false);
});

test('each device is pushed through the Apple server its token came from', () => {
  assert.equal(apnsHost('sandbox', false), 'https://api.sandbox.push.apple.com');
  assert.equal(apnsHost('production', true), 'https://api.push.apple.com');
  assert.equal(apnsHost(null, true), 'https://api.sandbox.push.apple.com');
  assert.equal(apnsHost(undefined, false), 'https://api.push.apple.com');
});

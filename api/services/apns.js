'use strict';

// Apple's push service only speaks HTTP/2, which axios does not, so this talks to it directly.

const http2 = require('node:http2');

function sendApns({ host, authToken, topic, deviceToken, payload, connect = http2.connect, timeoutMs = 10000 }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    let client;
    try { client = connect(host); } catch (error) { return done({ ok: false, status: 0, reason: error.message }); }
    const finish = (result) => { try { client.close(); } catch { /* already closed */ } done(result); };
    client.on('error', (error) => finish({ ok: false, status: 0, reason: error.message }));
    const request = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${authToken}`,
      'apns-topic': topic,
      'apns-push-type': 'alert',
      'content-type': 'application/json'
    });
    request.setTimeout(timeoutMs, () => { request.close(); finish({ ok: false, status: 0, reason: 'timeout' }); });
    let status = 0;
    let body = '';
    request.on('response', (headers) => { status = Number(headers[':status']) || 0; });
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      let reason = '';
      try { reason = JSON.parse(body || '{}').reason || ''; } catch { /* no body */ }
      finish({ ok: status === 200, status, reason });
    });
    request.on('error', (error) => finish({ ok: false, status: 0, reason: error.message }));
    request.end(JSON.stringify(payload));
  });
}

// A token Apple says is dead should be forgotten, not retried forever.
const isDeadToken = (result) => result.status === 410 || ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(result.reason);

module.exports = { sendApns, isDeadToken };

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const http = require('node:http');

const app = require('../../api/index');

function buildValidSignature(secret, id, timestamp, rawBody) {
  const secretBytes = Buffer.from(secret.split('_')[1], 'base64');
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const sig = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  return `v1,${sig}`;
}
const TEST_SECRET = `whsec_${Buffer.from('test-signing-key-32-bytes-long!').toString('base64')}`;

function postWebhook(server, path, rawBody, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: 'POST', hostname: '127.0.0.1', port: server.address().port, path,
      headers: { 'Content-Type': 'application/json', ...headers }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

test('POST /webhooks/millie-email is rejected (fails closed) when RESEND_WEBHOOK_SECRET is not configured', async () => {
  const oldSecret = process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.RESEND_WEBHOOK_SECRET;
  const server = app.listen(0);
  try {
    const rawBody = JSON.stringify({ data: { from: 'nobody@example.com', to: ['unclaimed@millie.oxy.app'], subject: 'hi', text: 'hello', email_id: 'evt-1' } });
    const res = await postWebhook(server, '/webhooks/millie-email', rawBody);
    assert.equal(res.status, 400);
  } finally {
    server.close();
    if (oldSecret !== undefined) process.env.RESEND_WEBHOOK_SECRET = oldSecret;
  }
});

test('POST /webhooks/millie-email rejects a request with an invalid signature', async () => {
  const oldSecret = process.env.RESEND_WEBHOOK_SECRET;
  process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET;
  const server = app.listen(0);
  try {
    const rawBody = JSON.stringify({ data: { from: 'nobody@example.com', to: ['unclaimed@millie.oxy.app'], subject: 'hi', text: 'hello', email_id: 'evt-1' } });
    const res = await postWebhook(server, '/webhooks/millie-email', rawBody, {
      'svix-id': 'msg_1', 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': 'v1,not-a-real-signature=='
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
    if (oldSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = oldSecret;
  }
});

test('POST /webhooks/millie-email with a valid signature but no matching Millie address returns 200 and does nothing destructive', async () => {
  const oldSecret = process.env.RESEND_WEBHOOK_SECRET;
  process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET;
  const server = app.listen(0);
  try {
    const rawBody = JSON.stringify({ data: { from: 'nobody@example.com', to: ['unclaimed@millie.oxy.app'], subject: 'hi', text: 'hello', email_id: 'evt-1' } });
    const id = 'msg_2';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = buildValidSignature(TEST_SECRET, id, timestamp, rawBody);
    const res = await postWebhook(server, '/webhooks/millie-email', rawBody, {
      'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature
    });
    assert.equal(res.status, 200);
  } finally {
    server.close();
    if (oldSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = oldSecret;
  }
});

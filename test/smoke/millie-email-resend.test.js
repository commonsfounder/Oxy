const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const Module = require('node:module');

const mockAxios = { post: async () => ({}) };
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'axios') return mockAxios;
  return originalLoad.call(this, request, parent, isMain);
};
const { sendMillieEmail, parseInboundPayload, verifyResendWebhookSignature, MILLIE_EMAIL_SIGNATURE_LINE } = require('../../connectors/millie-email-resend');
Module._load = originalLoad;

// Resend delivers webhooks via Svix: headers svix-id/svix-timestamp/svix-signature, secret
// format "whsec_<base64>". This builds a genuinely valid signature the same way Svix does,
// so the tests below prove real cryptographic correctness, not a mocked pass-through.
function buildValidSignature(secret, id, timestamp, rawBody) {
  const secretBytes = Buffer.from(secret.split('_')[1], 'base64');
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const sig = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  return `v1,${sig}`;
}
const TEST_SECRET = `whsec_${Buffer.from('test-signing-key-32-bytes-long!').toString('base64')}`;

test('sendMillieEmail posts to Resend with the from/to/subject/body and appends the signature line', async () => {
  const oldKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'test-key';
  let captured;
  const oldPost = mockAxios.post;
  mockAxios.post = async (url, body, config) => {
    captured = { url, body, config };
    return { data: { id: 'resend-msg-1' } };
  };
  try {
    const result = await sendMillieEmail({
      from: 'chizi@millie.oxy.app',
      to: 'reservations@bistro.example',
      subject: 'Booking change',
      body: 'Could you move our booking to 8pm?'
    });
    assert.equal(captured.url, 'https://api.resend.com/emails');
    assert.equal(captured.body.from, 'chizi@millie.oxy.app');
    assert.equal(captured.body.to, 'reservations@bistro.example');
    assert.match(captured.body.text, /Could you move our booking to 8pm\?/);
    assert.match(captured.body.text, new RegExp(MILLIE_EMAIL_SIGNATURE_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(result.providerMessageId, 'resend-msg-1');
  } finally {
    mockAxios.post = oldPost;
    if (oldKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = oldKey;
  }
});

test('parseInboundPayload normalizes a Resend inbound webhook payload', () => {
  const payload = {
    data: {
      from: 'Reservations <reservations@bistro.example>',
      to: ['chizi@millie.oxy.app'],
      subject: 'Re: Booking change',
      text: 'We can do 8:15, does that work?',
      email_id: 'inbound-msg-1',
      headers: { 'in-reply-to': '<outbound-msg-1@resend>', references: '<outbound-msg-1@resend>' }
    }
  };
  const normalized = parseInboundPayload(payload);
  assert.equal(normalized.fromAddress, 'reservations@bistro.example');
  assert.equal(normalized.toAddress, 'chizi@millie.oxy.app');
  assert.equal(normalized.body, 'We can do 8:15, does that work?');
  assert.equal(normalized.providerMessageId, 'inbound-msg-1');
  assert.equal(normalized.inReplyTo, '<outbound-msg-1@resend>');
});

test('parseInboundPayload returns null for a payload with no usable from address', () => {
  assert.equal(parseInboundPayload({ data: {} }), null);
});

test('verifyResendWebhookSignature accepts a genuinely valid Svix signature', () => {
  const id = 'msg_test123';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify({ data: { from: 'a@b.com' } });
  const signature = buildValidSignature(TEST_SECRET, id, timestamp, rawBody);
  const valid = verifyResendWebhookSignature(rawBody, { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature }, TEST_SECRET);
  assert.equal(valid, true);
});

test('verifyResendWebhookSignature rejects a body that does not match what was signed', () => {
  const id = 'msg_test123';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signedBody = JSON.stringify({ data: { from: 'a@b.com' } });
  const tamperedBody = JSON.stringify({ data: { from: 'attacker@evil.com' } });
  const signature = buildValidSignature(TEST_SECRET, id, timestamp, signedBody);
  const valid = verifyResendWebhookSignature(tamperedBody, { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature }, TEST_SECRET);
  assert.equal(valid, false);
});

test('verifyResendWebhookSignature rejects a signature computed with the wrong secret', () => {
  const id = 'msg_test123';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify({ data: { from: 'a@b.com' } });
  const wrongSecret = `whsec_${Buffer.from('a-completely-different-key-here').toString('base64')}`;
  const signature = buildValidSignature(wrongSecret, id, timestamp, rawBody);
  const valid = verifyResendWebhookSignature(rawBody, { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature }, TEST_SECRET);
  assert.equal(valid, false);
});

test('verifyResendWebhookSignature rejects a stale timestamp (replay protection)', () => {
  const id = 'msg_test123';
  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 10 * 60); // 10 minutes old
  const rawBody = JSON.stringify({ data: { from: 'a@b.com' } });
  const signature = buildValidSignature(TEST_SECRET, id, staleTimestamp, rawBody);
  const valid = verifyResendWebhookSignature(rawBody, { 'svix-id': id, 'svix-timestamp': staleTimestamp, 'svix-signature': signature }, TEST_SECRET);
  assert.equal(valid, false);
});

test('verifyResendWebhookSignature rejects when headers or secret are missing', () => {
  const rawBody = JSON.stringify({ data: { from: 'a@b.com' } });
  assert.equal(verifyResendWebhookSignature(rawBody, {}, TEST_SECRET), false);
  assert.equal(verifyResendWebhookSignature(rawBody, { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 'v1,abc' }, ''), false);
});

test('verifyResendWebhookSignature accepts when the header carries multiple space-separated signatures (key rotation)', () => {
  const id = 'msg_test123';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify({ data: { from: 'a@b.com' } });
  const realSignature = buildValidSignature(TEST_SECRET, id, timestamp, rawBody);
  const otherSignature = 'v1,not-a-real-signature==';
  const valid = verifyResendWebhookSignature(rawBody, { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `${otherSignature} ${realSignature}` }, TEST_SECRET);
  assert.equal(valid, true);
});

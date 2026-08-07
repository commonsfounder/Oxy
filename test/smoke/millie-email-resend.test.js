const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

const mockAxios = { post: async () => ({}) };
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'axios') return mockAxios;
  return originalLoad.call(this, request, parent, isMain);
};
const { sendMillieEmail, parseInboundPayload, MILLIE_EMAIL_SIGNATURE_LINE } = require('../../connectors/millie-email-resend');
Module._load = originalLoad;

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

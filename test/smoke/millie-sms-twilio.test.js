const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

const mockAxios = { post: async () => ({}), get: async () => ({}) };
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'axios') return mockAxios;
  return originalLoad.call(this, request, parent, isMain);
};
const { sendMillieSms, parseInboundSmsPayload, provisionPhoneNumber, MILLIE_SMS_SIGNATURE_LINE } = require('../../connectors/millie-sms-twilio');
Module._load = originalLoad;

test('sendMillieSms posts to Twilio Messages API and appends the signature line', async () => {
  const oldSid = process.env.TWILIO_ACCOUNT_SID;
  const oldToken = process.env.TWILIO_AUTH_TOKEN;
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = 'test-token';
  let captured;
  const oldPost = mockAxios.post;
  mockAxios.post = async (url, body, config) => {
    captured = { url, body, config };
    return { data: { sid: 'SMtest1' } };
  };
  try {
    const result = await sendMillieSms({ from: '+15551230000', to: '+15559876543', body: 'Can you move our booking to 8pm?' });
    assert.match(captured.url, /Accounts\/ACtest\/Messages\.json$/);
    // captured.body is a URLSearchParams instance — decode the actual field value
    // rather than pattern-matching its percent-encoded .toString() form.
    const sentBody = new URLSearchParams(captured.body.toString()).get('Body');
    assert.match(sentBody, /Can you move our booking to 8pm\?/);
    assert.match(sentBody, new RegExp(MILLIE_SMS_SIGNATURE_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(result.providerMessageId, 'SMtest1');
  } finally {
    mockAxios.post = oldPost;
    if (oldSid === undefined) delete process.env.TWILIO_ACCOUNT_SID; else process.env.TWILIO_ACCOUNT_SID = oldSid;
    if (oldToken === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = oldToken;
  }
});

test('parseInboundSmsPayload normalizes a Twilio inbound webhook payload', () => {
  const normalized = parseInboundSmsPayload({ From: '+15559876543', To: '+15551230000', Body: 'We can do 8:15', MessageSid: 'SMtest2' });
  assert.equal(normalized.fromAddress, '+15559876543');
  assert.equal(normalized.toAddress, '+15551230000');
  assert.equal(normalized.body, 'We can do 8:15');
  assert.equal(normalized.providerMessageId, 'SMtest2');
});

test('provisionPhoneNumber throws a clear error when Twilio env vars are missing', async () => {
  const oldSid = process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_ACCOUNT_SID;
  try {
    await assert.rejects(() => provisionPhoneNumber('demo-test-user'), /TWILIO_ACCOUNT_SID/);
  } finally {
    if (oldSid !== undefined) process.env.TWILIO_ACCOUNT_SID = oldSid;
  }
});

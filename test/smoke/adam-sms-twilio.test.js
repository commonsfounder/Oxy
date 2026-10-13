const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

const mockAxios = { post: async () => ({}), get: async () => ({}) };
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'axios') return mockAxios;
  return originalLoad.call(this, request, parent, isMain);
};
const { sendAdamSms, parseInboundSmsPayload, provisionPhoneNumber, MILLIE_SMS_SIGNATURE_LINE } = require('../../connectors/adam-sms-twilio');
Module._load = originalLoad;

test('sendAdamSms posts to Twilio Messages API and appends the signature line', async () => {
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
    const result = await sendAdamSms({ from: '+15551230000', to: '+15559876543', body: 'Can you move our booking to 8pm?' });
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

function withTwilioEnv(values, fn) {
  const keys = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_NUMBER_COUNTRY', 'TWILIO_NUMBER_TYPE', 'TWILIO_BUNDLE_SID', 'TWILIO_ADDRESS_SID', 'APP_URL'];
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, { TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'test-token', APP_URL: 'https://oxy.example/', ...values });
  return Promise.resolve().then(fn).finally(() => {
    for (const k of keys) {
      if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k];
    }
  });
}

function captureTwilio() {
  const calls = { get: [], post: [] };
  const oldGet = mockAxios.get;
  const oldPost = mockAxios.post;
  mockAxios.get = async (url, config) => {
    calls.get.push({ url, config });
    return { data: { available_phone_numbers: [{ phone_number: '+447700100200' }] } };
  };
  mockAxios.post = async (url, body) => {
    calls.post.push({ url, body: new URLSearchParams(body.toString()) });
    return { data: { phone_number: '+447700100200', sid: 'PNtest' } };
  };
  calls.restore = () => { mockAxios.get = oldGet; mockAxios.post = oldPost; };
  return calls;
}

test('provisionPhoneNumber buys a UK mobile number on the compliance bundle', async () => {
  const calls = captureTwilio();
  try {
    const result = await withTwilioEnv({ TWILIO_BUNDLE_SID: 'BUtest' }, () => provisionPhoneNumber('pool'));
    // Mobile, not Local: UK local numbers need UK proof of address.
    assert.match(calls.get[0].url, /AvailablePhoneNumbers\/GB\/Mobile\.json$/);
    const purchase = calls.post[0].body;
    assert.equal(purchase.get('PhoneNumber'), '+447700100200');
    assert.equal(purchase.get('BundleSid'), 'BUtest');
    assert.equal(purchase.get('SmsUrl'), 'https://oxy.example/webhooks/millie-sms');
    assert.equal(purchase.has('AddressSid'), false);
    assert.deepEqual(result, { phoneNumber: '+447700100200', providerRef: 'PNtest' });
  } finally {
    calls.restore();
  }
});

test('provisionPhoneNumber refuses a UK number without a bundle, before buying anything', async () => {
  const calls = captureTwilio();
  try {
    await withTwilioEnv({}, () => assert.rejects(() => provisionPhoneNumber('pool'), /TWILIO_BUNDLE_SID/));
    assert.equal(calls.get.length + calls.post.length, 0);
  } finally {
    calls.restore();
  }
});

test('provisionPhoneNumber refuses without APP_URL, since replies would have nowhere to go', async () => {
  const calls = captureTwilio();
  try {
    await withTwilioEnv({ TWILIO_BUNDLE_SID: 'BUtest', APP_URL: '' }, () => assert.rejects(() => provisionPhoneNumber('pool'), /APP_URL/));
    assert.equal(calls.post.length, 0);
  } finally {
    calls.restore();
  }
});

test('provisionPhoneNumber honours TWILIO_NUMBER_TYPE and TWILIO_ADDRESS_SID, and needs no bundle outside the UK', async () => {
  const calls = captureTwilio();
  try {
    await withTwilioEnv({ TWILIO_NUMBER_COUNTRY: 'us', TWILIO_NUMBER_TYPE: 'local', TWILIO_ADDRESS_SID: 'ADtest' }, () => provisionPhoneNumber('pool'));
    assert.match(calls.get[0].url, /AvailablePhoneNumbers\/US\/Local\.json$/);
    assert.equal(calls.post[0].body.get('AddressSid'), 'ADtest');
    assert.equal(calls.post[0].body.has('BundleSid'), false);
    await withTwilioEnv({ TWILIO_NUMBER_TYPE: 'premium' }, () => assert.rejects(() => provisionPhoneNumber('pool'), /TWILIO_NUMBER_TYPE/));
  } finally {
    calls.restore();
  }
});

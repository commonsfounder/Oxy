const assert = require('node:assert/strict');
const test = require('node:test');

const {
  registerProvider,
  activeProviderName,
  provisionPhoneNumber,
  sendSms,
  parseInboundSms,
  inboundAck
} = require('../../connectors/phone-provider');

function fakeProvider(name) {
  const calls = [];
  registerProvider(name, {
    provisionPhoneNumber: async (userId) => {
      calls.push(['provision', userId]);
      return { phoneNumber: `+4470000${name.length}`, providerRef: `${name}-ref` };
    },
    sendSms: async (args) => {
      calls.push(['send', args]);
      return { providerMessageId: `${name}-msg` };
    },
    parseInboundSms: (payload) => {
      calls.push(['parse', payload]);
      return payload?.From ? { fromAddress: payload.From, toAddress: payload.To, body: payload.Body } : null;
    },
    inboundAck: () => ({ contentType: 'text/plain', body: `ok-${name}` })
  });
  return calls;
}

function withEnv(value, fn) {
  const old = process.env.MILLIE_PHONE_PROVIDER;
  if (value === undefined) delete process.env.MILLIE_PHONE_PROVIDER;
  else process.env.MILLIE_PHONE_PROVIDER = value;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env.MILLIE_PHONE_PROVIDER;
    else process.env.MILLIE_PHONE_PROVIDER = old;
  }
}

test('activeProviderName defaults to twilio when MILLIE_PHONE_PROVIDER is unset', () => {
  withEnv(undefined, () => {
    assert.equal(activeProviderName(), 'twilio');
  });
});

test('activeProviderName reads MILLIE_PHONE_PROVIDER, case- and space-insensitively', () => {
  withEnv('  Telnyx  ', () => {
    assert.equal(activeProviderName(), 'telnyx');
  });
});

test('provisionPhoneNumber routes to the active provider and stamps the provider name on the result', async () => {
  fakeProvider('alpha');
  const result = await withEnv('alpha', () => provisionPhoneNumber('chizi'));
  assert.equal(result.phoneNumber, '+44700005');
  assert.equal(result.providerRef, 'alpha-ref');
  // The stamp is the whole point: the handle row records who provisioned the number,
  // so a later provider switch does not orphan numbers bought from the old one.
  assert.equal(result.provider, 'alpha');
});

test('sendSms uses the number\'s own provider, not the currently-active one', async () => {
  const alphaCalls = fakeProvider('alpha');
  const betaCalls = fakeProvider('beta');
  // Active provider is beta, but this number was provisioned on alpha.
  const result = await withEnv('beta', () => sendSms({
    from: '+447000000001', to: '+447000000002', body: 'hi', provider: 'alpha'
  }));
  assert.equal(result.providerMessageId, 'alpha-msg');
  assert.equal(alphaCalls.filter(c => c[0] === 'send').length, 1);
  assert.equal(betaCalls.filter(c => c[0] === 'send').length, 0);
});

test('sendSms falls back to the active provider when no provider is given', async () => {
  fakeProvider('gamma');
  const result = await withEnv('gamma', () => sendSms({ from: '+1', to: '+2', body: 'hi' }));
  assert.equal(result.providerMessageId, 'gamma-msg');
});

test('parseInboundSms normalizes through the named provider and returns null for unusable payloads', () => {
  fakeProvider('delta');
  const parsed = withEnv('delta', () => parseInboundSms({ From: '+447000000003', To: '+447000000004', Body: 'yes' }));
  assert.equal(parsed.fromAddress, '+447000000003');
  assert.equal(withEnv('delta', () => parseInboundSms({})), null);
});

test('inboundAck returns the provider-specific webhook acknowledgement', () => {
  fakeProvider('epsilon');
  const ack = withEnv('epsilon', () => inboundAck());
  assert.equal(ack.contentType, 'text/plain');
  assert.equal(ack.body, 'ok-epsilon');
});

test('an unknown provider name fails loudly rather than silently falling back to twilio', async () => {
  await assert.rejects(
    () => withEnv('nonesuch', () => provisionPhoneNumber('chizi')),
    /nonesuch/
  );
});

test('the built-in twilio provider is registered and exposes the full adapter surface', () => {
  const twilio = require('../../connectors/phone-provider').getProvider('twilio');
  assert.equal(typeof twilio.provisionPhoneNumber, 'function');
  assert.equal(typeof twilio.sendSms, 'function');
  assert.equal(typeof twilio.parseInboundSms, 'function');
  assert.equal(typeof twilio.inboundAck, 'function');
  // Twilio's webhook wants TwiML, not a bare 200 — that quirk belongs to the adapter,
  // not to the shared webhook route.
  assert.match(twilio.inboundAck().body, /<Response>/);
});

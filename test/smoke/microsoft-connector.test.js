const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Regression: connectors/microsoft.js was fully built (real Graph API calls, real token
// refresh) but never wired into connectors/index.js's dispatch registry, and there was no
// /auth/microsoft/start|callback route to ever acquire a first token — Outlook could never
// actually be connected despite the connector existing. These tests exercise the connector
// module in isolation (no live Graph API); the wiring itself is covered by
// connectors-registry.test.js (microsoft is now a real `kind: connection`) and by the
// action-contracts tests (the 5 outlook actions now have contracts).

const originalLoad = Module._load;

function withMockedDeps({ tokensRow = null, axiosMock } = {}, fn) {
  Module._load = function mockMicrosoftDeps(request, parent, isMain) {
    if (request === 'axios') return axiosMock || { get: async () => ({ data: {} }), post: async () => ({ data: {} }) };
    if (request === '../runtime') {
      return {
        createSupabaseServiceClient: () => ({
          from: () => ({
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({ limit: async () => ({ data: tokensRow ? [tokensRow] : [], error: null }) })
                })
              })
            }),
            upsert: async () => ({ error: null })
          })
        }),
        logMissingRuntimeEnvOnce: () => {}
      };
    }
    if (request === '../api/services/token-crypto') {
      return { decryptTokens: (t) => t, encryptTokens: (t) => t };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return fn();
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../../connectors/microsoft')];
  }
}

test('microsoft connector exports the 6 Outlook actions', () => {
  const microsoft = withMockedDeps({}, () => require('../../connectors/microsoft'));
  assert.deepEqual(microsoft.SUPPORTED_ACTIONS, [
    'send_outlook_email', 'get_outlook_emails', 'search_outlook_emails', 'create_outlook_event', 'get_outlook_events',
    'get_outlook_email_action_links'
  ]);
});

test('microsoft connector is honest (not silently successful) when Outlook was never connected', async () => {
  const microsoft = withMockedDeps({ tokensRow: null }, () => require('../../connectors/microsoft'));
  const result = await microsoft.execute('user-1', 'get_outlook_emails', {});
  assert.equal(result.success, false);
  assert.match(result.error, /not connected/i);
});

test('send_outlook_email validates required fields before ever calling Graph', async () => {
  const tokensRow = { tokens: { access_token: 'tok', refresh_token: 'refresh', expires_at: Date.now() + 3600_000 } };
  const microsoft = withMockedDeps({ tokensRow }, () => require('../../connectors/microsoft'));
  const missingTo = await microsoft.execute('user-1', 'send_outlook_email', { body: 'hi' });
  assert.equal(missingTo.success, false);
  assert.match(missingTo.error, /recipient/);
  const missingBody = await microsoft.execute('user-1', 'send_outlook_email', { to: 'a@b.com' });
  assert.equal(missingBody.success, false);
  assert.match(missingBody.error, /body/);
});

test('microsoft connector reports failure when Graph itself errors, does not fabricate success', async () => {
  const tokensRow = { tokens: { access_token: 'tok', refresh_token: 'refresh', expires_at: Date.now() + 3600_000 } };
  const microsoft = withMockedDeps({
    tokensRow,
    axiosMock: { get: async () => { throw new Error('Graph 500'); }, post: async () => ({ data: {} }) },
  }, () => require('../../connectors/microsoft'));
  const result = await microsoft.execute('user-1', 'get_outlook_emails', {});
  assert.equal(result.success, false);
  assert.match(result.error, /Graph 500/);
});

test('microsoft connector reports a clear reconnect error on a 401 from Graph', async () => {
  const tokensRow = { tokens: { access_token: 'tok', refresh_token: 'refresh', expires_at: Date.now() + 3600_000 } };
  const microsoft = withMockedDeps({
    tokensRow,
    axiosMock: { get: async () => { const e = new Error('unauthorized'); e.response = { status: 401 }; throw e; }, post: async () => ({ data: {} }) },
  }, () => require('../../connectors/microsoft'));
  const result = await microsoft.execute('user-1', 'get_outlook_events', {});
  assert.equal(result.success, false);
  assert.match(result.error, /Reconnect Microsoft/);
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { proactiveSweepAuthorization } = require('../../api/services/proactive-auth');
const { encryptTokens } = require('../../api/services/token-crypto');

function fakeReq({ header, querySecret, bodySecret } = {}) {
  return {
    get(name) {
      return name.toLowerCase() === 'x-proactive-secret' ? header : undefined;
    },
    query: querySecret ? { secret: querySecret } : {},
    body: bodySecret ? { secret: bodySecret } : {}
  };
}

test('proactive sweep can run without a secret only outside production', () => {
  const result = proactiveSweepAuthorization(fakeReq(), { NODE_ENV: 'development' });
  assert.equal(result.ok, true);
  assert.equal(result.unsecured, true);
});

test('proactive sweep fails closed in production when secret is missing', () => {
  const result = proactiveSweepAuthorization(fakeReq(), { NODE_ENV: 'production' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.match(result.error, /not configured/i);
});

test('proactive sweep accepts only the configured secret', () => {
  const env = { NODE_ENV: 'production', PROACTIVE_SWEEP_SECRET: 'sweep-secret' };
  assert.equal(proactiveSweepAuthorization(fakeReq({ header: 'wrong' }), env).ok, false);
  assert.equal(proactiveSweepAuthorization(fakeReq({ header: 'sweep-secret' }), env).ok, true);
  assert.equal(proactiveSweepAuthorization(fakeReq({ querySecret: 'sweep-secret' }), env).ok, true);
  assert.equal(proactiveSweepAuthorization(fakeReq({ bodySecret: 'sweep-secret' }), env).ok, true);
});

test('token encryption fails closed in production when key is missing', () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldKey = process.env.OXY_TOKEN_ENCRYPTION_KEY;
  delete process.env.OXY_TOKEN_ENCRYPTION_KEY;
  process.env.NODE_ENV = 'production';

  try {
    assert.throws(
      () => encryptTokens({ access_token: 'secret' }),
      /OXY_TOKEN_ENCRYPTION_KEY is required/
    );
  } finally {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;

    if (oldKey === undefined) delete process.env.OXY_TOKEN_ENCRYPTION_KEY;
    else process.env.OXY_TOKEN_ENCRYPTION_KEY = oldKey;
  }
});

const test = require('node:test');
const assert = require('node:assert');
const { hasCredentials, needsLogin } = require('../../api/services/connector-state');

test('google needs a refresh token, session or encrypted login', () => {
  assert.strictEqual(hasCredentials('google', { refresh_token: 'x' }), true);
  assert.strictEqual(hasCredentials('google', { access_token: 'x' }), false);
  assert.strictEqual(hasCredentials('google', null), false);
});

test('other connections count any real stored login', () => {
  assert.strictEqual(hasCredentials('notion', { access_token: 'x' }), true);
  assert.strictEqual(hasCredentials('notion', {}), false);
  assert.strictEqual(hasCredentials('notion', { access_token: '' }), false);
});

test('only an enabled account connection without a login needs one', () => {
  const connection = { id: 'notion', kind: 'connection' };
  const functionality = { id: 'maps', kind: 'functionality' };
  assert.strictEqual(needsLogin(connection, true, {}), true);
  assert.strictEqual(needsLogin(connection, false, {}), false);
  assert.strictEqual(needsLogin(connection, true, { access_token: 'x' }), false);
  assert.strictEqual(needsLogin(functionality, true, null), false);
  assert.strictEqual(needsLogin(undefined, true, null), false);
});

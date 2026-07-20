// test/smoke/browser-task-credential-fill.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyLoginInput,
  formatLoginValue
} = require('../../api/services/browser-task');

test('classifyLoginInput recognizes password fields', () => {
  assert.equal(classifyLoginInput('Password'), 'password');
  assert.equal(classifyLoginInput('current-password'), 'password');
  assert.equal(classifyLoginInput('pwd'), 'password');
});

test('classifyLoginInput recognizes username/email fields', () => {
  assert.equal(classifyLoginInput('Username'), 'username');
  assert.equal(classifyLoginInput('Email address'), 'username');
  assert.equal(classifyLoginInput('login-id'), 'username');
});

test('classifyLoginInput returns null for unrelated hints', () => {
  assert.equal(classifyLoginInput('Postcode'), null);
  assert.equal(classifyLoginInput(''), null);
  assert.equal(classifyLoginInput(), null);
});

test('formatLoginValue returns the matching credential field', () => {
  const credential = { username: 'me@example.com', password: 'hunter2' };
  assert.equal(formatLoginValue('username', credential), 'me@example.com');
  assert.equal(formatLoginValue('password', credential), 'hunter2');
  assert.equal(formatLoginValue('other', credential), null);
});

test('formatLoginValue returns null for an empty username rather than a falsy crash', () => {
  const credential = { username: '', password: 'hunter2' };
  assert.equal(formatLoginValue('username', credential), null);
});

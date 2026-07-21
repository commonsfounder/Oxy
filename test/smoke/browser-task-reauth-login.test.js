const assert = require('node:assert/strict');
const test = require('node:test');

const { fillReauthLogin } = require('../../api/services/browser-task');

// fillReauthLogin's actual fill/submit path needs a live Playwright page, exercised via the
// e2e harness (test/dev/browser-task-e2e.js), not mocked here. These cover the fail-safe
// paths that don't: no live session, and missing credentials — both must error before ever
// touching a page, since a stray fill attempt on a nonexistent session would throw deep
// inside Playwright instead of a clean, actionable error.

test('fillReauthLogin errors when username or password is missing, before ever looking up a session', async () => {
  const missingPassword = await fillReauthLogin('no-such-user', { username: 'me', password: '' });
  assert.equal(missingPassword.type, 'error');
  assert.match(missingPassword.error, /required/i);

  const missingUsername = await fillReauthLogin('no-such-user', { username: '', password: 'hunter2' });
  assert.equal(missingUsername.type, 'error');
  assert.match(missingUsername.error, /required/i);
});

test('fillReauthLogin errors cleanly when credentials are present but there is no active session', async () => {
  const result = await fillReauthLogin('no-such-user', { username: 'me', password: 'hunter2' });
  assert.equal(result.type, 'error');
  assert.match(result.error, /no active browser session/i);
});

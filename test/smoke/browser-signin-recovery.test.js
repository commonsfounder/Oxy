const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');

const { handlers } = require('../../api/actions/browser');
const browserAccess = require('../../api/services/browser-access');
const { normalizeActionOutcome } = require('../../api/services/action-outcome');

const MESSAGE_SWIFT = path.join(__dirname, '..', '..', 'OxyApp', 'OxyApp', 'Views', 'Chat', 'MessageBubble.swift');

function stubSignIn(t, result) {
  t.mock.method(browserAccess, 'signInWithStoredCredential', async () => result);
}

test('no stored credential offers the sign-in sheet instead of a dead end', async (t) => {
  stubSignIn(t, { type: 'no_credential', site: 'johnlewis.com' });

  const result = await handlers.browser_sign_in({ userId: 'u1', params: { site: 'johnlewis.com' }, context: {} });

  assert.equal(result.recoveryAction?.type, 'reauth_login');
  assert.equal(result.recoveryAction?.site, 'johnlewis.com');
  assert.equal(result.recoveryAction?.autoContinue, false);
  assert.equal(result.success, false);
});

test('a refused credential grant is reported, never routed around with a sheet', async (t) => {
  stubSignIn(t, { type: 'not_authorized', site: 'johnlewis.com', error: 'no permission', reason: 'no_grant' });

  const result = await handlers.browser_sign_in({ userId: 'u1', params: { site: 'johnlewis.com' }, context: {} });

  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.recoveryAction, undefined, 'a refusal must not offer a way around itself');
});

// iOS gates the sheet on isFailure, which is false for awaiting_user.
test('the outcome is one the iOS client treats as a failure, so the sheet actually shows', async (t) => {
  stubSignIn(t, { type: 'no_credential', site: 'johnlewis.com' });

  const result = normalizeActionOutcome(
    await handlers.browser_sign_in({ userId: 'u1', params: { site: 'johnlewis.com' }, context: {} })
  );

  const failureOutcomes = new Set(['failed', 'unavailable']);
  assert.ok(
    failureOutcomes.has(result.outcome),
    `outcome ${result.outcome} would leave isFailure false and the sheet hidden`
  );
  assert.equal(result.success, false);
  assert.equal(result.recoveryAction?.type, 'reauth_login');
});

test('the recovery type matches the one the iOS client watches for', () => {
  const swift = fs.readFileSync(MESSAGE_SWIFT, 'utf8');
  const watched = [...swift.matchAll(/recoveryAction\?\.type == "([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(watched.includes('reauth_login'), 'MessageBubble no longer watches reauth_login');
});

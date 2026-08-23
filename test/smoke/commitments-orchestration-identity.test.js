// send_email's real orchestration path (api/index.js), with the Google connector's registry
// entry faked — proves the failed-send guard actually short-circuits BEFORE any commitment
// bookkeeping runs, not just that the pure functions would refuse if reached.

require('dotenv').config();

const assert = require('node:assert/strict');
const test = require('node:test');

const app = require('../../api/index');
const { dispatchOverrides } = require('../../connectors');

// send_email is gated on the 'google' connector being enabled for the user (unlike
// cancel_calendar_event/move_calendar_event, which are not in that gate map at all) — so this
// needs a user whose connectors row actually has google enabled. user123 is the one real
// connected account in this dev environment; the registry override below replaces its
// execute function entirely, so no real Gmail call happens despite the gate passing.
const USER_ID = 'user123';
const original = dispatchOverrides.send_email;

test.afterEach(() => { dispatchOverrides.send_email = original; });

test('a failed send never reaches commitment bookkeeping', async () => {
  dispatchOverrides.send_email = { async execute() { return { success: false, error: 'no address on file' }; } };
  const result = await app.executeAction(
    USER_ID,
    'send_email',
    { to: 'Mia', body: 'I will send the report tomorrow.' },
    { enabledConnectors: ['google'] }
  );
  assert.equal(result.success, false);
  assert.equal(result.commitmentCaptured, undefined, 'a promise that was never sent must not be recorded as made');
  assert.equal(result.commitmentsResolved, undefined);
});

test('a successful send with no promise in it captures nothing, and reports nothing to capture', async () => {
  dispatchOverrides.send_email = {
    async execute(_userId, _action, params) {
      return { success: true, messageId: 'm1', threadId: 't1', to: params.to, subject: params.subject };
    }
  };
  const result = await app.executeAction(
    USER_ID,
    'send_email',
    { to: 'ben@example.com', subject: 'Lunch', body: 'See you at noon.' },
    { enabledConnectors: ['google'] }
  );
  assert.equal(result.success, true);
  assert.equal(result.commitmentCaptured, undefined);
});

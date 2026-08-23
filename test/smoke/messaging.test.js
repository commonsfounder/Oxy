const assert = require('node:assert/strict');
const test = require('node:test');

const { executeAction } = require('../../api/index');

// ── Ambiguous recipient handling ────────────────────────────────────────────────────────────
// Regression, 2026-08-07 live verification: resolveNativeMessageContact used contacts.find(),
// which silently returns the FIRST match and builds a real, ready-to-send deep link — even
// when two different people share a name. Reproduced live with two "Sarah"s in nativeHints.

test('send_message: one exact contact match resolves and builds a deep link', async () => {
  const nativeHints = { contacts: [{ displayName: 'Sarah', phone: '+447700900123' }] };
  const result = await executeAction('demo-test-user', 'send_message', { contact: 'Sarah', message: 'hi' }, { nativeHints });
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'awaiting_user');
  assert.equal(result.deepLink, 'sms:%2B447700900123?&body=hi');
});

test('send_message: two contacts with the same name are ambiguous — no deep link, asks which one', async () => {
  const nativeHints = {
    contacts: [
      { displayName: 'Sarah Jones', phone: '+447700900111' },
      { displayName: 'Sarah Kim', phone: '+447700900222' }
    ]
  };
  const result = await executeAction('demo-test-user', 'send_message', { contact: 'Sarah', message: 'hi' }, { nativeHints });
  assert.equal(result.success, false);
  assert.equal(result.deepLink, undefined, 'must not build a message to either candidate');
  assert.match(result.error, /sarah jones/i);
  assert.match(result.error, /sarah kim/i);
  // Only the minimal identifying info (names) — no phone numbers leaked into the clarification.
  assert.doesNotMatch(result.error, /\+447700900111|\+447700900222/);
});

test('send_message: a partial-name match against two different people is also ambiguous', async () => {
  const nativeHints = {
    contacts: [
      { displayName: 'Sarah Jones', phone: '+447700900111' },
      { displayName: 'Sarah Kim Old Number', phone: '+447700900222' }
    ]
  };
  const result = await executeAction('demo-test-user', 'send_message', { contact: 'Sara', message: 'hi' }, { nativeHints });
  assert.equal(result.success, false);
  assert.equal(result.deepLink, undefined);
  assert.match(result.error, /sarah jones/i);
  assert.match(result.error, /sarah kim old number/i);
});

test('send_message: the same contact appearing twice (identical target) is not falsely flagged ambiguous', async () => {
  const nativeHints = {
    contacts: [
      { displayName: 'Sarah', phone: '+447700900123' },
      { displayName: 'Sarah', phone: '+447700900123' }
    ]
  };
  const result = await executeAction('demo-test-user', 'send_message', { contact: 'Sarah', message: 'hi' }, { nativeHints });
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'awaiting_user');
  assert.equal(result.deepLink, 'sms:%2B447700900123?&body=hi');
});

test('send_message: no Contacts permission / no nativeHints at all fails honestly, no deep link', async () => {
  const result = await executeAction('demo-test-user', 'send_message', { contact: 'Sarah', message: 'hi' }, {});
  assert.equal(result.success, false);
  assert.equal(result.deepLink, undefined);
  assert.match(result.error, /phone number|contacts access/i);
});

test('send_message: a literal phone number as the contact resolves directly, no contacts lookup needed', async () => {
  const result = await executeAction('demo-test-user', 'send_message', { contact: '+447700900999', message: 'hi' }, {});
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'awaiting_user');
  assert.equal(result.deepLink, 'sms:%2B447700900999?&body=hi');
});

// ── Dead `send_message` branch ──────────────────────────────────────────────────────────────
// executeAction's switch used to have TWO `case 'send_message':` blocks. JS silently runs only
// the first, so the WhatsApp handoff living in the second was unreachable. The branch was
// removed and its behaviour merged into the reachable case — this proves that path now actually
// executes, and that the reachable case (not a resurrected duplicate) is the one running.
test('send_message: WhatsApp handoff is reachable and produces the wa.me deep link', async () => {
  const nativeHints = { contacts: [{ displayName: 'Sarah', phone: '+447700900123' }] };
  const result = await executeAction('demo-test-user', 'send_message', { contact: 'Sarah', message: 'hi', platform: 'whatsapp' }, { nativeHints });
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'handoff_required');
  assert.equal(result.deepLink, 'https://wa.me/?text=hi');
});

test('send_message: WhatsApp handoff skips contact-ambiguity checks entirely (it never resolves a number)', async () => {
  const nativeHints = {
    contacts: [
      { displayName: 'Sarah Jones', phone: '+447700900111' },
      { displayName: 'Sarah Kim', phone: '+447700900222' }
    ]
  };
  const result = await executeAction('demo-test-user', 'send_message', { contact: 'Sarah', message: 'hi', platform: 'whatsapp' }, { nativeHints });
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'handoff_required');
  assert.equal(result.deepLink, 'https://wa.me/?text=hi');
});

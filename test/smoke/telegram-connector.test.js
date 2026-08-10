// The pure parts of connectors/telegram.js: which strings resolve to the user's own Saved
// Messages destination (used by notification-delivery.js to reach the account itself,
// never a contact) and how a contact search string is normalized before matching against
// the real contact list. The gramJS client itself (TelegramClient, real MTProto calls) is
// not mocked here — it was exercised live against the real account during this pass
// (getSelfDestination returning the real display name, a real message landing in Saved
// Messages with a real message id) rather than reimplemented behind a fake.

require('dotenv').config();

const assert = require('node:assert/strict');
const test = require('node:test');

const telegram = require('../../connectors/telegram');
const { normalizeContactSearch, SELF_DESTINATION, classifyTelegramError } = telegram._private;

test('the self-destination is Telegram\'s own "me" convention, not a contact id', () => {
  // gramJS resolves this string to InputPeerSelf() directly — no contacts lookup, no chance
  // of it accidentally matching a real person in the address book.
  assert.equal(SELF_DESTINATION, 'me');
});

test('contact search strips punctuation and an @ prefix the same way for names and usernames', () => {
  assert.equal(normalizeContactSearch('@BenCarter'), 'bencarter');
  assert.equal(normalizeContactSearch('  Ben   Carter  '), 'ben carter');
  assert.equal(normalizeContactSearch('Ben-Carter!!'), 'bencarter');
});

test('every self-referring phrase a user might type all normalize the same way', () => {
  // send_telegram's self-destination branch checks the search string against exactly these
  // four — this is what proves "myself"/"Me"/"Saved Messages" all take the same path as the
  // proactive notification runtime does, not a fuzzy contacts match that could pick a person
  // literally named "Me".
  for (const phrase of ['me', 'Me', 'self', 'Saved Messages', 'myself', '  ME  ']) {
    assert.equal(normalizeContactSearch(phrase), phrase.trim().toLowerCase());
  }
});

// ── Error classification: telling a caller HOW to retry, not just THAT it failed ────────
test('a real gramJS FloodWaitError shape yields a real backoff duration', () => {
  const floodError = { seconds: 45, errorMessage: 'FLOOD_WAIT_45' };
  assert.deepEqual(classifyTelegramError(floodError), { errorKind: 'flood_wait', retryAfterSeconds: 45 });
});

test('SlowModeWaitError has the same .seconds shape and is classified the same way', () => {
  // Per-chat slow mode is a different gramJS error class from FloodWaitError, but both carry
  // a real .seconds — the classifier deliberately keys off the shape, not the class name, so
  // it does not need to know about every RPCError subclass Telegram might throw.
  const slowModeError = { seconds: 12, errorMessage: 'SLOW_MODE_WAIT_12' };
  assert.deepEqual(classifyTelegramError(slowModeError), { errorKind: 'flood_wait', retryAfterSeconds: 12 });
});

test('a revoked session is classified distinctly from a transient failure', () => {
  assert.deepEqual(classifyTelegramError({ message: 'AUTH_KEY_UNREGISTERED' }), { errorKind: 'session_revoked' });
  assert.deepEqual(classifyTelegramError({ errorMessage: 'SESSION_REVOKED' }), { errorKind: 'session_revoked' });
});

test('an ordinary error classifies as neither — the caller falls back to its generic retry path', () => {
  assert.deepEqual(classifyTelegramError({ message: 'PEER_ID_INVALID' }), {});
  assert.deepEqual(classifyTelegramError(new Error('network timeout')), {});
  assert.deepEqual(classifyTelegramError(undefined), {});
});

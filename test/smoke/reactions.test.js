const test = require('node:test');
const assert = require('node:assert/strict');
const { parseReaction, isReactionMessage, isQuietReply, parseAgentReaction, isAgentReaction, plainReply, QUIET_REPLY } = require('../../api/services/reactions');

test('a reaction message is recognised with its emoji and the quoted text', () => {
  assert.deepEqual(parseReaction('Reacted 👎 to “Booked for Saturday at 10:30”'), {
    emoji: '👎', quoted: 'Booked for Saturday at 10:30'
  });
  assert.equal(isReactionMessage('Reacted ❤️ to “Hey.”'), true);
});

test('ordinary messages are not reactions, even ones that mention reacting', () => {
  assert.equal(isReactionMessage('I reacted badly to that'), false);
  assert.equal(isReactionMessage('yes'), false);
  assert.equal(isReactionMessage('Reacted 👍'), false);
});

test('only the exact quiet marker counts as no reply', () => {
  assert.equal(isQuietReply(QUIET_REPLY), true);
  assert.equal(isQuietReply('  [QUIET] '), true);
  assert.equal(isQuietReply('[quiet] but also this'), false);
  assert.equal(isQuietReply(''), false);
});


test('Adam can answer with a reaction, and only an exact marker counts', () => {
  assert.equal(parseAgentReaction('[react:👍]'), '👍');
  assert.equal(parseAgentReaction('  [react:❤️] '), '❤️');
  assert.equal(isAgentReaction('[react:😂]'), true);
  for (const text of ['[react:👍] glad to help', 'I would [react:👍]', '[react:]', '[react:abcdefghijklmnopqrstuvwxyz]', 'react 👍', '']) {
    assert.equal(isAgentReaction(text), false, JSON.stringify(text));
  }
});

test('where a badge cannot be shown, the reaction is just the emoji', () => {
  assert.equal(plainReply('[react:👍]'), '👍');
  assert.equal(plainReply('Booked it.'), 'Booked it.');
  assert.equal(plainReply(undefined), '');
});

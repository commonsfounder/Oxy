const assert = require('node:assert/strict');
const test = require('node:test');

const { classifyReply } = require('../../api/services/reply-policy');

test('a reply proposing an alternative is classified as needing a decision', () => {
  assert.equal(classifyReply('We can do 8:15 instead, does that work?'), 'ask');
});

test('a purely informational reply is classified as surface-only', () => {
  assert.equal(classifyReply("We're closed on Mondays, sorry!"), 'surface');
});

test('a reply confirming exactly what was asked is surface-only', () => {
  assert.equal(classifyReply('Confirmed, see you at 8pm.'), 'surface');
});

test('a reply asking a question back is classified as needing a decision', () => {
  assert.equal(classifyReply('How many people will be in your party?'), 'ask');
});

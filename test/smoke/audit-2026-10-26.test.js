const test = require('node:test');
const assert = require('node:assert');
const { hasExplicitUserAuthorization } = require('../../api/services/action-execution');

test('a filler word in the contact name does not count as naming the recipient', () => {
  const send = (contact) => ({ type: 'send_telegram', input: { contact, message: 'hi' } });
  assert.equal(hasExplicitUserAuthorization(send('My Boss'), 'text my sister that I am late'), false);
  assert.equal(hasExplicitUserAuthorization(send('Arina'), 'text Arina that I am late'), true);
});

test('chained questions and live-fact comparisons get the multi-step loop, plain ones do not', () => {
  const { shouldUseAgenticLoopForMessage: agentic } = require('../../api/index');
  assert.equal(agentic({ message: 'Who directed Paddington 2, what is the most recent film they directed, and is that film rated higher or lower than Paddington 2 on Rotten Tomatoes?' }), true);
  assert.equal(agentic({ message: 'Compare the tallest building in Birmingham with the tallest in Manchester: give both heights.' }), true);
  assert.equal(agentic({ message: 'Who directed Paddington 2?' }), false);
  assert.equal(agentic({ message: 'Compare cats and dogs as pets' }), false);
});

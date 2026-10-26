const test = require('node:test');
const assert = require('node:assert');
const { hasExplicitUserAuthorization } = require('../../api/services/action-execution');

test('a filler word in the contact name does not count as naming the recipient', () => {
  const send = (contact) => ({ type: 'send_telegram', input: { contact, message: 'hi' } });
  assert.equal(hasExplicitUserAuthorization(send('My Boss'), 'text my sister that I am late'), false);
  assert.equal(hasExplicitUserAuthorization(send('Arina'), 'text Arina that I am late'), true);
});

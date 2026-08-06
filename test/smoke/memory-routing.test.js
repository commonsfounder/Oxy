const assert = require('node:assert/strict');
const test = require('node:test');

const { parseExplicitMemoryRequest } = require('../../api/index');

test('explicit memory requests keep the useful fact and remove the command', () => {
  assert.equal(
    parseExplicitMemoryRequest('Millie, remember that my usual station is Birmingham New Street.'),
    'my usual station is Birmingham New Street'
  );
  assert.equal(
    parseExplicitMemoryRequest('please remember my partner is Sam'),
    'my partner is Sam'
  );
});

test('ambiguous memory follow-ups stay with the conversation brain', () => {
  assert.equal(parseExplicitMemoryRequest('remember it'), null);
  assert.equal(parseExplicitMemoryRequest('what matters today?'), null);
});

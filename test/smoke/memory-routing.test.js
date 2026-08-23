const assert = require('node:assert/strict');
const test = require('node:test');

const { parseExplicitMemoryRequest, parseStructuredMemoryRequest } = require('../../api/index');

test('specific memory statements use durable action contracts', () => {
  assert.deepEqual(
    parseStructuredMemoryRequest('Remember that I said I will send the tenancy documents this week.'),
    { type: 'track_commitment', input: { what: 'send the tenancy documents', due: 'this week', source: 'stated' } }
  );
  assert.deepEqual(
    parseStructuredMemoryRequest('Remember that Alex has a birthday on 14 September.'),
    { type: 'save_occasion', input: { person_name: 'Alex', occasion_type: 'birthday', month: 9, day: 14 } }
  );
  assert.deepEqual(
    parseStructuredMemoryRequest('Remember that Alex prefers vegetarian restaurants.'),
    { type: 'remember_person', input: { person_name: 'Alex', facts: 'prefers vegetarian restaurants', fact_kind: 'preference' } }
  );
  assert.equal(parseStructuredMemoryRequest('Remember that my usual station is Birmingham New Street.'), null);
});

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

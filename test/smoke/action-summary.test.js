const assert = require('node:assert/strict');
const test = require('node:test');

const { describeAction } = require('../../api/services/action-summary');

test('searches read as what was searched for', () => {
  const out = describeAction({ type: 'web_search', query: 'replacement AirPods case' });
  assert.equal(out.summary, 'Searched for replacement AirPods case');
  assert.equal(out.kind, 'looked');
  assert.equal(out.hidden, false);
});

test('parameters nested under params are understood too', () => {
  const out = describeAction({ type: 'send_message', params: { contact: 'Sarah', message: 'dinner?' } });
  assert.equal(out.summary, 'Messaged Sarah');
  assert.equal(out.kind, 'sent');
});

test('place lookups and directions are marked as using location', () => {
  assert.equal(describeAction({ type: 'find_place', query: 'electronics shops' }).usedLocation, true);
  assert.equal(describeAction({ type: 'get_directions', destination: 'Birmingham New Street' }).usedLocation, true);
  assert.equal(describeAction({ type: 'web_search', query: 'x' }).usedLocation, false);
});

test('internal bookkeeping actions are hidden from the everyday list', () => {
  assert.equal(describeAction({ type: 'workspace_write' }).hidden, true);
  assert.equal(describeAction({ type: 'simulate_actions' }).hidden, true);
  assert.equal(describeAction({ type: 'web_search', query: 'x' }).hidden, false);
});

test('unknown types fall back to the contract wording, then to the spaced type', () => {
  assert.equal(describeAction({ type: 'mystery_thing' }, { successSummary: 'Did the thing' }).summary, 'Did the thing');
  assert.equal(describeAction({ type: 'mystery_thing' }).summary, 'Mystery thing');
});

test('long or missing values never produce a broken sentence', () => {
  const long = describeAction({ type: 'web_search', query: 'a'.repeat(200) }).summary;
  assert.ok(long.length < 80);
  assert.equal(describeAction({ type: 'web_search' }).summary, 'Searched for something');
  assert.equal(describeAction(null).summary, 'Unknown');
});

const assert = require('node:assert/strict');
const test = require('node:test');

const { inferDeterministicAction } = require('../../api/intent-router');

test('nearest McDonald’s routes to find_place, not Uber', () => {
  const routed = inferDeterministicAction("nearest McDonald's");
  assert.equal(routed.reason, 'find_local_place');
  assert.deepEqual(routed.actions, [
    { type: 'find_place', input: { query: "nearest McDonald's" } }
  ]);
});

test('coffee near me routes to find_place with casual phrase preserved', () => {
  const routed = inferDeterministicAction('coffee near me');
  assert.equal(routed.actions[0].type, 'find_place');
  assert.equal(routed.actions[0].input.query, 'coffee near me');
});

test('Uber to nearest McDonald’s routes to book_uber', () => {
  const routed = inferDeterministicAction("get me an Uber to the nearest McDonald's");
  assert.equal(routed.reason, 'ride_to_local_place');
  assert.equal(routed.actions[0].type, 'book_uber');
  assert.match(routed.actions[0].input.destination, /nearest McDonald's/i);
});

test('Uber to that John Lewis cleans conversational reference words', () => {
  const routed = inferDeterministicAction('okay get me an uber to that john lewis please');
  assert.equal(routed.reason, 'ride_to_local_place');
  assert.equal(routed.actions[0].type, 'book_uber');
  assert.equal(routed.actions[0].input.destination, 'john lewis');
});

test('bus requests route to transit directions instead of place lookup', () => {
  const routed = inferDeterministicAction('i need to be at john lewis solihull by 7:30 what bus can i take?');
  assert.equal(routed.reason, 'transit_directions_to_place');
  assert.equal(routed.actions[0].type, 'get_directions');
  assert.deepEqual(routed.actions[0].input, {
    destination: 'john lewis solihull',
    mode: 'transit',
    arrival_time: '7:30'
  });
});

test('plain factual question does not become local place action', () => {
  assert.equal(inferDeterministicAction('what is McDonald’s revenue?'), null);
});

test('casual nearest-place question strips filler wording', () => {
  const routed = inferDeterministicAction("can you tell me where the nearest mcdonald's is");
  assert.equal(routed.reason, 'find_local_place');
  assert.equal(routed.actions[0].type, 'find_place');
  assert.equal(routed.actions[0].input.query, "the nearest mcdonald's");
});

test('speechy nearest-place question strips trailing filler', () => {
  const routed = inferDeterministicAction("what is the next nearest mcdonald's to me is?");
  assert.equal(routed.reason, 'find_local_place');
  assert.equal(routed.actions[0].type, 'find_place');
  assert.equal(routed.actions[0].input.query, "the nearest mcdonald's");
});

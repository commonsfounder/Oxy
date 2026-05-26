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

test('plain factual question does not become local place action', () => {
  assert.equal(inferDeterministicAction('what is McDonald’s revenue?'), null);
});

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

test('nearest Aldi routes to a fresh place lookup', () => {
  const routed = inferDeterministicAction('nearest Aldi?');
  assert.equal(routed.reason, 'find_local_place');
  assert.deepEqual(routed.actions, [
    { type: 'find_place', input: { query: 'nearest Aldi' } }
  ]);
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

test('bus requests to arbitrary destinations route to transit directions', () => {
  const routed = inferDeterministicAction('what bus can i take to selfridges birmingham');
  assert.equal(routed.reason, 'transit_directions_to_place');
  assert.equal(routed.actions[0].type, 'get_directions');
  assert.deepEqual(routed.actions[0].input, {
    destination: 'selfridges birmingham',
    mode: 'transit'
  });
});

test('leave-time directions use preferred transport when no mode is explicit', () => {
  const routed = inferDeterministicAction(
    'when should i leave the house if i want to get to selfridges by 9:30 pm',
    { settings: { preferredTransportMode: 'transit' } }
  );
  assert.equal(routed.reason, 'transit_directions_to_place');
  assert.equal(routed.actions[0].type, 'get_directions');
  assert.deepEqual(routed.actions[0].input, {
    destination: 'selfridges',
    mode: 'transit',
    arrival_time: '9:30 pm'
  });
});

test('future train journey requests route to rail-first trip planning, not live rail', () => {
  const routed = inferDeterministicAction('what train can i take tomorrow around 9am heading to apsley');
  assert.equal(routed.reason, 'rail_first_trip_plan');
  assert.equal(routed.actions[0].type, 'plan_trip');
  assert.deepEqual(routed.actions[0].input, {
    destination: 'apsley',
    departure_time: 'tomorrow 9am',
    preference: 'balanced'
  });
});

test('train journey with explicit origin keeps from and to for trip planning', () => {
  const routed = inferDeterministicAction('what train can i take from birmingham new street to apsley tomorrow around 9am');
  assert.equal(routed.reason, 'rail_first_trip_plan');
  assert.equal(routed.actions[0].type, 'plan_trip');
  assert.deepEqual(routed.actions[0].input, {
    origin: 'birmingham new street',
    destination: 'apsley',
    departure_time: 'tomorrow 9am',
    preference: 'balanced'
  });
});

test('future first train request routes to rail-first trip planning', () => {
  const routed = inferDeterministicAction("when's the first train to london euston tomorrow");
  assert.equal(routed.reason, 'rail_first_trip_plan');
  assert.equal(routed.actions[0].type, 'plan_trip');
  assert.deepEqual(routed.actions[0].input, {
    destination: 'london euston',
    departure_time: 'tomorrow 00:01',
    preference: 'fastest'
  });
});

test('direct train preference is preserved for trip planning', () => {
  const routed = inferDeterministicAction('can i take a direct train to london with no changes tomorrow');
  assert.equal(routed.reason, 'rail_first_trip_plan');
  assert.equal(routed.actions[0].type, 'plan_trip');
  assert.equal(routed.actions[0].input.destination, 'london');
  assert.equal(routed.actions[0].input.preference, 'fewest_changes');
});

test('vague train follow-up does not become a fake destination', () => {
  assert.equal(inferDeterministicAction('yeah but what train is it tomorrow'), null);
});

test('live station board requests route to station_board', () => {
  const routed = inferDeterministicAction('departures from milton keynes central');
  assert.equal(routed.reason, 'live_station_board');
  assert.equal(routed.actions[0].type, 'station_board');
  assert.deepEqual(routed.actions[0].input, { station: 'milton keynes central' });
});

test('live train between stations routes to search_trains', () => {
  const routed = inferDeterministicAction('next train from milton keynes central to birmingham new street');
  assert.equal(routed.reason, 'live_train_between_stations');
  assert.equal(routed.actions[0].type, 'search_trains');
  assert.deepEqual(routed.actions[0].input, {
    origin: 'milton keynes central',
    destination: 'birmingham new street'
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

test('memory writes do not become place lookups', () => {
  assert.equal(inferDeterministicAction('remember my usual station is either Birmingham International or Birmingham New Street'), null);
  assert.equal(inferDeterministicAction('my usual station is Birmingham New Street'), null);
});

test('contextual closest-place follow-up does not search a fake new place', () => {
  assert.equal(inferDeterministicAction('is that definitely the closest one'), null);
});

test('contextual travel follow-ups defer to conversation context', () => {
  assert.equal(inferDeterministicAction('can i get there by 7:30'), null);
  assert.equal(inferDeterministicAction('can i take a direct train with no changes'), null);
  assert.equal(inferDeterministicAction('what train is it'), null);
});

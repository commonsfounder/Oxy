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

test('a meeting time is an arrival deadline, never a departure time', () => {
  const routed = inferDeterministicAction('how do i get to selfridges, i have a meeting at 9');
  assert.equal(routed.actions[0].type, 'get_directions');
  assert.equal(routed.actions[0].input.arrival_time, '9');
  assert.equal(routed.actions[0].input.departure_time, undefined);
});

test('an explicit leaving time is a departure time', () => {
  const routed = inferDeterministicAction('how do i get to selfridges if i leave at 6');
  assert.equal(routed.actions[0].type, 'get_directions');
  assert.equal(routed.actions[0].input.departure_time, '6');
  assert.equal(routed.actions[0].input.arrival_time, undefined);
});

test('future train journey requests defer to grounded answer instead of route connector', () => {
  assert.equal(inferDeterministicAction('what train can i take tomorrow around 9am heading to apsley'), null);
});

test('train journey with explicit origin defers to grounded answer instead of route connector', () => {
  assert.equal(inferDeterministicAction('what train can i take from birmingham new street to apsley tomorrow around 9am'), null);
});

test('future first train request defers to grounded answer instead of route connector', () => {
  assert.equal(inferDeterministicAction("when's the first train to london euston tomorrow"), null);
});

test('direct train preference defers to grounded answer instead of route connector', () => {
  assert.equal(inferDeterministicAction('can i take a direct train to london with no changes tomorrow'), null);
});

test('vague train follow-up does not become a fake destination', () => {
  assert.equal(inferDeterministicAction('yeah but what train is it tomorrow'), null);
});

test('live station board requests defer to grounded answer instead of route connector', () => {
  assert.equal(inferDeterministicAction('departures from milton keynes central'), null);
});

test('live train between stations defers to grounded answer instead of route connector', () => {
  assert.equal(inferDeterministicAction('next train from milton keynes central to birmingham new street'), null);
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
  assert.equal(inferDeterministicAction("yes directions please i'm taking the bus"), null);
  assert.equal(inferDeterministicAction('what train is it'), null);
});

test('buying a product FROM a named retailer is NOT a place lookup', () => {
  // The reported bug: "john lewis" is a LOCAL_PLACE_TERM, so a shopping request matched
  // find_place. A purchase from a retailer must defer to the LLM/browser-task path (null).
  assert.equal(inferDeterministicAction('get me some seersucker white pyjamas on john lewis'), null);
  assert.equal(inferDeterministicAction('buy me a kettle from currys'), null);
  assert.equal(inferDeterministicAction('order me a pizza from dominos'), null);
  assert.equal(inferDeterministicAction('add a cordless drill to my basket on screwfix'), null);
  assert.equal(inferDeterministicAction('find me nike air max trainers on nike'), null);
});

test('locating a nearby branch still routes to find_place', () => {
  // The guard must be precise: navigating TO a shop is still a place request.
  assert.equal(inferDeterministicAction('nearest john lewis').actions[0].type, 'find_place');
  assert.equal(inferDeterministicAction('is there a john lewis near me').actions[0].type, 'find_place');
  assert.equal(inferDeterministicAction('closest currys to me').actions[0].type, 'find_place');
});

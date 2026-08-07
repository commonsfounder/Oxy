const assert = require('node:assert/strict');
const test = require('node:test');

const { inferDeterministicAction, buildWatchRequest, buildWatchCancellation, cleanDestinationPhrase } = require('../../api/intent-router');

// ── Question-opener filler stripped from place/directions queries ─────────────────────────
// Regression, 2026-08-07 live verification: "is there a gym near Old Street" reached
// find_place with the opener still attached, feeding a non-address sentence to strict
// geocoding once Places match failed. See the matching geocoding.test.js suite for the
// downstream token-matching half of this fix.
test('cleanDestinationPhrase strips "is there a" / "are there any" / "do you know if there\'s" openers', () => {
  assert.equal(cleanDestinationPhrase('is there a gym near Old Street'), 'gym near Old Street');
  assert.equal(cleanDestinationPhrase('are there any decent gyms around here'), 'decent gyms around here');
  assert.equal(cleanDestinationPhrase("do you know if there's a coffee shop near me"), 'coffee shop near me');
  assert.equal(cleanDestinationPhrase('is there anywhere good to eat near Old Street?'), 'good to eat near Old Street');
});

test('cleanDestinationPhrase does not truncate "any"/"anywhere" to a bare "a"', () => {
  assert.equal(cleanDestinationPhrase('are there any decent gyms'), 'decent gyms');
  assert.equal(cleanDestinationPhrase('is there anywhere good to eat'), 'good to eat');
});

test('find a gym near Old Street: still resolves via the deterministic local-place route with these openers stripped upstream', () => {
  const routed = inferDeterministicAction('is there a gym near Old Street');
  assert.equal(routed.reason, 'find_local_place');
  assert.equal(routed.actions[0].input.query, 'gym near Old Street');
});

// ── A place-keyword collision must not eat a communication request ────────────────────────
// Regression, 2026-08-07 live verification: "restaurant" sits in LOCAL_PLACE_TERMS, so any
// sentence mentioning one — even a plain request to email/text/contact them about something —
// fell through to the find_local_place fallback and was routed as a nearby-place search before
// the model ever saw it. Narrow fix, mirrors the existing looksLikeShoppingRequest guard
// immediately above the same fallback in api/intent-router.js.
test('a request to email a restaurant about a booking does not become a nearby-place search', () => {
  assert.equal(inferDeterministicAction('Send an email to test-business@example.com asking if they can move our 7pm restaurant booking to 8pm tonight.'), null);
});

test('"email the restaurant and ask if they can move us to 8" defers to the model, not find_place', () => {
  assert.equal(inferDeterministicAction('email the restaurant and ask if they can move us to 8'), null);
});

test('"text the restaurant" and "contact the restaurant" also defer, not just "email"', () => {
  assert.equal(inferDeterministicAction('text the restaurant to ask about our booking'), null);
  assert.equal(inferDeterministicAction('contact the restaurant about tonight'), null);
});

test('a literal email address anywhere in the message defers, regardless of wording', () => {
  assert.equal(inferDeterministicAction('let reservations@bistro.example know we are running late'), null);
});

test('an ordinary "find a restaurant near me" with no communication verb still routes to find_place', () => {
  const routed = inferDeterministicAction('find a restaurant near me');
  assert.equal(routed.reason, 'find_local_place');
  assert.equal(routed.actions[0].type, 'find_place');
});

test('"nearest restaurant" (no email/text/contact wording) is unaffected by the fix', () => {
  const routed = inferDeterministicAction('nearest restaurant');
  assert.equal(routed.reason, 'find_local_place');
});

test('clear flight price watches become bounded daily background checks', () => {
  const routed = inferDeterministicAction('Millie, watch flight prices to Turkey and tell me when a cheaper option appears');
  assert.equal(routed.reason, 'durable_price_watch');
  assert.equal(routed.actions[0].type, 'create_scheduled_task');
  assert.deepEqual(routed.actions[0].input, {
    title: 'flight prices to Turkey',
    instruction: 'watch flight prices to Turkey and tell me when a cheaper option appears',
    condition: 'a cheaper option appears',
    recurrence: 'poll',
    interval_minutes: 1440
  });
  assert.match(routed.spoken, /once a day/);
});

test('watch request cadence is preserved when the user gives one', () => {
  const watch = buildWatchRequest('monitor hotel prices every week until they fall');
  assert.equal(watch.title, 'hotel prices');
  assert.equal(watch.interval_minutes, 10080);
  assert.equal(watch.condition, 'they fall');
});

test('ordinary order tracking does not become a durable watch', () => {
  assert.equal(inferDeterministicAction('track my order'), null);
});

test('a one-time price check does not become a durable watch', () => {
  assert.equal(inferDeterministicAction('check flight prices to Turkey'), null);
});

test('clear watch cancellation becomes a safe stop action', () => {
  const routed = inferDeterministicAction('Millie, stop watching flight prices to Turkey');
  assert.equal(routed.reason, 'stop_durable_watch');
  assert.deepEqual(routed.actions, [{
    type: 'cancel_scheduled_task',
    input: { title: 'flight prices to Turkey' }
  }]);
  assert.equal(buildWatchCancellation('cancel the watch for hotel prices'), 'hotel prices');
});

test('an appointment request starts the appointment flow', () => {
  const routed = inferDeterministicAction('Millie, get me a dentist appointment next week after work');
  assert.equal(routed.reason, 'appointment_booking');
  assert.deepEqual(routed.actions, [{
    type: 'find_appointment_options',
    input: { request: 'Millie, get me a dentist appointment next week after work' }
  }]);
});

test('nearest McDonald’s routes to find_place, not Uber', () => {
  const routed = inferDeterministicAction("nearest McDonald's");
  assert.equal(routed.reason, 'find_local_place');
  assert.deepEqual(routed.actions, [
    { type: 'find_place', input: { query: "nearest McDonald's" } }
  ]);
});

test('bare "Get directions" with no destination defers to the LLM instead of routing to itself', () => {
  // Starter suggestion chips send the bare label. Without an actual place the router
  // must NOT fabricate destination="Get directions" — it should return null so the
  // model asks "where to?".
  assert.equal(inferDeterministicAction('Get directions'), null);
  assert.equal(inferDeterministicAction('directions'), null);
  assert.equal(inferDeterministicAction('directions please'), null);
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

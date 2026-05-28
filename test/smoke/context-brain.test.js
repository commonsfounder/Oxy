const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extractSongFromText,
  isContextualReference,
  resolveContextualTurn
} = require('../../api/services/context-brain');
const { getSearchReason, needsSearch } = require('../../api/services/search-intent');

test('context brain resolves play it from latest assistant song answer', () => {
  const turn = resolveContextualTurn({
    message: 'play it',
    history: [
      {
        role: 'assistant',
        content: 'The most popular song on the Billboard Hot 100 right now is "Janice STFU" by Drake.'
      }
    ]
  });
  assert.equal(turn.reason, 'contextual_play_media');
  assert.deepEqual(turn.actions, [
    { type: 'play_music', input: { query: 'Janice STFU by Drake' } }
  ]);
});

test('context brain prefers the latest assistant media over older played music action', () => {
  const turn = resolveContextualTurn({
    message: 'play it',
    history: [
      {
        role: 'assistant',
        content: 'Playing Devil’s Advocate by The Neighbourhood.',
        actions: [{ action: 'play_music', success: true, text: 'Playing Devil’s Advocate by The Neighbourhood.', cardText: 'Devil’s Advocate · The Neighbourhood' }]
      },
      {
        role: 'assistant',
        content: 'The most popular song on the Billboard Hot 100 right now is "Janice STFU" by Drake.'
      }
    ]
  });
  assert.equal(turn.actions[0].input.query, 'Janice STFU by Drake');
});

test('context brain books Uber to the previous place target', () => {
  const turn = resolveContextualTurn({
    message: 'get me an uber there',
    recentActions: [
      { type: 'find_place', input: { query: 'nearest Aldi' }, status: 'executed', resultText: 'ALDI, New Coventry Rd, Birmingham B26 3HP' }
    ]
  });
  assert.equal(turn.reason, 'contextual_uber_to_place');
  assert.equal(turn.actions[0].type, 'book_uber');
  assert.match(turn.actions[0].input.destination, /nearest Aldi|ALDI/i);
});

test('context brain answers remembered usual station from memory', () => {
  const turn = resolveContextualTurn({
    message: 'do you remember what my usual station is',
    memory: 'User’s usual station is Birmingham New Street'
  });
  assert.equal(turn.reason, 'memory_usual_station');
  assert.equal(turn.spokenOnly, true);
  assert.match(turn.spoken, /Birmingham New Street/);
});

test('context brain reuses route for what about tomorrow', () => {
  const turn = resolveContextualTurn({
    message: 'what about tomorrow',
    recentActions: [
      { type: 'plan_trip', input: { origin: 'Birmingham New Street', destination: 'Apsley', preference: 'balanced' }, status: 'executed' }
    ]
  });
  assert.equal(turn.reason, 'contextual_trip_tomorrow');
  assert.equal(turn.actions[0].type, 'plan_trip');
  assert.equal(turn.actions[0].input.destination, 'Apsley');
  assert.equal(turn.actions[0].input.departure_time, 'tomorrow');
});

test('context brain answers next bus confirmation from last route without model fallback', () => {
  const turn = resolveContextualTurn({
    message: "so that's the next bus?",
    recentActions: [
      {
        type: 'get_directions',
        input: { destination: 'John Lewis Solihull', mode: 'transit' },
        status: 'executed',
        result: {
          text: 'You should leave around 4:17 AM.',
          itinerary: [
            { type: 'transit', service: 'National Express Coventry X1', departure: '4:22 AM', from: 'Steyning Road', to: 'Adderley Street', arrival: '4:36 AM' }
          ]
        }
      }
    ]
  });
  assert.equal(turn.reason, 'contextual_confirm_next_bus');
  assert.equal(turn.spokenOnly, true);
  assert.match(turn.spoken, /National Express Coventry X1/);
});

test('context brain explains route failure for why not without model fallback', () => {
  const turn = resolveContextualTurn({
    message: 'why not?',
    recentActions: [
      {
        type: 'plan_trip',
        input: { destination: 'Apsley', preference: 'balanced' },
        status: 'executed',
        result: {
          text: "I couldn't get a reliable transit route summary to Apsley right now.",
          routeContext: { reason: 'route_summary_unavailable' }
        }
      }
    ]
  });
  assert.equal(turn.reason, 'contextual_route_failure_explanation');
  assert.equal(turn.spokenOnly, true);
  assert.match(turn.spoken, /route source did not return a usable itinerary/i);
});

test('train timetable questions request search grounding instead of stale route tools', () => {
  assert.equal(getSearchReason('next train from Birmingham New Street to Apsley'), 'public-transport-live');
  assert.equal(getSearchReason('what train can i take tomorrow around 9am'), 'public-transport-live');
});

test('context brain sends the latest assistant content to a named contact', () => {
  const turn = resolveContextualTurn({
    message: 'send it to Josh',
    history: [
      { role: 'assistant', content: 'Here is the summary: Oxy needs a universal context layer.' }
    ]
  });
  assert.equal(turn.reason, 'contextual_send_content');
  assert.equal(turn.actions[0].type, 'send_message');
  assert.equal(turn.actions[0].input.contact, 'Josh');
  assert.match(turn.actions[0].input.message, /universal context layer/);
});

test('context brain asks a clarification for do it with no target', () => {
  const turn = resolveContextualTurn({ message: 'do it' });
  assert.equal(turn.reason, 'ambiguous_contextual_reference');
  assert.equal(turn.spokenOnly, true);
});

test('context brain opens directions to the latest place', () => {
  const turn = resolveContextualTurn({
    message: 'open the nearest one',
    recentActions: [
      { type: 'find_place', input: { query: 'nearest pharmacy' }, status: 'executed', resultText: 'Boots, 12 High Street' }
    ],
    settings: { preferredTransportMode: 'walking' }
  });
  assert.equal(turn.reason, 'contextual_open_target');
  assert.equal(turn.actions[0].type, 'get_directions');
  assert.equal(turn.actions[0].input.mode, 'walking');
  assert.match(turn.actions[0].input.destination, /nearest pharmacy|Boots/i);
});

test('context brain does not invent a target for play it without media context', () => {
  const turn = resolveContextualTurn({
    message: 'play it',
    history: [{ role: 'assistant', content: 'I can help with that.' }]
  });
  assert.equal(turn?.actions, undefined);
});

test('contextual reference detector catches corrections and tomorrow follow-ups', () => {
  assert.equal(isContextualReference('no I mean calendar tomorrow'), true);
  assert.equal(isContextualReference('what about tomorrow'), true);
  assert.equal(isContextualReference('the other one'), true);
  assert.equal(isContextualReference('why not?'), true);
  assert.equal(isContextualReference('nearest Aldi'), false);
});

test('fact check follow-ups trigger search grounding', () => {
  assert.equal(isContextualReference('is that right'), true);
  assert.equal(needsSearch('is that right'), true);
  assert.equal(getSearchReason('is that right'), 'contextual-fact-check');
});

test('song extraction handles quoted chart answers', () => {
  assert.equal(
    extractSongFromText('The number one is "Janice STFU" by Drake.'),
    'Janice STFU by Drake'
  );
  assert.equal(
    extractSongFromText('Drake’s "Janice STFU" is sitting at #1 right now.'),
    'Janice STFU by Drake'
  );
});

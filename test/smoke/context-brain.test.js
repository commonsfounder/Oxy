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
});

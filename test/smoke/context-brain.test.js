const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extractAssistantContexts,
  extractSongFromText,
  isContextualReference
} = require('../../api/services/context-brain');
const { getSearchReason, needsSearch } = require('../../api/services/search-intent');

test('train timetable questions request search grounding instead of stale route tools', () => {
  assert.equal(getSearchReason('next train from Birmingham New Street to Apsley'), 'public-transport-live');
  assert.equal(getSearchReason('what train can i take tomorrow around 9am'), 'public-transport-live');
  assert.equal(getSearchReason('what platform'), 'public-transport-live');
});

test('context brain keeps route context from assistant train answers for platform follow-ups', () => {
  const contexts = extractAssistantContexts([
    {
      role: 'assistant',
      content: "The first train from Birmingham New Street to Apsley today is at 05:30. It's a direct service."
    }
  ]);
  const route = contexts.find(ctx => ctx.kind === 'route');
  assert.equal(isContextualReference('what platform'), true);
  assert.equal(route.label, 'Birmingham New Street to Apsley');
  assert.deepEqual(route.input, {
    origin: 'Birmingham New Street',
    destination: 'Apsley',
    departure_time: '05:30'
  });
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

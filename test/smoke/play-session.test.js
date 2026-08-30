'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { handlers } = require('../../api/actions/play');
const { MAX_ROUNDS, QUESTIONS } = require('../../api/services/play-sessions');
const { resolveContextualTurn } = require('../../api/services/context-brain');

test('starting trivia creates a bounded question with an exact answer selection', async () => {
  const result = await handlers.play_game({
    params: { game: 'trivia' },
    context: {}
  });

  assert.equal(result.success, true);
  assert.match(result.text, /1\./);
  assert.match(result.text, /2\./);
  assert.match(result.text, /3\./);
  assert.equal(result.selection.action.type, 'play_game');
  assert.equal(result.selection.action.input.operation, 'answer');
  assert.ok(result.selection.action.input.question_id);
  assert.equal(result.selection.options.length, 3);
  assert.equal(result.selection.options[0].input.choice_id, result.selection.options[0].id);
});

test('a natural numbered answer resolves to the exact play action and advances the session', async () => {
  const first = await handlers.play_game({ params: { game: 'trivia' }, context: {} });
  const history = [{
    role: 'assistant',
    content: first.text,
    actions: [{ action: 'play_game', result: first }]
  }];
  const resolved = resolveContextualTurn({ message: 'the first one', history, recentActions: [] });

  assert.equal(resolved.reason, 'context_selection_selected');
  const second = await handlers.play_game({ params: resolved.actions[0].input, context: {} });
  assert.equal(second.success, true);
  assert.match(second.text, /Round 2/);
  assert.notEqual(second.selection.action.input.question_id, first.selection.action.input.question_id);
});

test('a spoken answer that repeats the visible choice resolves without requiring an ordinal', async () => {
  const first = await handlers.play_game({ params: { game: 'trivia' }, context: {} });
  const history = [{
    role: 'assistant',
    content: first.text,
    actions: [{ action: 'play_game', result: first }]
  }];
  const spokenAnswer = first.selection.options[0].label.toLowerCase();
  const resolved = resolveContextualTurn({ message: spokenAnswer, history, recentActions: [] });

  assert.equal(resolved.reason, 'context_selection_selected');
  assert.equal(resolved.actions[0].input.choice_id, first.selection.options[0].id);
});

test('finishing trivia offers a fresh one-tap rematch', async () => {
  let turn = await handlers.play_game({ params: { game: 'trivia' }, context: {} });
  const firstSessionId = turn.sessionId;

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const question = QUESTIONS.find(candidate => candidate.id === turn.selection.action.input.question_id);
    turn = await handlers.play_game({
      params: { ...turn.selection.action.input, choice_id: question.answer },
      context: {}
    });
  }

  assert.equal(turn.finished, true);
  assert.equal(turn.selection.action.type, 'play_game');
  assert.equal(turn.selection.action.input.operation, 'start');

  const resolved = resolveContextualTurn({
    message: 'play again',
    history: [{ role: 'assistant', content: turn.text, actions: [{ action: 'play_game', result: turn }] }],
    recentActions: []
  });
  assert.equal(resolved.reason, 'context_selection_selected');
  const rematch = await handlers.play_game({ params: resolved.actions[0].input, context: {} });
  assert.equal(rematch.finished, false);
  assert.match(rematch.text, /Round 1 of 5/);
  assert.notEqual(rematch.sessionId, firstSessionId);
});

test('trivia refuses unknown games and malformed answers without pretending a turn happened', async () => {
  const unknown = await handlers.play_game({ params: { game: 'roulette' }, context: {} });
  assert.equal(unknown.success, false);

  const malformed = await handlers.play_game({
    params: { game: 'trivia', operation: 'answer', session_id: 'session-1', question_id: 'missing', choice_id: '1' },
    context: {}
  });
  assert.equal(malformed.success, false);
});

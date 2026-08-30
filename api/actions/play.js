'use strict';

const { createActionSelection } = require('../services/action-selection');
const playSessions = require('../services/play-sessions');

function selectionFor(result) {
  if (result?.finished) {
    return createActionSelection({
      actionType: 'play_game',
      actionInput: { game: 'trivia', operation: 'start' },
      options: [{
        id: 'rematch',
        label: 'Play again',
        command: 'play again',
        input: {}
      }]
    });
  }
  if (!result?.question || !result.receipt) return null;
  return createActionSelection({
    actionType: 'play_game',
    actionInput: result.receipt,
    options: result.question.choices.map((choice, index) => ({
      id: choice.id,
      label: choice.label,
      command: `choose option ${index + 1}`,
      input: { choice_id: choice.id }
    }))
  });
}

async function playGame({ params } = {}) {
  const game = String(params?.game || '').trim().toLowerCase();
  if (game !== 'trivia') return { success: false, error: 'I can play trivia right now.' };

  const operation = String(params?.operation || 'start').trim().toLowerCase();
  const result = operation === 'answer'
    ? playSessions.answerTrivia({
      sessionId: params?.session_id,
      questionId: params?.question_id,
      choiceId: params?.choice_id,
      round: params?.round,
      score: params?.score
    })
    : playSessions.startTrivia({ sessionId: params?.session_id });
  if (!result.success && result.error) return result;

  const selection = selectionFor(result);
  return {
    success: true,
    text: result.text,
    cardText: result.text,
    actionSummary: result.finished ? 'Game finished' : 'Game in progress',
    ...(selection ? { selection } : {}),
    game,
    sessionId: result.sessionId,
    round: result.round,
    score: result.score,
    finished: result.finished === true
  };
}

module.exports = {
  handlers: {
    play_game: playGame
  }
};

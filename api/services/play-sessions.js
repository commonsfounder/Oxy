'use strict';

const crypto = require('node:crypto');

const MAX_ROUNDS = 5;
const QUESTIONS = Object.freeze([
  {
    id: 'animal-flight',
    prompt: 'Which animal is the only mammal capable of true flight?',
    choices: [
      { id: 'bat', label: 'A bat' },
      { id: 'penguin', label: 'A penguin' },
      { id: 'flying-squirrel', label: 'A flying squirrel' }
    ],
    answer: 'bat'
  },
  {
    id: 'bee-food',
    prompt: 'What do bees collect from flowers to make honey?',
    choices: [
      { id: 'nectar', label: 'Nectar' },
      { id: 'dew', label: 'Dew' },
      { id: 'sap', label: 'Tree sap' }
    ],
    answer: 'nectar'
  },
  {
    id: 'octagon',
    prompt: 'How many sides does an octagon have?',
    choices: [
      { id: 'six', label: 'Six' },
      { id: 'eight', label: 'Eight' },
      { id: 'ten', label: 'Ten' }
    ],
    answer: 'eight'
  },
  {
    id: 'red-planet',
    prompt: 'Which planet is known as the Red Planet?',
    choices: [
      { id: 'mars', label: 'Mars' },
      { id: 'venus', label: 'Venus' },
      { id: 'mercury', label: 'Mercury' }
    ],
    answer: 'mars'
  },
  {
    id: 'largest-ocean',
    prompt: 'Which is the largest ocean on Earth?',
    choices: [
      { id: 'atlantic', label: 'The Atlantic Ocean' },
      { id: 'indian', label: 'The Indian Ocean' },
      { id: 'pacific', label: 'The Pacific Ocean' }
    ],
    answer: 'pacific'
  }
]);

function clean(value, max = 80) {
  return String(value ?? '').trim().slice(0, max);
}

function sessionId(value) {
  const supplied = clean(value);
  if (/^[a-z0-9_-]+$/i.test(supplied)) return supplied;
  return `play-${crypto.randomBytes(9).toString('base64url')}`;
}

function integer(value, fallback, { min = 0, max = 100 } = {}) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function questionForRound(round) {
  return QUESTIONS[(round - 1) % QUESTIONS.length];
}

function formatQuestion(question, round, score) {
  return [
    `Round ${round} of ${MAX_ROUNDS} · score ${score}`,
    question.prompt,
    ...question.choices.map((choice, index) => `${index + 1}. ${choice.label}`),
    'Pick one.'
  ].join('\n');
}

function questionReceipt({ game, operation, sessionId: id, question, round, score }) {
  return {
    game,
    operation,
    session_id: id,
    question_id: question.id,
    round,
    score,
    question: question.prompt
  };
}

function startTrivia({ sessionId: suppliedId } = {}) {
  const id = sessionId(suppliedId);
  const round = 1;
  const score = 0;
  const question = questionForRound(round);
  return {
    game: 'trivia',
    sessionId: id,
    round,
    score,
    question,
    text: formatQuestion(question, round, score),
    receipt: questionReceipt({ game: 'trivia', operation: 'answer', sessionId: id, question, round, score })
  };
}

function answerTrivia({ sessionId: id, questionId, choiceId, round, score } = {}) {
  const cleanSession = clean(id);
  const cleanQuestion = clean(questionId);
  const cleanChoice = clean(choiceId);
  const currentRound = integer(round, -1, { min: 1, max: MAX_ROUNDS });
  const currentScore = integer(score, -1, { min: 0, max: MAX_ROUNDS });
  const question = QUESTIONS.find(candidate => candidate.id === cleanQuestion);
  if (!cleanSession || !question || currentRound < 1 || currentScore < 0 || !cleanChoice) {
    return { success: false, error: 'That play session is no longer available.' };
  }
  const choice = question.choices.find(candidate => candidate.id === cleanChoice);
  if (!choice) return { success: false, error: 'That answer is not one of the choices.' };

  const correct = choice.id === question.answer;
  const nextScore = currentScore + (correct ? 1 : 0);
  const nextRound = currentRound + 1;
  if (nextRound > MAX_ROUNDS) {
    return {
      success: true,
      finished: true,
      sessionId: cleanSession,
      round: currentRound,
      score: nextScore,
      correct,
      text: `${correct ? 'Correct.' : `Not quite — it was ${question.choices.find(candidate => candidate.id === question.answer).label}.`} Final score: ${nextScore}/${MAX_ROUNDS}.`
    };
  }

  const nextQuestion = questionForRound(nextRound);
  return {
    success: true,
    finished: false,
    sessionId: cleanSession,
    round: nextRound,
    score: nextScore,
    correct,
    text: `${correct ? 'Correct.' : `Not quite — it was ${question.choices.find(candidate => candidate.id === question.answer).label}.`}\n\n${formatQuestion(nextQuestion, nextRound, nextScore)}`,
    question: nextQuestion,
    receipt: questionReceipt({
      game: 'trivia', operation: 'answer', sessionId: cleanSession,
      question: nextQuestion, round: nextRound, score: nextScore
    })
  };
}

module.exports = {
  MAX_ROUNDS,
  QUESTIONS,
  startTrivia,
  answerTrivia
};

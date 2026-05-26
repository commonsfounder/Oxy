const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildPendingReviewResult,
  isPendingCancelMessage,
  isPendingConfirmMessage,
  isPendingRevisionMessage,
  reviewDetailForAction
} = require('../../api/services/pending-review');

test('pending review accepts natural confirmation phrases', () => {
  assert.equal(isPendingConfirmMessage('yes please'), true);
  assert.equal(isPendingConfirmMessage('looks good send it'), true);
  assert.equal(isPendingConfirmMessage('send the message'), true);
  assert.equal(isPendingConfirmMessage('send that message'), true);
  assert.equal(isPendingConfirmMessage('go ahead'), true);
});

test('pending review does not confirm revision or cancellation language', () => {
  assert.equal(isPendingConfirmMessage('wait change the tone'), false);
  assert.equal(isPendingConfirmMessage("yes but don't send yet"), false);
  assert.equal(isPendingCancelMessage('nah leave it'), true);
});

test('pending review detects edit follow-ups', () => {
  assert.equal(isPendingRevisionMessage('make it warmer'), true);
  assert.equal(isPendingRevisionMessage('actually add that I can do Friday'), true);
});

test('pending email card shows recipient, subject, and body for review', () => {
  const detail = reviewDetailForAction({
    type: 'send_email',
    input: {
      to: 'josh@example.com',
      subject: 'Catch up',
      body: 'Can we meet Friday?'
    }
  });
  assert.equal(detail, 'josh@example.com · Catch up · Can we meet Friday?');
});

test('pending review result owns concise final wording for high-risk actions', () => {
  const result = buildPendingReviewResult({
    type: 'send_message',
    input: { contact: 'Josh', message: 'Can we meet Friday?' }
  });
  assert.equal(result.pending, true);
  assert.equal(result.confirmation, 'review_required');
  assert.equal(result.cardText, 'Josh · Can we meet Friday?');
  assert.match(result.text, /^Review message\./);
});

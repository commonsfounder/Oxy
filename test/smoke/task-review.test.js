'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { taskReview } = require('../../api/services/task-review');

test('review preserves full recipient, copied recipients and body before approval', () => {
  const input = { to: 'recipient@example.com', cc: 'copy@example.com', bcc: 'private@example.com', subject: 'A quote', body: 'Full text\n'.repeat(100) };
  const review = taskReview({ approvalId: 'review-1', taskId: 'task-1', action: { type: 'send_email', input } });
  assert.equal(review.canApprove, true);
  for (const value of Object.values(input)) assert.ok(review.detail.includes(value));
  assert.equal(review.id, 'review-1');
  assert.equal(review.taskId, 'task-1');
});

test('unknown fields, unsupported capabilities and oversized details cannot be approved from partial presentation', () => {
  for (const action of [
    { type: 'send_email', input: { to: 'a@example.com', access_token: 'secret' } },
    { type: 'send_email', input: { body: 'x'.repeat(17000) } },
    { type: 'transaction_authorize', input: { secret: 'secret' } }
  ]) {
    const review = taskReview({ action });
    assert.equal(review.canApprove, false);
    assert.ok(!review.detail.includes('secret'));
    assert.ok(review.detail.length < 1000);
  }
});

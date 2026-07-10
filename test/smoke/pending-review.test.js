const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildPendingReviewResult,
  cleanCalendarTitle,
  formatCalendarDate,
  formatCalendarTime,
  isPendingCancelMessage,
  isPendingConfirmMessage,
  isPendingRevisionMessage,
  reviewDetailForAction,
  MONEY_ACTION_TYPES
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

test('pending calendar card normalizes title and formats date times', () => {
  assert.equal(cleanCalendarTitle('dentist .'), 'Dentist');
  const detail = reviewDetailForAction({
    type: 'create_calendar_event',
    input: {
      title: 'dentist .',
      start_date: '2026-07-05T15:00:00',
      end_date: '2026-07-05T16:00:00',
      timezone: 'Europe/London'
    }
  });
  assert.match(detail, /Title: Dentist/);
  assert.match(detail, /Date: /);
  assert.match(detail, /Start: /);
  assert.match(detail, /End: /);
  assert.doesNotMatch(detail, /2026-07-05T15:00:00/);
  assert.equal(formatCalendarDate('2026-07-05T15:00:00').includes('2026'), true);
  assert.equal(formatCalendarTime('2026-07-05T15:00:00'), '15:00');
});

test('pending review result owns concise final wording for high-risk actions', () => {
  const result = buildPendingReviewResult({
    type: 'send_message',
    input: { contact: 'Josh', message: 'Can we meet Friday?' }
  });
  assert.equal(result.pending, true);
  assert.equal(result.confirmation, 'review_required');
  assert.equal(result.cardText, 'Josh · Can we meet Friday?');
  assert.equal(result.text, 'Check this, then send when ready.');
});

test('MONEY_ACTION_TYPES covers every concierge-money action type', () => {
  assert.equal(MONEY_ACTION_TYPES.has('stripe_charge'), true);
  assert.equal(MONEY_ACTION_TYPES.has('spend_from_concierge_via_stripe'), true);
  assert.equal(MONEY_ACTION_TYPES.has('spend_from_concierge_account'), true);
});

test('review detail for a concierge spend with no linked card still shows the virtual-balance framing', () => {
  const detail = reviewDetailForAction({ type: 'spend_from_concierge_account', input: { amount: 25.5, description: 'dinner reservation' } });
  assert.equal(detail, 'Spend $25.50 from your concierge balance for dinner reservation.');
});

test('review detail for a concierge spend with a linked card shows the real card', () => {
  const detail = reviewDetailForAction(
    { type: 'spend_from_concierge_account', input: { amount: 25.5, description: 'dinner reservation' } },
    { brand: 'visa', last4: '4242' }
  );
  assert.equal(detail, 'Charge your visa card ending in 4242 $25.50 for dinner reservation.');
});

test('review detail for stripe_charge converts its amount from cents to dollars', () => {
  const detail = reviewDetailForAction(
    { type: 'stripe_charge', input: { amount: 2550, description: 'concierge spend' } },
    { brand: 'mastercard', last4: '1881' }
  );
  assert.equal(detail, 'Charge your mastercard card ending in 1881 $25.50 for concierge spend.');
});

test('buildPendingReviewResult threads cardInfo into the card text', () => {
  const result = buildPendingReviewResult(
    { type: 'spend_from_concierge_via_stripe', input: { amount: 10, description: 'gift' } },
    { brand: 'visa', last4: '4242' }
  );
  assert.equal(result.cardText, 'Charge your visa card ending in 4242 $10.00 for gift.');
});

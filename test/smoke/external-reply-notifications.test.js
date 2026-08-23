const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildInboundReplyNotification,
  safeReplyPreview
} = require('../../api/services/external-reply-notifications');

test('buildInboundReplyNotification creates a deduped, actionable email notification', () => {
  const notification = buildInboundReplyNotification({
    channelType: 'email',
    fromAddress: 'provider@example.com',
    body: 'We can move your appointment to Thursday. Does that work?',
    decision: 'ask',
    conversationId: 'conversation-1',
    providerEventId: 'provider-event-1',
    requestTaskId: 'task-1',
    eventId: 'event-1'
  });

  assert.equal(notification.category, 'reply_needed');
  assert.equal(notification.urgency, 'normal');
  assert.equal(notification.title, 'Reply from provider@example.com');
  assert.match(notification.body, /needs your attention/);
  assert.match(notification.body, /move your appointment/);
  assert.equal(notification.dedupeKey, 'external-reply|conversation:conversation-1|event:provider-event-1');
  assert.deepEqual(notification.sourceRef, {
    conversationId: 'conversation-1',
    providerEventId: 'provider-event-1',
    requestTaskId: 'task-1',
    eventId: 'event-1',
    channelType: 'email',
    decision: 'ask'
  });
});

test('informational SMS replies are surfaced at low urgency without auto-acting', () => {
  const notification = buildInboundReplyNotification({
    channelType: 'phone_sms',
    fromAddress: '+447700900123',
    body: 'Confirmed, see you tomorrow.',
    decision: 'surface',
    conversationId: 'conversation-2',
    providerEventId: 'sms-2'
  });

  assert.equal(notification.urgency, 'low');
  assert.match(notification.title, /\+447700900123/);
  assert.doesNotMatch(notification.body, /needs your attention/);
  assert.equal(notification.sourceRef.decision, 'surface');
});

test('likely verification codes are redacted from the notification preview', () => {
  const preview = safeReplyPreview('Your one-time verification code is 123 456. Do not share it.');
  assert.match(preview, /\[code\]/);
  assert.doesNotMatch(preview, /123 456/);
});

test('fallback event keys make retries for the same provider-less reply idempotent', () => {
  const first = buildInboundReplyNotification({
    channelType: 'email',
    fromAddress: 'provider@example.com',
    body: 'Confirmed.',
    conversationId: 'conversation-3'
  });
  const second = buildInboundReplyNotification({
    channelType: 'email',
    fromAddress: 'provider@example.com',
    body: 'Confirmed.',
    conversationId: 'conversation-3'
  });
  assert.equal(first.dedupeKey, second.dedupeKey);
});

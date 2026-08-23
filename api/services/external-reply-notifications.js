'use strict';

const { createHash } = require('node:crypto');

const CHANNEL_LABELS = Object.freeze({
  email: 'email',
  phone_sms: 'SMS'
});

function compact(value, max = 320) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// External replies can contain one-time passcodes. Surface enough context for the user to
// recognise the thread, but do not copy a likely verification code into an unsolicited
// notification channel. The encrypted conversation event remains the source of truth.
function safeReplyPreview(body) {
  const preview = compact(body);
  if (!preview) return 'The reply had no readable text.';
  if (/\b(?:one[- ]time|verification|security|pass|access|auth(?:entication|orization)?|otp)\s+(?:code|number|token)\b/i.test(preview)) {
    return preview.replace(/\b\d[\d -]{3,10}\d\b/g, '[code]');
  }
  return preview;
}

function fallbackEventKey({ channelType, fromAddress, body }) {
  return createHash('sha256')
    .update(`${channelType || ''}\u0000${fromAddress || ''}\u0000${body || ''}`)
    .digest('hex')
    .slice(0, 24);
}

function buildInboundReplyNotification({
  channelType,
  fromAddress,
  body,
  decision,
  conversationId,
  providerEventId,
  requestTaskId = null,
  eventId = null
} = {}) {
  const channelLabel = CHANNEL_LABELS[channelType] || 'external';
  const sender = compact(fromAddress || 'your contact', 120);
  const replyDecision = decision === 'surface' ? 'surface' : 'ask';
  const eventKey = compact(providerEventId, 180) || fallbackEventKey({ channelType, fromAddress, body });
  const conversationKey = compact(conversationId, 180) || 'unknown';
  const title = `Reply from ${sender}`;
  const bodyText = `A ${channelLabel} reply arrived${replyDecision === 'ask' ? ' and needs your attention' : ''}.\n\n${safeReplyPreview(body)}`;

  return {
    category: 'reply_needed',
    urgency: replyDecision === 'ask' ? 'normal' : 'low',
    title,
    body: bodyText,
    dedupeKey: `external-reply|conversation:${conversationKey}|event:${eventKey}`,
    sourceRef: {
      conversationId: conversationId || null,
      providerEventId: providerEventId || null,
      requestTaskId: requestTaskId || null,
      eventId: eventId || null,
      channelType: channelType || null,
      decision: replyDecision
    }
  };
}

module.exports = {
  buildInboundReplyNotification,
  safeReplyPreview
};

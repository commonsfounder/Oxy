'use strict';

const { reviewTitleForAction } = require('./pending-review');

// Only explicitly presentable action fields cross the client boundary.
const FIELDS = {
  create_calendar_event: ['title', 'start_date', 'end_date', 'timezone', 'description', 'location', 'attendees', 'calendar_id'],
  send_email: ['to', 'cc', 'bcc', 'subject', 'body'],
  send_outlook_email: ['to', 'cc', 'bcc', 'subject', 'body'],
  send_telegram: ['contact', 'message'],
  send_message: ['contact', 'message', 'channel']
};

function taskReview(approval) {
  const action = approval.action || {};
  const allowed = FIELDS[action.type];
  const input = action.input || {};
  const supported = allowed && Object.keys(input).every(key => allowed.includes(key));
  const detail = supported ? Object.entries(input).map(([key, value]) =>
    `${key.replaceAll('_', ' ')}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
  ).join('\n\n') : 'Open the original review in chat to inspect this action.';
  const complete = Boolean(supported && detail && detail.length <= 16000);
  return {
    id: approval.approvalId,
    taskId: approval.taskId,
    title: reviewTitleForAction(action),
    detail: complete ? detail : 'Open the original review in chat to inspect this action.',
    canApprove: complete,
    createdAt: approval.createdAt
  };
}

module.exports = { taskReview };

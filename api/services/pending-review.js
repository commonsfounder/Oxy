const { applyActionContractResultMetadata, getActionContract } = require('../action-contracts');

function humanizeActionType(type) {
  if (!type) return 'Action';
  return String(type)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

function summarizeActionInput(input) {
  if (!input || typeof input !== 'object') return '';
  const preferredKeys = ['contact', 'to', 'title', 'destination', 'query', 'restaurant', 'item', 'origin', 'topic', 'brief'];
  const values = preferredKeys
    .map(key => input[key])
    .filter(Boolean)
    .slice(0, 3);
  return values.length ? ` (${values.join(' · ')})` : '';
}

function isPendingConfirmMessage(message) {
  const text = String(message || '').trim().toLowerCase();
  if (!text) return false;
  if (/\b(wait|hold on|actually|change|edit|instead|but|before|not yet|don't|do not|stop|cancel)\b/i.test(text)) {
    return false;
  }
  return /^(yes|yeah|yep|yup|ok|okay|sure|confirm|confirmed|approve|approved|proceed)$/i.test(text) ||
    /\b(yes please|looks good|go ahead|do it|send it|send now|send the message|send that message|message them|book it|order it|call them|open it|that's fine|that is fine|all good)\b/i.test(text);
}

function isPendingCancelMessage(message) {
  const text = String(message || '').trim();
  return /^(no|nope|nah|cancel|stop|don't|do not|never mind|nevermind|leave it|not now|not yet)$/i
    .test(text) ||
    /\b(cancel it|stop it|leave it|scrap it|never mind|nevermind|don't send|do not send|don't book|do not book)\b/i.test(text);
}

function isPendingRevisionMessage(message) {
  return /\b(change|edit|rewrite|make it|instead|actually|wait|hold on|tone|shorter|longer|more|less|add|remove|don't|do not)\b/i
    .test(String(message || '').trim());
}

function reviewTitleForAction(action) {
  switch (action?.type) {
    case 'send_email': return 'Review email';
    case 'send_message': return 'Review message';
    case 'send_telegram': return 'Review Telegram';
    case 'book_uber': return 'Review Uber';
    case 'order_uber_eats': return 'Review Uber Eats';
    case 'order_deliveroo': return 'Review Deliveroo';
    case 'make_call': return 'Review call';
    default: return `Review ${humanizeActionType(action?.type || 'action')}`;
  }
}

function reviewDetailForAction(action) {
  const input = action?.input || {};
  switch (action?.type) {
    case 'send_email':
      return [input.to, input.subject, input.body].filter(Boolean).join(' · ');
    case 'send_message':
    case 'send_telegram':
      return [input.contact, input.message].filter(Boolean).join(' · ');
    case 'book_uber':
      return input.destination ? `Destination: ${input.destination}` : '';
    case 'order_uber_eats':
    case 'order_deliveroo':
      return [input.restaurant, input.item, input.query].filter(Boolean).join(' · ');
    case 'make_call':
      return input.contact ? `Contact: ${input.contact}` : '';
    default:
      return summarizeActionInput(input).replace(/^\s*\(|\)\s*$/g, '');
  }
}

function buildPendingReviewResult(action) {
  const contract = getActionContract(action?.type) || {};
  return applyActionContractResultMetadata(action, {
    success: true,
    pending: true,
    text: `${reviewTitleForAction(action)}. Confirm to continue, or cancel to stop.`,
    cardText: reviewDetailForAction(action) || 'Ready for review.',
    actionSummary: reviewTitleForAction(action),
    risk: contract.risk || 'high',
    confirmation: 'review_required',
    executionMode: 'review'
  });
}

module.exports = {
  buildPendingReviewResult,
  isPendingCancelMessage,
  isPendingConfirmMessage,
  isPendingRevisionMessage,
  reviewDetailForAction,
  reviewTitleForAction
};

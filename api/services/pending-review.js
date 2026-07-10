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

const MONEY_ACTION_TYPES = new Set(['stripe_charge', 'spend_from_concierge_via_stripe', 'spend_from_concierge_account']);

function conciergeMoneyReviewDetail(action, cardInfo) {
  const input = action?.input || {};
  const isCents = action.type === 'stripe_charge';
  const rawAmount = Number(input.amount || 0);
  const amountUsd = isCents ? rawAmount / 100 : rawAmount;
  const amountStr = Number.isFinite(amountUsd) ? `$${amountUsd.toFixed(2)}` : 'this amount';
  const description = input.description || input.merchant || 'this purchase';
  if (cardInfo?.last4) {
    const brand = cardInfo.brand ? `${cardInfo.brand} ` : '';
    return `Charge your ${brand}card ending in ${cardInfo.last4} ${amountStr} for ${description}.`;
  }
  return `Spend ${amountStr} from your concierge balance for ${description}.`;
}

function reviewTitleForAction(action) {
  switch (action?.type) {
    case 'send_email': return 'Review email';
    case 'send_message': return 'Review message';
    case 'send_telegram': return 'Review Telegram';
    case 'book_uber': return 'Review Uber';
    case 'make_call': return 'Review call';
    case 'create_calendar_event': return 'Review calendar event';
    case 'send_outlook_email': return 'Review email';
    case 'create_github_issue': return 'Review GitHub issue';
    case 'comment_github_issue': return 'Review GitHub comment';
    case 'create_linear_issue': return 'Review Linear issue';
    case 'comment_linear_issue': return 'Review Linear comment';
    default: return `Review ${humanizeActionType(action?.type || 'action')}`;
  }
}

function cleanCalendarTitle(title) {
  const text = String(title || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  const cleaned = text.replace(/\s*\.$/, '').replace(/\s+([,;:!?])/g, '$1');
  if (!cleaned) return '';
  return cleaned.charAt(0).toLocaleUpperCase() + cleaned.slice(1);
}

function parseCalendarDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(raw)
    ? `${raw}Z`
    : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatCalendarDate(value, locale = 'en-GB', timeZone = 'Europe/London') {
  const naive = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (naive) {
    const date = new Date(Date.UTC(Number(naive[1]), Number(naive[2]) - 1, Number(naive[3])));
    return new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC'
    }).format(date);
  }
  const date = parseCalendarDate(value);
  if (!date) return String(value || '').trim();
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone
  }).format(date);
}

function formatCalendarTime(value, locale = 'en-GB', timeZone = 'Europe/London') {
  const naive = String(value || '').trim().match(/^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/);
  if (naive) {
    const date = new Date(Date.UTC(2000, 0, 1, Number(naive[1]), Number(naive[2])));
    return new Intl.DateTimeFormat(locale, {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'UTC'
    }).format(date);
  }
  const date = parseCalendarDate(value);
  if (!date) return String(value || '').trim();
  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone
  }).format(date);
}

function reviewCalendarDetail(input = {}) {
  const title = cleanCalendarTitle(input.title) || 'Untitled event';
  const timeZone = input.timezone || 'Europe/London';
  return [
    `Title: ${title}`,
    input.start_date ? `Date: ${formatCalendarDate(input.start_date, 'en-GB', timeZone)}` : '',
    input.start_date ? `Start: ${formatCalendarTime(input.start_date, 'en-GB', timeZone)}` : '',
    input.end_date ? `End: ${formatCalendarTime(input.end_date, 'en-GB', timeZone)}` : ''
  ].filter(Boolean).join('\n');
}

function reviewDetailForAction(action, cardInfo = null) {
  const input = action?.input || {};
  switch (action?.type) {
    case 'send_email':
    case 'send_outlook_email':
      return [input.to, input.subject, input.body].filter(Boolean).join(' · ');
    case 'create_github_issue':
      return [input.repo, input.title, input.body].filter(Boolean).join(' · ');
    case 'comment_github_issue':
      return [input.repo && input.issue_number ? `${input.repo}#${input.issue_number}` : (input.repo || ''), input.body].filter(Boolean).join(' · ');
    case 'create_linear_issue':
      return [input.team, input.title, input.description].filter(Boolean).join(' · ');
    case 'comment_linear_issue':
      return [input.issue, input.body].filter(Boolean).join(' · ');
    case 'send_message':
    case 'send_telegram':
      return [input.contact, input.message].filter(Boolean).join(' · ');
    case 'book_uber':
      return input.destination ? `Destination: ${input.destination}` : '';
    case 'create_calendar_event':
      return reviewCalendarDetail(input);
    case 'make_call':
      return input.contact ? `Contact: ${input.contact}` : '';
    case 'stripe_charge':
    case 'spend_from_concierge_via_stripe':
    case 'spend_from_concierge_account':
      return conciergeMoneyReviewDetail(action, cardInfo);
    default:
      return summarizeActionInput(input).replace(/^\s*\(|\)\s*$/g, '');
  }
}

function buildPendingReviewResult(action, cardInfo = null) {
  const contract = getActionContract(action?.type) || {};
  const prompt = action?.type === 'send_message'
    ? 'Check this, then send when ready.'
    : action?.type === 'send_email'
      ? 'Check this draft, then send when ready.'
      : `${reviewTitleForAction(action)}. Confirm to continue, or cancel to stop.`;
  return applyActionContractResultMetadata(action, {
    success: true,
    pending: true,
    text: prompt,
    cardText: reviewDetailForAction(action, cardInfo) || 'Ready for review.',
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
  cleanCalendarTitle,
  formatCalendarDate,
  formatCalendarTime,
  reviewDetailForAction,
  reviewTitleForAction,
  MONEY_ACTION_TYPES
};

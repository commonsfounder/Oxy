'use strict';

// What Adam may say and agree to on a phone call to a business, decided here rather than by the
// voice model. The model gets a brief; these rules are also enforced around it: who can be called,
// how long, how often, and what the call's result is allowed to claim.

const MAX_CALL_SECONDS = 6 * 60;
const DAILY_CALL_CAP = 5;

// Emergency, short-code and premium-rate numbers are never dialled by an agent.
const BLOCKED = [
  { pattern: /^\+(?:\d{1,3})?(?:112|911|999|000|110|119|100|101|102|103|108|111|116\d{3})$/, reason: 'emergency or service number' },
  { pattern: /^\+449/, reason: 'UK premium-rate number' },
  { pattern: /^\+4487[0-3]/, reason: 'UK revenue-share number' },
  { pattern: /^\+1900/, reason: 'US premium-rate number' },
  { pattern: /^\+1976/, reason: 'pay-per-call number' }
];

function callError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// UK numbers written the local way (07…, 020…) become +44; everything else must already be E.164.
function normalizeCallNumber(raw) {
  let number = String(raw || '').replace(/[\s().-]/g, '');
  if (/^\+?(?:112|911|999|000|101|111|988)$/.test(number)) {
    throw callError('blocked_number', 'I won\'t call emergency or service numbers. Call them yourself.');
  }
  if (/^00\d/.test(number)) number = `+${number.slice(2)}`;
  if (/^0\d{9,10}$/.test(number)) number = `+44${number.slice(1)}`;
  if (!/^\+[1-9]\d{6,14}$/.test(number)) {
    throw callError('invalid_number', 'I need the business\'s full phone number to call it.');
  }
  for (const rule of BLOCKED) {
    if (rule.pattern.test(number)) throw callError('blocked_number', `I won't call that number (${rule.reason}).`);
  }
  return number;
}

function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function validateCallRequest(input = {}) {
  const businessName = clean(input.business_name || input.business || input.name, 120);
  const goal = clean(input.goal || input.purpose, 600);
  if (!businessName) throw callError('invalid_call', 'Who should I call?');
  if (!goal) throw callError('invalid_call', 'What should I ask them?');
  const details = (Array.isArray(input.details) ? input.details : String(input.details || '').split(/\n|;/))
    .map(item => clean(item, 200))
    .filter(Boolean)
    .slice(0, 10);
  return {
    phone: normalizeCallNumber(input.phone || input.number || input.to),
    businessName,
    goal,
    details,
    fallback: clean(input.fallback || input.if_not_possible, 300) || null,
    language: clean(input.language, 30) || 'English'
  };
}

// The words said first on every call. Fixed, so disclosure never depends on the model.
function disclosureLine(onBehalfOf) {
  return `Hello, this is Adam, an AI assistant calling on behalf of ${onBehalfOf}.`;
}

function buildCallBrief(request, { onBehalfOf }) {
  const details = request.details.length
    ? request.details.map(item => `- ${item}`).join('\n')
    : '- (none: do not give any personal details)';
  return [
    `You are Adam, an AI assistant on a phone call to ${request.businessName} on behalf of ${onBehalfOf}.`,
    `Speak ${request.language}. Be brief, polite and natural, like a capable person on the phone. One question at a time.`,
    '',
    `What to find out or arrange: ${request.goal}`,
    request.fallback ? `If that is not possible: ${request.fallback}` : '',
    '',
    `Details you may share, and nothing else:\n${details}`,
    '',
    'Rules you never break:',
    '- If asked, say plainly that you are an AI assistant. Never claim to be the person you are calling for.',
    '- Never give or agree to card numbers, deposits, payments, cancellation fees or any binding commitment. If they need one, ' +
      `say you will check with ${onBehalfOf} and get back to them, then end the call.`,
    '- You may ask them to pencil something in or hold it, and you may join a waiting or cancellation list, but say it still needs confirming.',
    '- Do not share anything not listed above (addresses, dates of birth, account numbers, other people\'s details).',
    `- If they need to call back, ask them to ring the number you are calling from; it reaches ${onBehalfOf}. Never give out any other number.`,
    '- If you reach voicemail, an automated menu you cannot get through, or the wrong business, call report_outcome and end the call.',
    '- If the other person asks you to stop calling or is upset, apologise, end the call and report it.',
    '',
    'Before hanging up, call report_outcome exactly once with what actually happened, then end_call. ' +
      'Only report what they said; never report a booking as confirmed unless they confirmed it.'
  ].filter(line => line !== '').join('\n');
}

const CALL_TOOLS = Object.freeze([
  {
    type: 'function',
    name: 'report_outcome',
    description: 'Record what happened on this call. Call exactly once, before end_call.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['done', 'needs_decision', 'not_possible', 'no_answer', 'voicemail', 'wrong_number', 'refused'],
          description: 'done: what was asked for happened as asked. needs_decision: they offered something the person must approve (a different time, a deposit, a condition).'
        },
        summary: { type: 'string', description: 'One or two plain sentences: what they said.' },
        offer: { type: 'string', description: 'Any option, time, price or condition they offered, word for word where possible.' },
        reference: { type: 'string', description: 'Any booking reference, name it is under, or person you spoke to.' }
      },
      required: ['status', 'summary']
    }
  },
  { type: 'function', name: 'end_call', description: 'Hang up after saying goodbye.', parameters: { type: 'object', properties: {} } }
]);

const OUTCOME_STATUSES = new Set(CALL_TOOLS[0].parameters.properties.status.enum);

function normalizeOutcome(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { value = {}; }
  }
  const status = OUTCOME_STATUSES.has(value?.status) ? value.status : null;
  if (!status) return null;
  return {
    status,
    summary: clean(value.summary, 500) || null,
    offer: clean(value.offer, 300) || null,
    reference: clean(value.reference, 120) || null
  };
}

// What the person is told afterwards. A call that ended without a reported outcome is reported as
// unknown, never as success.
function describeOutcome({ businessName, outcome, endedBy, seconds }) {
  const length = Number.isFinite(seconds) && seconds > 0 ? ` (${Math.max(1, Math.round(seconds / 60))} min)` : '';
  if (!outcome) {
    const why = endedBy === 'no_answer' ? 'No one answered.'
      : endedBy === 'busy' ? 'The line was busy.'
        : endedBy === 'failed' ? 'The call could not be placed.'
          : 'The call ended before I could confirm anything.';
    return { title: `Call to ${businessName}`, body: `${why} Nothing was agreed.`, needsYou: false, status: endedBy || 'unknown' };
  }
  const parts = [outcome.summary || ''];
  if (outcome.offer) parts.push(`They offered: ${outcome.offer}.`);
  if (outcome.reference) parts.push(`Reference: ${outcome.reference}.`);
  const lead = {
    done: '', needs_decision: '', not_possible: '', no_answer: 'No one answered. ',
    voicemail: 'Reached voicemail; no message with your details was left. ', wrong_number: 'Wrong number. ', refused: ''
  }[outcome.status];
  const tail = outcome.status === 'needs_decision' ? ' Nothing is confirmed until you say so.' : '';
  return {
    title: outcome.status === 'needs_decision' ? `${businessName} needs your answer` : `Called ${businessName}${length}`,
    body: `${lead}${parts.filter(Boolean).join(' ')}${tail}`.trim(),
    needsYou: outcome.status === 'needs_decision',
    status: outcome.status
  };
}

module.exports = {
  CALL_TOOLS,
  DAILY_CALL_CAP,
  MAX_CALL_SECONDS,
  buildCallBrief,
  describeOutcome,
  disclosureLine,
  normalizeCallNumber,
  normalizeOutcome,
  validateCallRequest
};

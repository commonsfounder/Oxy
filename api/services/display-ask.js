'use strict';

// A tap on a button in a scene is a request to Adam, as if it were typed on the screen. A shared
// screen can never approve anything: words that would approve or cancel a waiting action are
// refused here, so the yes always happens on the phone where the person can see what it is.

const { isPendingConfirmMessage, isPendingCancelMessage } = require('./pending-review');

const MAX_ASK = 2000;
const MIN_GAP_MS = 3000;
const lastAskAt = new Map();

function askError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function validateDisplayAsk(text) {
  if (typeof text !== 'string') throw askError('invalid_ask', 'A request must be text.');
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) throw askError('invalid_ask', 'A request needs some words.');
  if (clean.length > MAX_ASK) throw askError('invalid_ask', 'That request is too long.');
  if (isPendingConfirmMessage(clean) || isPendingCancelMessage(clean)) {
    throw askError('needs_phone', 'Approve or cancel from your phone.');
  }
  return clean;
}

function checkAskRate(displayId, now = Date.now()) {
  const last = lastAskAt.get(displayId);
  if (last !== undefined && now - last < MIN_GAP_MS) throw askError('too_fast', 'One moment.', 429);
  lastAskAt.set(displayId, now);
  if (lastAskAt.size > 500) {
    for (const [key, at] of lastAskAt) if (now - at > 60000) lastAskAt.delete(key);
  }
}

module.exports = { MAX_ASK, MIN_GAP_MS, validateDisplayAsk, checkAskRate, _reset: () => lastAskAt.clear() };

// Shared language for text that can reach the person using Adam.
// Provider names, action ids, and server errors stay behind this boundary.

const { ACTION_WORDING } = require('../action-wording');

const ACTION_NAMES = Object.freeze(Object.fromEntries(
  Object.entries(ACTION_WORDING).filter(([, wording]) => wording.name).map(([type, wording]) => [type, wording.name])
));

function titleCaseAction(type) {
  if (!type) return 'Action';
  return String(type)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

function actionDisplayName(type) {
  return ACTION_NAMES[type] || titleCaseAction(type);
}

function hasTechnicalError(rawError) {
  return /\b(?:api|api key|server|stripe|supabase|openai|google places|http|status code|exception|undefined|econn|enotfound|permission_denied|stack trace)\b/i.test(rawError);
}

function actionFailureMessage(action, rawError = '') {
  const error = String(rawError || '').replace(/\s+/g, ' ').trim();
  if (/need your current location|enable location|location access/i.test(error)) {
    return "I need location access to do that. Turn it on and I'll try again.";
  }
  if (/Google Places|Places API|nearby place ranking|Places is not configured/i.test(error)) {
    return 'Nearby place search is not ready right now. Try again later.';
  }
  if (/couldn't find a nearby|no place results|geocoding error|no results found/i.test(error)) {
    return "I couldn't find a good nearby match. Try a different place name.";
  }
  if (/not connected|not authorized|reconnect|permission|authenticate|expired|revoked|sign.?in/i.test(error)) {
    return 'This connection needs attention. Reconnect it in Settings, then try again.';
  }
  if (/payment.*(?:failed|declined|unsuccessful)|declined.*payment|stripe charge failed/i.test(error)) {
    return 'The payment did not go through. Check the payment details and try again.';
  }
  if (/captcha|bot wall|cloudflare|automated access|blocked this attempt|security verification/i.test(error)) {
    return 'The website blocked this attempt. Open the site and finish it there.';
  }
  if (/no results|couldn't find|not found/i.test(error)) {
    return "I couldn't find a match. Try a different search.";
  }
  if (!error || hasTechnicalError(error) || /^browse task failed/i.test(error) || /^.+ failed:/i.test(error)) {
    return `I couldn't finish ${actionDisplayName(action).toLowerCase()} safely. Try again.`;
  }
  if (error.length > 180) {
    return `I couldn't finish ${actionDisplayName(action).toLowerCase()} safely. Try again.`;
  }
  return error;
}

function formatActionFailure(action, rawError = '') {
  const detail = actionFailureMessage(action, rawError);
  if (/^This connection needs attention\./i.test(detail)) {
    const lead = ACTION_WORDING[action]?.failureLead || `I couldn't finish ${actionDisplayName(action).toLowerCase()}.`;
    return `${lead} The connection needs attention. Reconnect it in Settings, then try again.`;
  }
  if (/^(I need|I couldn't|This connection|The payment|The website|Nearby|Cancelled|Canceled)/i.test(detail)) {
    return detail;
  }
  return `I couldn't finish ${actionDisplayName(action).toLowerCase()}. ${detail}`;
}

function formatProviderFailure(rawError = '') {
  const error = String(rawError || '').replace(/\s+/g, ' ').trim();
  if (/\b(?:401|403)\b|incorrect api key|invalid api key|authentication failed|not authorised|not authorized/i.test(error)) {
    return 'Adam is unavailable right now. Try again later.';
  }
  if (/\b(?:404)\b.*model|model.*(?:not found|does not exist|not available)|unsupported model|does not support this model/i.test(error)) {
    return 'Adam needs a model connection before answering. Try again later.';
  }
  if (/timeout|timed out|aborted|deadline exceeded/i.test(error)) {
    return 'That took too long. Try again.';
  }
  return 'Adam could not answer right now. Try again later.';
}

function approvalTitle(action) {
  return ACTION_WORDING[action]?.approval || `${actionDisplayName(action)} needs your OK`;
}

module.exports = {
  ACTION_NAMES,
  actionDisplayName,
  actionFailureMessage,
  formatActionFailure,
  formatProviderFailure,
  approvalTitle
};

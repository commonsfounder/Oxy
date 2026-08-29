// Shared language for text that can reach the person using Adam.
// Provider names, action ids, and server errors stay behind this boundary.

const ACTION_NAMES = Object.freeze({
  send_email: 'Email',
  send_outlook_email: 'Email',
  get_emails: 'Email',
  search_emails: 'Email',
  get_outlook_emails: 'Email',
  search_outlook_emails: 'Email',
  send_message: 'Message',
  send_telegram: 'Message',
  send_adam_email: 'Message',
  send_adam_sms: 'Message',
  make_call: 'Call',
  create_reminder: 'Reminder',
  update_reminder: 'Reminder',
  create_calendar_event: 'Calendar event',
  get_calendar_events: 'Calendar',
  book_appointment: 'Appointment',
  find_place: 'Nearby place',
  get_directions: 'Directions',
  plan_trip: 'Travel plan',
  book_uber: 'Ride',
  book_lyft: 'Ride',
  search_trains: 'Train times',
  play_music: 'Music',
  add_to_music_playlist: 'Music',
  web_search: 'Search',
  create_github_issue: 'GitHub issue',
  comment_github_issue: 'GitHub comment',
  create_linear_issue: 'Linear issue',
  comment_linear_issue: 'Linear comment',
  project_status: 'Project update',
  project_diff: 'Changes',
  project_write: 'Saved update',
  project_check: 'Check',
  project_commit: 'Saved update',
  project_rollback: 'Reverted update',
  project_sync: 'Published update',
  workspace_read: 'Saved information',
  workspace_write: 'Saved update',
  workspace_list: 'Saved information',
  forget_memory: 'Memory'
});

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
  return /\b(?:api|api key|server|stripe|supabase|gemini|google places|http|status code|exception|undefined|econn|enotfound|permission_denied|stack trace)\b/i.test(rawError);
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
    const lead = {
      search_emails: "I couldn't check your email.",
      get_emails: "I couldn't check your email.",
      search_outlook_emails: "I couldn't check your email.",
      get_outlook_emails: "I couldn't check your email.",
      get_calendar_events: "I couldn't check your calendar.",
      web_search: "I couldn't search for that.",
      find_place: "I couldn't find a nearby place.",
      get_directions: "I couldn't get directions.",
      book_uber: "I couldn't arrange the ride.",
      book_lyft: "I couldn't arrange the ride."
    }[action] || `I couldn't finish ${actionDisplayName(action).toLowerCase()}.`;
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
  switch (action) {
    case 'send_email':
    case 'send_outlook_email': return 'Email ready to send';
    case 'send_message':
    case 'send_telegram': return 'Message ready to send';
    case 'book_uber':
    case 'book_lyft': return 'Ride ready to book';
    case 'make_call': return 'Call ready to make';
    case 'create_calendar_event': return 'Calendar event ready';
    case 'book_appointment': return 'Appointment ready to book';
    default: return `${actionDisplayName(action)} needs your OK`;
  }
}

module.exports = {
  ACTION_NAMES,
  actionDisplayName,
  actionFailureMessage,
  formatActionFailure,
  formatProviderFailure,
  approvalTitle
};

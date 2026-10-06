/** Plain-English descriptions of logged actions, for the activity history. */

const INTERNAL_PREFIXES = ['workspace_', 'project_'];
const INTERNAL_TYPES = new Set([
  'simulate_actions', 'record_watch_observation', 'list_scheduled_tasks', 'list_responsibilities',
  'list_paired_displays', 'get_display_scene', 'find_commitments', 'find_people', 'find_occasions',
  'find_spend', 'track_commitment', 'calculate'
]);

function clip(value, max = 60) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function pick(params, ...keys) {
  for (const key of keys) {
    const value = params?.[key];
    if (typeof value === 'string' && value.trim()) return clip(value);
  }
  return '';
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

const DESCRIBERS = {
  web_search: (p) => ({ summary: `Searched for ${pick(p, 'query') || 'something'}`, kind: 'looked' }),
  web_browse: (p) => ({ summary: hostOf(p?.url) ? `Read a page on ${hostOf(p.url)}` : 'Read a web page', kind: 'looked' }),
  find_place: (p) => ({ summary: `Looked for ${pick(p, 'query', 'destination', 'place', 'address') || 'a place'}`, kind: 'looked', usedLocation: true }),
  get_directions: (p) => ({ summary: `Worked out the way to ${pick(p, 'destination', 'query', 'place', 'address') || 'a place'}`, kind: 'looked', usedLocation: true }),
  plan_trip: (p) => ({ summary: `Planned a trip to ${pick(p, 'destination', 'query', 'place', 'to') || 'a place'}`, kind: 'looked', usedLocation: true }),
  search_trains: (p) => ({ summary: `Checked trains from ${pick(p, 'origin', 'from') || 'here'} to ${pick(p, 'destination', 'to') || 'there'}`, kind: 'looked' }),
  get_calendar_events: () => ({ summary: 'Checked your calendar', kind: 'looked' }),
  find_free_time: () => ({ summary: 'Looked for free time in your calendar', kind: 'looked' }),
  get_outlook_events: () => ({ summary: 'Checked your calendar', kind: 'looked' }),
  create_calendar_event: (p) => ({ summary: `Added ${pick(p, 'title') ? `“${pick(p, 'title')}”` : 'an event'} to your calendar`, kind: 'did' }),
  create_outlook_event: (p) => ({ summary: `Added ${pick(p, 'title') ? `“${pick(p, 'title')}”` : 'an event'} to your calendar`, kind: 'did' }),
  move_calendar_event: () => ({ summary: 'Moved a calendar event', kind: 'did' }),
  cancel_calendar_event: () => ({ summary: 'Cancelled a calendar event', kind: 'did' }),
  delete_calendar_event: () => ({ summary: 'Deleted a calendar event', kind: 'did' }),
  update_calendar_event: () => ({ summary: 'Changed a calendar event', kind: 'did' }),
  schedule_block: (p) => ({ summary: `Blocked out time${pick(p, 'title') ? ` for ${pick(p, 'title')}` : ''}`, kind: 'did' }),
  get_emails: () => ({ summary: 'Checked your email', kind: 'looked' }),
  get_outlook_emails: () => ({ summary: 'Checked your email', kind: 'looked' }),
  search_emails: (p) => ({ summary: `Searched your email for ${pick(p, 'query') || 'something'}`, kind: 'looked' }),
  search_outlook_emails: (p) => ({ summary: `Searched your email for ${pick(p, 'query') || 'something'}`, kind: 'looked' }),
  archive_emails: () => ({ summary: 'Tidied your inbox', kind: 'did' }),
  clean_inbox: () => ({ summary: 'Tidied your inbox', kind: 'did' }),
  label_emails: () => ({ summary: 'Sorted some emails', kind: 'did' }),
  unsubscribe_email: () => ({ summary: 'Unsubscribed you from an email list', kind: 'did' }),
  send_email: (p) => ({ summary: `Emailed ${pick(p, 'to', 'email', 'recipient') || 'someone'}`, kind: 'sent' }),
  send_outlook_email: (p) => ({ summary: `Emailed ${pick(p, 'to', 'email', 'recipient') || 'someone'}`, kind: 'sent' }),
  send_message: (p) => ({ summary: `Messaged ${pick(p, 'contact') || 'someone'}`, kind: 'sent' }),
  send_telegram: (p) => ({ summary: `Messaged ${pick(p, 'contact') || 'someone'} on Telegram`, kind: 'sent' }),
  send_adam_email: (p) => ({ summary: `Emailed ${pick(p, 'to') || 'someone'}`, kind: 'sent' }),
  send_adam_sms: (p) => ({ summary: `Texted ${pick(p, 'to', 'contact') || 'someone'}`, kind: 'sent' }),
  make_call: (p) => ({ summary: `Called ${pick(p, 'contact') || 'someone'}`, kind: 'sent' }),
  create_reminder: (p) => ({ summary: `Set a reminder${pick(p, 'title') ? `: ${pick(p, 'title')}` : ''}`, kind: 'did' }),
  play_music: (p) => ({ summary: `Played ${pick(p, 'query') || 'music'}`, kind: 'did' }),
  book_uber: (p) => ({ summary: `Opened an Uber to ${pick(p, 'destination', 'query', 'place', 'address') || 'a place'}`, kind: 'did', usedLocation: true }),
  book_appointment: () => ({ summary: 'Booked an appointment', kind: 'did' }),
  control_smart_home: (p) => ({ summary: `Changed ${pick(p, 'device') || 'a device'}${pick(p, 'command') ? ` (${pick(p, 'command')})` : ''}`, kind: 'did' }),
  remember_person: () => ({ summary: 'Remembered something about someone', kind: 'did' }),
  forget_person_detail: () => ({ summary: 'Forgot something about someone', kind: 'did' }),
  forget_memory: () => ({ summary: 'Forgot something', kind: 'did' }),
  show_scene: () => ({ summary: 'Showed something on a display', kind: 'did' }),
  render_to_display: () => ({ summary: 'Showed something on a display', kind: 'did' }),
  generate_visual: () => ({ summary: 'Made a picture', kind: 'did' }),
  create_presentation: () => ({ summary: 'Made a presentation', kind: 'did' }),
  create_diagram: () => ({ summary: 'Made a diagram', kind: 'did' }),
  create_google_doc: () => ({ summary: 'Created a document', kind: 'did' }),
  append_google_doc: () => ({ summary: 'Added to a document', kind: 'did' }),
  save_to_notion: () => ({ summary: 'Saved something to Notion', kind: 'did' }),
  daily_digest: () => ({ summary: 'Put together your daily check-in', kind: 'looked' }),
  create_scheduled_task: () => ({ summary: 'Set up something to run later', kind: 'did' }),
  cancel_scheduled_task: () => ({ summary: 'Cancelled something scheduled', kind: 'did' })
};

function humanize(type) {
  const spaced = String(type || 'unknown').replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * @param {object|string|null} action  the logged action (type plus its parameters)
 * @param {object} [contract]          the matching ACTION_CONTRACTS entry, if any
 * @returns {{summary: string, kind: 'looked'|'did'|'sent'|'spent'|'other', usedLocation: boolean, hidden: boolean}}
 */
function describeAction(action, contract = {}) {
  const type = String(action?.type || 'unknown');
  const params = action?.params || action?.input || action?.args || action || {};
  const hidden = INTERNAL_TYPES.has(type) || INTERNAL_PREFIXES.some((prefix) => type.startsWith(prefix));

  const describer = DESCRIBERS[type];
  if (describer) {
    const out = describer(params);
    return { summary: out.summary, kind: out.kind || 'other', usedLocation: out.usedLocation === true, hidden };
  }

  const fallback = contract.successSummary ? String(contract.successSummary) : humanize(type);
  const kind = contract.risk === 'low' && !contract.executionMode ? 'looked' : 'other';
  return { summary: fallback, kind, usedLocation: false, hidden };
}

module.exports = { describeAction };

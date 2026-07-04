const CALENDAR_READ_RE = /\b(check|read|show|look(?:\s+at)?|what'?s\s+on|what\s+is\s+on|tell\s+me|see|view|list|review)\b/i;
const CALENDAR_WRITE_RE = /\b(add|create|book|put|make|set\s+up)\b/i;
const CALENDAR_WORD_RE = /\b(calendar|event|schedule)\b/i;
const NON_CALENDAR_WRITE_NOUN_RE = /\b(song|album|playlist|music|apple music)\b/i;

function hasCalendarWriteVerb(text) {
  if (CALENDAR_WRITE_RE.test(text)) return true;
  // "schedule" is also a noun ("check my schedule"), so only treat it as a
  // write verb when it is command-like or paired with event timing, not when it
  // appears as the object of a read-only request.
  if (CALENDAR_READ_RE.test(text)) return false;
  return /^(?:please\s+)?schedule\b/i.test(text) ||
    /\bschedule\b.+\b(today|tomorrow|all day|at\s+\d{1,2}(?::\d{2})?\s*(am|pm)?)\b/i.test(text);
}

function calendarIntentKind(message = '') {
  const text = String(message || '').trim();
  if (!text) return 'none';
  const hasCalendarWord = CALENDAR_WORD_RE.test(text);
  const hasWriteVerb = hasCalendarWriteVerb(text);
  const hasReadVerb = CALENDAR_READ_RE.test(text);
  const datedWriteWithoutCalendar = /\b(add|create|put)\b.+\b(today|tomorrow|all day|at\s+\d{1,2}(?::\d{2})?\s*(am|pm)?)\b/i.test(text);

  if ((hasCalendarWord || datedWriteWithoutCalendar) && hasWriteVerb && !NON_CALENDAR_WRITE_NOUN_RE.test(text)) {
    return 'write';
  }
  if (hasCalendarWord && hasReadVerb) return 'read';
  if (hasCalendarWord) return 'read';
  return 'none';
}

function isExplicitCalendarWrite(message = '') {
  return calendarIntentKind(message) === 'write';
}

function isCalendarReadRequest(message = '') {
  return calendarIntentKind(message) === 'read';
}

function buildCalendarReadAction(message = '') {
  const text = String(message || '');
  const input = { max_results: 8 };
  if (/\btomorrow\b/i.test(text)) input.when = 'tomorrow';
  if (/\btoday\b/i.test(text)) input.when = 'today';
  return {
    reason: 'calendar_read',
    spoken: "I'll check your calendar.",
    actions: [{ type: 'get_calendar_events', input }]
  };
}

module.exports = {
  buildCalendarReadAction,
  calendarIntentKind,
  isCalendarReadRequest,
  isExplicitCalendarWrite
};

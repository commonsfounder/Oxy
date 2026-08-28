'use strict';

// Local-time helpers, and the one definition of the timezone default. Everything user-facing is
// expressed in the user's wall-clock day, which raw Date arithmetic silently breaks across
// BST/GMT — so formatting goes through Intl with an explicit zone every time.

const DEFAULT_TIMEZONE = 'Europe/London';

function timezone() {
  return process.env.TIMEZONE || DEFAULT_TIMEZONE;
}

// Sortable YYYY-MM-DD in the user's zone. en-CA is used because it formats exactly that
// way; it is a formatting trick, not a locale preference.
function getLocalDateKey(date = new Date(), timeZone = timezone()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function getLocalHour(date = new Date(), timeZone = timezone()) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hour12: false
  }).format(date));
}

function getLocalMinute(date = new Date(), timeZone = timezone()) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone,
    minute: '2-digit'
  }).format(date));
}

const PROACTIVE_WINDOWS = Object.freeze([
  { id: 'wake', label: 'Wake briefing', start: 6, end: 10 },
  { id: 'midday', label: 'Midday briefing', start: 12, end: 14 },
  { id: 'evening', label: 'Evening briefing', start: 17, end: 20 }
]);

function getBriefingWindow(now = new Date(), windows = PROACTIVE_WINDOWS) {
  const hour = getLocalHour(now);
  return windows.find(window => hour >= window.start && hour <= window.end) || null;
}

module.exports = {
  DEFAULT_TIMEZONE,
  PROACTIVE_WINDOWS,
  getBriefingWindow,
  getLocalDateKey,
  getLocalHour,
  getLocalMinute,
  timezone
};

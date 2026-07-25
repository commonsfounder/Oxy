// Shared request-body/query guards. These exist because `field?.trim()` only guards
// null/undefined — a non-string value from a buggy client reached .trim() and threw,
// turning what should be a 400 into a 500 that leaked the raw internal error message.
// Same idea as isValidUserId in api/index.js: check the TYPE before touching the value.

// True only for a string carrying non-whitespace content. Never throws, whatever it's given.
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// A calendar date must be both the right SHAPE and a date that actually exists.
// /^\d{4}-\d{2}-\d{2}$/ alone accepts "9999-99-99" and "2026-02-30", which then blow up
// in new Date(...).toISOString(). Round-tripping through Date catches the rollover:
// "2026-02-30" parses as March 2, so the components no longer match what was asked for.
function isValidCalendarDate(value) {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return false;
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

module.exports = { isNonEmptyString, isValidCalendarDate };

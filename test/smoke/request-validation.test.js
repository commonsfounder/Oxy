const test = require('node:test');
const assert = require('node:assert');
const { isNonEmptyString, isValidCalendarDate } = require('../../api/services/request-validation');

// Regression: routes guarded text fields with `field?.trim()`, which only guards
// null/undefined. A non-string body value (number, array, object — trivially sent by a
// buggy client) reached .trim() and threw, turning a 400 into a 500 that leaked the raw
// internal message ("message?.trim is not a function") to the caller.
test('isNonEmptyString accepts a string with real content', () => {
  assert.equal(isNonEmptyString('hello'), true);
  assert.equal(isNonEmptyString('  hi  '), true);
});

test('isNonEmptyString rejects empty and whitespace-only strings', () => {
  for (const v of ['', '   ', '\n\t ']) {
    assert.equal(isNonEmptyString(v), false, `expected ${JSON.stringify(v)} to be rejected`);
  }
});

test('isNonEmptyString rejects non-string values instead of throwing', () => {
  for (const v of [123, 0, true, false, ['a', 'b'], { a: 1 }, null, undefined, NaN]) {
    assert.doesNotThrow(() => isNonEmptyString(v));
    assert.equal(isNonEmptyString(v), false, `expected ${JSON.stringify(v)} to be rejected`);
  }
});

// Regression: /history/:userId/date validated only the SHAPE of the date with
// /^\d{4}-\d{2}-\d{2}$/, so "9999-99-99" passed, then new Date(...).toISOString()
// threw a RangeError -> 500 "Invalid time value". A month-13/day-32 value is easy to
// produce from a client-side timezone rollover, not just a fuzzer.
test('isValidCalendarDate accepts real calendar dates', () => {
  for (const v of ['2026-07-24', '2024-02-29', '1999-12-31']) {
    assert.equal(isValidCalendarDate(v), true, `expected ${v} to be accepted`);
  }
});

test('isValidCalendarDate rejects shape-valid but impossible dates', () => {
  for (const v of ['9999-99-99', '2026-13-01', '2026-00-10', '2026-02-30', '2025-02-29', '2026-04-31']) {
    assert.equal(isValidCalendarDate(v), false, `expected ${v} to be rejected`);
  }
});

test('isValidCalendarDate rejects malformed and non-string input without throwing', () => {
  for (const v of ['', '2026-7-4', '../../etc/passwd', '2026-07-24T00:00', 20260724, null, undefined, {}, []]) {
    assert.doesNotThrow(() => isValidCalendarDate(v));
    assert.equal(isValidCalendarDate(v), false, `expected ${JSON.stringify(v)} to be rejected`);
  }
});

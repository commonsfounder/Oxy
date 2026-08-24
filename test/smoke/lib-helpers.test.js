'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const time = require('../../api/lib/time');
const text = require('../../api/lib/text');

test('local time helpers report the user wall-clock day, not UTC', () => {
  // 00:30 UTC on 1 July is 01:30 in London, so the local day is still the 1st. The same
  // instant in New York is still 30 June. Raw Date arithmetic gets this wrong.
  const summerNight = new Date('2026-07-01T00:30:00Z');
  assert.equal(time.getLocalDateKey(summerNight, 'Europe/London'), '2026-07-01');
  assert.equal(time.getLocalDateKey(summerNight, 'America/New_York'), '2026-06-30');

  // 23:30 UTC in summer is already the next day in London -- the BST offset that makes
  // "today's digest" land on the wrong date when this is done in UTC.
  const summerLate = new Date('2026-07-01T23:30:00Z');
  assert.equal(time.getLocalDateKey(summerLate, 'Europe/London'), '2026-07-02');

  // In winter London is UTC, so the same clock time does not roll over.
  const winterLate = new Date('2026-01-01T23:30:00Z');
  assert.equal(time.getLocalDateKey(winterLate, 'Europe/London'), '2026-01-01');

  assert.equal(time.getLocalHour(summerNight, 'Europe/London'), 1);
  assert.equal(time.getLocalMinute(summerNight, 'Europe/London'), 30);
  assert.equal(time.getLocalDateKey(summerNight, 'Europe/London').length, 10);
});

test('briefing windows only fire inside their own hours', () => {
  const at = hour => new Date(Date.UTC(2026, 0, 15, hour, 0, 0));
  assert.equal(time.getBriefingWindow(at(8))?.id, 'wake');
  assert.equal(time.getBriefingWindow(at(13))?.id, 'midday');
  assert.equal(time.getBriefingWindow(at(18))?.id, 'evening');
  // Gaps between windows must return nothing rather than the nearest window.
  assert.equal(time.getBriefingWindow(at(11)), null);
  assert.equal(time.getBriefingWindow(at(3)), null);
  assert.equal(time.getBriefingWindow(at(23)), null);
});

test('the two JSON parsers are not interchangeable', () => {
  // safeParseJSON hands back the original when it will not parse, because the value may
  // legitimately be a plain string from a database column.
  assert.deepEqual(text.safeParseJSON('{"a":1}'), { a: 1 });
  assert.equal(text.safeParseJSON('just a string'), 'just a string');
  assert.equal(text.safeParseJSON(42), 42);

  // parseLooseJson returns null instead, so a real parse failure stays visible, and it
  // strips the code fences a model wraps its output in.
  assert.equal(text.parseLooseJson('just a string'), null);
  assert.deepEqual(text.parseLooseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(text.parseLooseJson('```\n{"a":1}\n```'), { a: 1 });
  assert.equal(text.parseLooseJson(''), null);
  assert.equal(text.parseLooseJson(null), null);

  // parseJsonObject insists on a plain object; arrays and scalars are not objects here.
  assert.deepEqual(text.parseJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(text.parseJsonObject('[1,2]'), {});
  assert.deepEqual(text.parseJsonObject('nope'), {});
  assert.deepEqual(text.parseJsonObject(null), {});
});

test('search patterns and html are escaped so user input cannot change their meaning', () => {
  // Unescaped, "50%" matches everything and an underscore matches any character.
  assert.equal(text.escapeIlikePattern('50%'), '50\\%');
  assert.equal(text.escapeIlikePattern('a_b'), 'a\\_b');
  assert.equal(text.escapeIlikePattern('back\\slash'), 'back\\\\slash');
  assert.equal(text.escapeIlikePattern(null), '');

  assert.equal(text.escapeHtml('<script>alert("x")</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.equal(text.escapeHtml("it's"), 'it&#039;s');
});

test('user ids are constrained to a safe shape', () => {
  assert.equal(text.isValidUserId('abc-123_XYZ'), true);
  assert.equal(text.isValidUserId(''), false);
  assert.equal(text.isValidUserId('has spaces'), false);
  assert.equal(text.isValidUserId('drop/table'), false);
  assert.equal(text.isValidUserId('a'.repeat(129)), false);
  assert.equal(text.isValidUserId('a'.repeat(128)), true);
  assert.equal(text.isValidUserId(null), false);
  assert.equal(text.isValidUserId(123), false);
});

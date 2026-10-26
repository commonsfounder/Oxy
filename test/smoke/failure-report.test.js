const test = require('node:test');
const assert = require('node:assert');
const { causeOf, summarizeTurn, buildFailureReport } = require('../../api/services/failure-report');

test('sorts real error wording into plain causes', () => {
  assert.strictEqual(causeOf('https://x.com is blocking automated access (bot wall).'), 'bot_wall');
  assert.strictEqual(causeOf('loaded as a blank page'), 'blank_page');
  assert.strictEqual(causeOf("is the site's own error page, so that address did not work"), 'error_page');
  assert.strictEqual(causeOf('elementId 7 is not on the current page (0-3).'), 'control_missing');
  assert.strictEqual(causeOf('request timed out'), 'timeout');
  assert.strictEqual(causeOf('Gmail is not connected'), 'not_connected');
  assert.strictEqual(causeOf('something odd'), 'other');
  assert.strictEqual(causeOf(''), 'unknown');
});

test('a turn names its first failing step', () => {
  const turn = summarizeTurn([
    { action: 'web_search', result: { outcome: 'completed', success: true } },
    { action: 'browser_open', result: { outcome: 'unavailable', success: false, error: 'bot wall' } },
  ]);
  assert.strictEqual(turn.failures, 1);
  assert.strictEqual(turn.firstFailure.action, 'browser_open');
  assert.strictEqual(turn.firstFailure.cause, 'bot_wall');
});

test('the report counts failures per action and cause, recent rows only', () => {
  const now = new Date('2026-10-25T12:00:00Z');
  const rows = [
    { action: { type: 'browser_open' }, status: 'failed', error: 'blank page', created_at: '2026-10-24T10:00:00Z' },
    { action: { type: 'browser_open' }, status: 'executed', error: null, created_at: '2026-10-24T11:00:00Z' },
    { action: JSON.stringify({ type: 'web_search' }), status: 'executed', error: null, created_at: '2026-10-24T11:00:00Z' },
    { action: { type: 'browser_open' }, status: 'failed', error: 'blank page', created_at: '2026-09-01T10:00:00Z' },
    { action: { type: 'x' }, status: 'pending', error: null, created_at: '2026-10-24T10:00:00Z' },
  ];
  const report = buildFailureReport(rows, { days: 7, now });
  assert.strictEqual(report.total, 3);
  assert.strictEqual(report.failed, 1);
  assert.deepStrictEqual(report.byCause, { blank_page: 1 });
  assert.strictEqual(report.actions[0].action, 'browser_open');
  assert.strictEqual(report.actions[0].failureRate, 0.5);
});

test('a failed result gets one plain next step, a working one does not', () => {
  const { normalizeActionOutcome } = require('../../api/services/action-outcome');
  const failed = normalizeActionOutcome({ success: false, error: 'https://x.com is blocking automated access (bot wall).' });
  assert.match(failed.nextStep, /another site/i);
  const odd = normalizeActionOutcome({ success: false, error: 'something odd' });
  assert.strictEqual(odd.nextStep, undefined);
  const ok = normalizeActionOutcome({ success: true, text: 'done' });
  assert.strictEqual(ok.nextStep, undefined);
});

test('an out-of-credit provider is named as such, not as a rate limit', () => {
  assert.strictEqual(causeOf('OpenAI 429: {"type": "insufficient_quota"}'), 'out_of_credit');
  assert.strictEqual(causeOf('Too many requests, 429'), 'rate_limited');
});

test('an out-of-credit provider gets its own plain reply for the user', () => {
  const { formatProviderFailure } = require('../../api/services/user-facing-copy');
  assert.match(formatProviderFailure('OpenAI 429: {"type":"insufficient_quota"}'), /out of capacity/i);
  assert.match(formatProviderFailure('something else broke'), /could not answer/i);
});

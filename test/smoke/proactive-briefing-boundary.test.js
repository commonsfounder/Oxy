'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const source = fs.readFileSync(require.resolve('../../api/index.js'), 'utf8');

function functionBody(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  return source.slice(start, source.indexOf('\n}\n', start));
}

test('the proactive sweep has one general briefing path, not source or task-specific emitters', () => {
  const sweep = functionBody('runProactiveForUser');
  assert.match(sweep, /maybeCreateIntervalBriefing/);
  assert.doesNotMatch(sweep, /daily_digest|delegatedRunLifecycle\.list/,
    'the sweep must not grow a second digest or task-category notifier beside the shared briefing');

  for (const legacy of [
    'maybeCreateEmailNudges', 'maybeCreateCalendarNudges', 'email_nudge',
    'calendar_nudge', 'money_task_update', 'proactive.money_task'
  ]) {
    assert.doesNotMatch(source, new RegExp(legacy), `${legacy} must not remain as a proactive subsystem`);
  }
});

test('the general proactive snapshot reuses the same ranked daily digest as conversation', () => {
  const gather = functionBody('gatherProactiveBriefingSnapshot');
  assert.match(gather, /executeAction\(userId, 'daily_digest'/);

  const create = functionBody('maybeCreateIntervalBriefing');
  assert.match(create, /lifeBriefingSignature/);
  assert.match(create, /formatDigestNotification/);
  assert.match(create, /notificationDelivery\.raise/);
  assert.doesNotMatch(create, /generateBrain|buildSystemPrompt/);
});

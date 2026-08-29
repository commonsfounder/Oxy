'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const source = fs.readFileSync(require.resolve('../../api/index.js'), 'utf8');

function functionBody(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  return source.slice(start, source.indexOf('\n}\n', start));
}

test('action logging persists the general recovery decision in bounded form', () => {
  const serialize = functionBody('serializeLoggedAction');
  assert.match(serialize, /recoverySnapshot\(result\)/);
});

test('failed-action follow-up routes through the shared notification boundary', () => {
  const followUp = functionBody('maybeCreateFailedActionFollowUp');
  assert.match(followUp, /raiseRecentActionFollowUp/);
  assert.match(followUp, /raise: notificationDelivery\.raise/);
  assert.doesNotMatch(followUp, /createBriefing|getPreferenceMap|setPreferenceValue/,
    'follow-ups must honor shared channels, quiet hours and event dedupe');
});

test('failed-action follow-up contains no task-domain allowlist or denylist', () => {
  const followUp = functionBody('maybeCreateFailedActionFollowUp');
  assert.doesNotMatch(followUp, /find_place|get_directions|plan_trip|play_music|music_control|add_to_music_playlist/);
});

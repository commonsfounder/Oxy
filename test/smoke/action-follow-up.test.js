'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildActionFollowUp,
  raiseRecentActionFollowUp,
  recoverySnapshot
} = require('../../api/services/action-follow-up');

test('stores only bounded recovery evidence, never action input or provider payloads', () => {
  const snapshot = recoverySnapshot({
    success: false,
    cardText: 'Reconnect Google in Settings. https://private.example token@example.com',
    retryable: true,
    healthStatus: 'needs_reconnect',
    recoveryAction: {
      type: 'open_connector_settings',
      connectorId: 'google',
      action: { type: 'send_email', input: { body: 'private' } },
      token: 'secret'
    }
  });
  assert.deepEqual(snapshot, {
    cardText: 'Reconnect Google in Settings.',
    retryable: true,
    healthStatus: 'needs_reconnect',
    action: { type: 'open_connector_settings', connectorId: 'google' }
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /private|token|secret|send_email/);
});

test('any connector action with explicit reconnect recovery gets the same follow-up', () => {
  for (const type of ['get_calendar_events', 'play_music', 'get_directions']) {
    const followUp = buildActionFollowUp({
      id: `log-${type}`,
      status: 'failed',
      action: {
        type,
        recovery: {
          cardText: 'Reconnect the connector in Settings.',
          healthStatus: 'needs_reconnect',
          action: { type: 'open_connector_settings', connectorId: 'service' }
        }
      }
    }, { actionLabel: 'Connected action' });
    assert.equal(followUp.title, 'Connected action needs you');
    assert.equal(followUp.sourceRef.actionType, type);
    assert.equal(followUp.recoveryAction.type, 'open_connector_settings');
  }
});

test('a browser sign-in wall is user-recoverable without becoming a browser-specific policy branch', () => {
  const followUp = buildActionFollowUp({
    id: 'log-browser',
    status: 'failed',
    action: JSON.stringify({
      type: 'browser_sign_in',
      recovery: { action: { type: 'reauth_login', site: 'example.com' } }
    })
  }, { actionLabel: 'Sign-in' });
  assert.match(followUp.body, /sign in again/i);
  assert.deepEqual(followUp.recoveryAction, { type: 'reauth_login', site: 'example.com' });
});

test('transient, validation and ordinary failures do not turn into user interruptions', () => {
  const rows = [
    { status: 'failed', action: { type: 'web_search', recovery: { action: { type: 'retry_action' }, retryable: true } } },
    { status: 'failed', action: { type: 'send_email', recovery: { cardText: 'Missing body.', retryable: true } } },
    { status: 'failed', action: { type: 'calculate', error: 'provider exploded' } },
    { status: 'executed', action: { type: 'get_calendar_events', recovery: { action: { type: 'open_connector_settings' } } } }
  ];
  for (const row of rows) assert.equal(buildActionFollowUp(row), null);
});

test('legacy auth failures are supported without inspecting the task domain', () => {
  const followUp = buildActionFollowUp({
    id: 'old-log', status: 'failed',
    action: JSON.stringify({ type: 'play_music', error: 'Spotify token expired' })
  }, { actionLabel: 'Music' });
  assert.equal(followUp.recoveryAction.type, 'open_connector_settings');
  assert.match(followUp.body, /connection restored/i);
});

test('recent recovery evidence is raised through one general notification shape', async () => {
  const calls = [];
  const result = await raiseRecentActionFollowUp({
    userId: 'u1',
    now: new Date('2026-08-29T12:00:00Z'),
    failures: [{
      id: 'log-1', status: 'failed', created_at: '2026-08-29T11:45:00Z',
      action: {
        type: 'get_calendar_events',
        recovery: {
          cardText: 'Reconnect Google in Settings.',
          action: { type: 'open_connector_settings', connectorId: 'google' }
        }
      }
    }],
    raise: async (userId, event) => { calls.push({ userId, event }); return { ok: true, created: true }; }
  });
  assert.equal(result.type, 'action_required');
  assert.equal(calls[0].userId, 'u1');
  assert.equal(calls[0].event.category, 'action_required');
  assert.equal(calls[0].event.dedupeKey, 'action_required|state:log-1');
  assert.deepEqual(calls[0].event.sourceRef, {
    actionLogId: 'log-1', actionType: 'get_calendar_events',
    recoveryType: 'open_connector_settings', connectorId: 'google'
  });
});

test('a duplicate newest failure does not hide an older distinct recovery need', async () => {
  const calls = [];
  const failure = (id, type) => ({
    id, status: 'failed', created_at: '2026-08-29T11:45:00Z',
    action: { type, recovery: { action: { type: 'open_connector_settings', connectorId: 'service' } } }
  });
  const result = await raiseRecentActionFollowUp({
    userId: 'u1', now: new Date('2026-08-29T12:00:00Z'),
    failures: [failure('newest', 'play_music'), failure('older', 'get_calendar_events')],
    raise: async (_userId, event) => {
      calls.push(event.dedupeKey);
      return event.dedupeKey.endsWith('newest') ? { ok: true, duplicate: true } : { ok: true, created: true };
    }
  });
  assert.deepEqual(calls, ['action_required|state:newest', 'action_required|state:older']);
  assert.equal(result.event.sourceRef.actionLogId, 'older');
});

test('stale and future-dated failures are not raised', async () => {
  let calls = 0;
  const result = await raiseRecentActionFollowUp({
    userId: 'u1', now: new Date('2026-08-29T12:00:00Z'), maxAgeMs: 60 * 60 * 1000,
    failures: [
      { id: 'stale', status: 'failed', created_at: '2026-08-29T10:00:00Z', action: { type: 'x', error: 'token expired' } },
      { id: 'future', status: 'failed', created_at: '2026-08-29T13:00:00Z', action: { type: 'x', error: 'token expired' } }
    ],
    raise: async () => { calls += 1; return { ok: true }; }
  });
  assert.equal(result, null);
  assert.equal(calls, 0);
});

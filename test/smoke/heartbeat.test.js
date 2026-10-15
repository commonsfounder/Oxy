const assert = require('node:assert/strict');
const test = require('node:test');

const { heartbeatSettings, startHeartbeat } = require('../../api/services/heartbeat');
const scheduledTasks = require('../../api/services/scheduled-tasks');

function fakeTimers() {
  const handles = [];
  const make = kind => (fn, ms) => { const h = { kind, fn, ms, cleared: false, unref() {} }; handles.push(h); return h; };
  return {
    handles,
    timers: {
      setTimeout: make('timeout'), setInterval: make('interval'),
      clearTimeout: h => { h.cleared = true; }, clearInterval: h => { h.cleared = true; }
    }
  };
}

test('the heartbeat is off unless switched on, and reads its interval', () => {
  assert.equal(heartbeatSettings({}).enabled, false);
  assert.equal(heartbeatSettings({ OXY_HEARTBEAT: 'off' }).enabled, false);
  assert.deepEqual(heartbeatSettings({ OXY_HEARTBEAT: 'on' }), { enabled: true, intervalMs: 5 * 60 * 1000 });
  assert.equal(heartbeatSettings({ OXY_HEARTBEAT: 'ON', OXY_HEARTBEAT_MINUTES: '2' }).intervalMs, 120000);
  assert.equal(heartbeatSettings({ OXY_HEARTBEAT: 'on', OXY_HEARTBEAT_MINUTES: 'soon' }).intervalMs, 5 * 60 * 1000);
});

test('a sweep never overlaps itself, and a failing sweep does not stop the next one', async () => {
  const { handles, timers } = fakeTimers();
  const logs = [];
  let calls = 0;
  let release;
  const beat = startHeartbeat({
    sweep: () => { calls += 1; return calls === 1 ? new Promise(r => { release = () => r({ ok: 1 }); }) : Promise.reject(new Error('boom')); },
    intervalMs: 1000, firstRunDelayMs: 10, logger: { log: m => logs.push(m), error: m => logs.push(m) }, timers
  });
  assert.deepEqual(handles.map(h => h.kind), ['timeout', 'interval']);

  const first = beat.tick();
  assert.deepEqual(await beat.tick(), { skipped: true });
  release();
  await first;
  const second = await beat.tick();
  assert.equal(second.error.message, 'boom');
  assert.equal(calls, 2);
  assert.ok(logs.some(l => l.includes('sweep failed: boom')));

  beat.stop();
  assert.ok(handles.every(h => h.cleared));
});

test('an old reminder or a finished watch is closed, never run late', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const once = (next_run_at) => ({ recurrence: 'once', next_run_at });
  assert.equal(scheduledTasks.staleScheduledReason(once('2026-09-10T10:00:00Z'), now), 'missed');
  assert.equal(scheduledTasks.staleScheduledReason(once('2026-10-15T11:30:00Z'), now), null);
  assert.equal(scheduledTasks.staleScheduledReason({ recurrence: 'poll', next_run_at: '2026-10-15T11:59:00Z', expires_at: '2026-09-07T00:00:00Z' }, now), 'expired');
  assert.equal(scheduledTasks.staleScheduledReason({ recurrence: 'poll', next_run_at: '2026-10-15T11:59:00Z', expires_at: '2026-11-01T00:00:00Z' }, now), null);
  assert.equal(scheduledTasks.staleScheduledReason({ recurrence: 'daily', next_run_at: '2026-01-01T00:00:00Z' }, now), null);
});

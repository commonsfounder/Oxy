const assert = require('node:assert/strict');
const test = require('node:test');

const { formatTractionReport, isoWeekStart, summarizeTraction } = require('../../api/services/traction-metrics');

const NOW = new Date('2026-10-14T12:00:00Z'); // a Wednesday; its week starts Monday 12 October

test('weeks start on Monday in UTC', () => {
  assert.equal(isoWeekStart('2026-10-12T00:00:00Z'), '2026-10-12');
  assert.equal(isoWeekStart('2026-10-18T23:59:59Z'), '2026-10-12');
  assert.equal(isoWeekStart('2026-10-11T23:59:59Z'), '2026-10-05');
  assert.equal(isoWeekStart('not a date'), null);
});

test('only people who sent a message count as active, and test or named accounts never count', () => {
  const summary = summarizeTraction({
    now: NOW,
    weeks: 2,
    excludeIds: ['founder'],
    messages: [
      { user_id: 'alice', role: 'user', created_at: '2026-10-13T09:00:00Z' },
      { user_id: 'bob', role: 'assistant', created_at: '2026-10-13T09:00:00Z' },
      { user_id: 'founder', role: 'user', created_at: '2026-10-13T09:00:00Z' },
      { user_id: 'demo-test-user', role: 'user', created_at: '2026-10-13T09:00:00Z' }
    ]
  });
  assert.equal(summary.weeklyActiveUsers, 1);
  assert.equal(summary.weeks[1].userMessages, 1);
});

test('retention and growth compare this week with last week', () => {
  const summary = summarizeTraction({
    now: NOW,
    weeks: 2,
    messages: [
      { user_id: 'alice', role: 'user', created_at: '2026-10-06T09:00:00Z' },
      { user_id: 'bob', role: 'user', created_at: '2026-10-07T09:00:00Z' },
      { user_id: 'alice', role: 'user', created_at: '2026-10-13T09:00:00Z' },
      { user_id: 'carol', role: 'user', created_at: '2026-10-13T09:00:00Z' },
      { user_id: 'dan', role: 'user', created_at: '2026-10-14T09:00:00Z' }
    ]
  });
  assert.equal(summary.weeks[0].activeUsers, 2);
  assert.equal(summary.weeks[1].activeUsers, 3);
  assert.equal(summary.weeks[1].retainedFromPreviousWeek, 1);
  assert.equal(summary.weekOverWeekGrowthPercent, 50);
});

test('an action counts as done only when the boundary executed it', () => {
  const summary = summarizeTraction({
    now: NOW,
    weeks: 2,
    actions: [
      { user_id: 'alice', status: 'executed', created_at: '2026-10-13T09:00:00Z' },
      { user_id: 'alice', status: 'executed', created_at: '2026-10-13T09:00:00Z' },
      { user_id: 'alice', status: 'failed', created_at: '2026-10-13T09:00:00Z' },
      { user_id: 'alice', status: 'pending', created_at: '2026-10-13T09:00:00Z' }
    ],
    tasks: [
      { user_id: 'alice', status: 'completed', completed_at: '2026-10-13T10:00:00Z' },
      { user_id: 'alice', status: 'paused', created_at: '2026-10-13T10:00:00Z' }
    ]
  });
  const week = summary.weeks[1];
  assert.equal(week.actionsExecuted, 2);
  assert.equal(week.actionsFailed, 1);
  assert.equal(week.actionSuccessRate, 0.67);
  assert.equal(week.tasksCompleted, 1);
});

test('rows outside the window are ignored and an empty week reads as zero, not missing', () => {
  const summary = summarizeTraction({
    now: NOW,
    weeks: 2,
    messages: [{ user_id: 'alice', role: 'user', created_at: '2025-01-01T00:00:00Z' }],
    users: [{ user_id: 'alice', created_at: '2026-10-12T08:00:00Z' }]
  });
  assert.equal(summary.weeklyActiveUsers, 0);
  assert.equal(summary.weeks[1].newUsers, 1);
  assert.equal(summary.weekOverWeekGrowthPercent, null);
  assert.match(formatTractionReport(summary), /Week of 2026-10-12: 0 weekly active/);
});

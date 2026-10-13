// Weekly usage numbers from rows the product already writes. Pure: callers fetch the rows.
//
// The point is an honest denominator. Test and founder accounts are excluded by id, a user is
// "active" in a week only if they sent at least one message, and an action counts as done only
// when the execution boundary logged it as executed — not when the model asked for it.

const TEST_ACCOUNT = /^(demo|test)|test-user|-test$/i;

function isoWeekStart(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const day = (date.getUTCDay() + 6) % 7; // Monday = 0
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day));
  return start.toISOString().slice(0, 10);
}

function weeksEnding(now, count) {
  const last = isoWeekStart(now);
  const weeks = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(`${last}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 7 * i);
    weeks.push(d.toISOString().slice(0, 10));
  }
  return weeks;
}

function makeExcluder(excludeIds = []) {
  const excluded = new Set(excludeIds.map(id => String(id).trim()).filter(Boolean));
  return userId => !userId || excluded.has(String(userId)) || TEST_ACCOUNT.test(String(userId));
}

function summarizeTraction({ messages = [], actions = [], tasks = [], users = [], excludeIds = [], now = new Date(), weeks = 8 } = {}) {
  const excluded = makeExcluder(excludeIds);
  const window = weeksEnding(now, weeks);
  const rows = new Map(window.map(week => [week, {
    week,
    activeUsers: new Set(),
    userMessages: 0,
    actionsExecuted: 0,
    actionsFailed: 0,
    tasksCompleted: 0,
    newUsers: 0
  }]));
  const activeDays = new Map();

  for (const message of messages) {
    if (message.role !== 'user' || excluded(message.user_id)) continue;
    const row = rows.get(isoWeekStart(message.created_at));
    if (!row) continue;
    row.activeUsers.add(message.user_id);
    row.userMessages += 1;
    const days = activeDays.get(message.user_id) || new Set();
    days.add(String(message.created_at).slice(0, 10));
    activeDays.set(message.user_id, days);
  }

  for (const action of actions) {
    if (excluded(action.user_id)) continue;
    const row = rows.get(isoWeekStart(action.created_at));
    if (!row) continue;
    if (action.status === 'executed') row.actionsExecuted += 1;
    else if (action.status === 'failed') row.actionsFailed += 1;
  }

  for (const task of tasks) {
    if (task.status !== 'completed' || excluded(task.user_id)) continue;
    const row = rows.get(isoWeekStart(task.completed_at || task.updated_at || task.created_at));
    if (row) row.tasksCompleted += 1;
  }

  for (const user of users) {
    if (excluded(user.user_id)) continue;
    const row = rows.get(isoWeekStart(user.created_at));
    if (row) row.newUsers += 1;
  }

  const ordered = window.map(week => rows.get(week));
  const series = ordered.map((row, index) => {
    const previous = index > 0 ? ordered[index - 1].activeUsers : null;
    const retained = previous ? [...row.activeUsers].filter(id => previous.has(id)).length : null;
    const attempted = row.actionsExecuted + row.actionsFailed;
    return {
      week: row.week,
      activeUsers: row.activeUsers.size,
      retainedFromPreviousWeek: retained,
      newUsers: row.newUsers,
      userMessages: row.userMessages,
      actionsExecuted: row.actionsExecuted,
      actionsFailed: row.actionsFailed,
      actionSuccessRate: attempted ? Math.round((row.actionsExecuted / attempted) * 100) / 100 : null,
      tasksCompleted: row.tasksCompleted
    };
  });

  const current = series[series.length - 1];
  const previous = series[series.length - 2];
  const growth = previous && previous.activeUsers
    ? Math.round(((current.activeUsers - previous.activeUsers) / previous.activeUsers) * 100)
    : null;
  const usersWithThreePlusDays = [...activeDays.values()].filter(days => days.size >= 3).length;

  return {
    weeks: series,
    currentWeek: current.week,
    weeklyActiveUsers: current.activeUsers,
    weekOverWeekGrowthPercent: growth,
    usersActiveThreePlusDaysInWindow: usersWithThreePlusDays,
    excludedAccounts: excludeIds.length
  };
}

function formatTractionReport(summary) {
  const lines = [
    `Week of ${summary.currentWeek}: ${summary.weeklyActiveUsers} weekly active (excluding ${summary.excludedAccounts} named and all test accounts)` +
      (summary.weekOverWeekGrowthPercent == null ? '' : `, ${summary.weekOverWeekGrowthPercent >= 0 ? '+' : ''}${summary.weekOverWeekGrowthPercent}% on last week`),
    `${summary.usersActiveThreePlusDaysInWindow} people used it on 3 or more days in this window.`,
    '',
    'week        active  kept  new  msgs  done  failed  ok%   tasks'
  ];
  for (const w of summary.weeks) {
    lines.push([
      w.week,
      String(w.activeUsers).padStart(6),
      String(w.retainedFromPreviousWeek ?? '-').padStart(5),
      String(w.newUsers).padStart(4),
      String(w.userMessages).padStart(5),
      String(w.actionsExecuted).padStart(5),
      String(w.actionsFailed).padStart(7),
      (w.actionSuccessRate == null ? '-' : String(Math.round(w.actionSuccessRate * 100))).padStart(5),
      String(w.tasksCompleted).padStart(6)
    ].join(' '));
  }
  return lines.join('\n');
}

module.exports = { formatTractionReport, isoWeekStart, summarizeTraction, weeksEnding };

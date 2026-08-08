// Pure ranking/noise logic for the "what's on my plate" digest (api/services/daily-digest.js).
// The orchestration — that each source is genuinely re-read live — is covered separately in
// daily-digest-orchestration.test.js against the real action.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildDailyDigest,
  normalizeReplyItem,
  normalizeOccasionItem,
  normalizeReminderItem,
  normalizeWatchUpdate,
  DIGEST_MARKER
} = require('../../api/services/daily-digest');

const NOW = new Date('2026-08-08T08:00:00.000Z');

function hoursFromNow(h) {
  return new Date(NOW.getTime() + h * 3600000).toISOString();
}

function daysAgo(d) {
  return new Date(NOW.getTime() - d * 86400000).toISOString();
}

// A birthday `n` days out, expressed as the month/day the occasions table stores.
function occasionInDays(personName, n, extra = {}) {
  const date = new Date(NOW.getTime() + n * 86400000);
  return {
    personName,
    occasionType: 'birthday',
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    ...extra
  };
}

// ── No-action day ──────────────────────────────────────────────────────────────────────
test('a day with nothing on it says so concisely, not with an empty structure', () => {
  const digest = buildDailyDigest({ now: NOW });
  assert.equal(digest.empty, true);
  assert.equal(digest.items.length, 0);
  assert.match(digest.text, /Nothing needs you today/);
});

// ── One urgent reply-needed thread ─────────────────────────────────────────────────────
test('an urgent reply-needed thread lands in the "needs you now" tier with a usable ref', () => {
  const digest = buildDailyDigest({
    now: NOW,
    replyNeeded: [{
      threadId: 'thread-mia',
      sender: 'Mia Roberts',
      subject: 'Next week',
      whatTheyNeed: 'confirm your availability for next week',
      kind: 'reply',
      urgency: 'now',
      waitingSince: daysAgo(2)
    }]
  });

  assert.equal(digest.items.length, 1);
  const item = digest.items[0];
  assert.equal(item.kind, 'reply_needed');
  assert.equal(item.urgency, 'now');
  assert.equal(item.ref.threadId, 'thread-mia');
  assert.match(item.detail, /Mia Roberts is waiting on you to confirm your availability/);
  assert.match(item.followUp, /Draft the reply to Mia/);
  assert.match(digest.text, /Needs you now/);
});

test('a thread someone has been waiting on for a week outranks one from this morning', () => {
  const base = { threadId: 't', sender: 'Sam', whatTheyNeed: 'reply', kind: 'reply', urgency: 'soon' };
  const stale = normalizeReplyItem({ ...base, threadId: 'old', waitingSince: daysAgo(9) }, NOW);
  const fresh = normalizeReplyItem({ ...base, threadId: 'new', waitingSince: daysAgo(0) }, NOW);
  assert.ok(stale.priority > fresh.priority);
});

// ── Multiple priorities in one day ─────────────────────────────────────────────────────
test('multiple priorities are ranked against each other, not just concatenated', () => {
  const digest = buildDailyDigest({
    now: NOW,
    replyNeeded: [{ threadId: 't1', sender: 'Mia', whatTheyNeed: 'confirm a time', kind: 'reply', urgency: 'soon', waitingSince: daysAgo(1) }],
    occasions: [occasionInDays('Alisa', 11)],
    calendarEvents: [{ id: 'ev1', summary: 'Interview', start: { dateTime: hoursFromNow(6) } }],
    scheduledTasks: [{ id: 'sch1', title: 'Renew car insurance', next_run_at: hoursFromNow(-3), recurrence: 'once' }]
  });

  const kinds = digest.items.map(i => i.kind);
  // The overdue reminder and the interview beat the reply; the distant birthday is last.
  assert.equal(kinds[0], 'reminder');
  assert.equal(kinds[kinds.length - 1], 'occasion');
  assert.ok(kinds.includes('calendar'));
  assert.ok(kinds.includes('reply_needed'));
  assert.match(digest.text, /Can wait: Alisa's birthday is in 11 days/);
});

// ── Birthday in two weeks vs tomorrow ──────────────────────────────────────────────────
test('a birthday tomorrow is urgent; one in two weeks is a heads-up; one a month out is not on the plate', () => {
  const tomorrow = normalizeOccasionItem(occasionInDays('Alisa', 1), NOW);
  const twoWeeks = normalizeOccasionItem(occasionInDays('Ben', 14), NOW);
  const monthOut = normalizeOccasionItem(occasionInDays('Chris', 30), NOW);

  assert.equal(tomorrow.urgency ?? 'now', 'now');
  assert.ok(tomorrow.priority >= 80);
  assert.ok(twoWeeks.priority < 60, 'a birthday two weeks out should not compete with today\'s work');
  assert.equal(monthOut, null, 'a birthday a month out is noise in a daily digest');
  assert.match(tomorrow.detail, /Alisa's birthday is tomorrow/);
  assert.match(twoWeeks.followUp, /Find a gift for Ben/);
});

// ── Unchanged vs changed delivery ──────────────────────────────────────────────────────
test('a watch that checked and found nothing never reaches the digest; a real change does', () => {
  // An unchanged delivery watch produces NO briefing row at all (isScheduledRunNoteworthy
  // in api/index.js suppresses it), and its scheduled_tasks row is a condition poll, which
  // the reminder normalizer deliberately ignores.
  const unchanged = normalizeReminderItem(
    { id: 'w1', title: 'Track parcel', condition: 'the parcel status changes', recurrence: 'poll', next_run_at: hoursFromNow(-1) },
    NOW
  );
  assert.equal(unchanged, null);

  const changed = normalizeWatchUpdate({
    id: 'b1',
    title: 'Track parcel',
    body: 'Your parcel is now out for delivery.',
    metadata: { status: 'triggered', scheduledTaskId: 'w1' },
    created_at: hoursFromNow(-2)
  }, NOW);
  assert.equal(changed.kind, 'watch_update');
  assert.ok(changed.priority >= 80, 'an out-for-delivery transition is time-critical today');
  assert.equal(changed.ref.scheduledTaskId, 'w1');
});

test('a watch that could not read its source is reported, but does not top the digest', () => {
  const failed = normalizeWatchUpdate({
    id: 'b2',
    title: 'Track parcel',
    body: 'The carrier page could not be read (login wall).',
    metadata: { status: 'failed' },
    created_at: hoursFromNow(-1)
  }, NOW);
  assert.equal(failed.kind, 'watch_problem');
  assert.ok(failed.priority < 60);
});

// ── Calendar event soon ────────────────────────────────────────────────────────────────
test('an event starting soon ranks high; one two days out is not today\'s problem', () => {
  const digest = buildDailyDigest({
    now: NOW,
    calendarEvents: [
      { id: 'soon', summary: 'Interview', start: { dateTime: hoursFromNow(1) } },
      { id: 'far', summary: 'Dentist', start: { dateTime: hoursFromNow(40) } }
    ]
  });
  assert.equal(digest.items.length, 1);
  assert.equal(digest.items[0].title, 'Interview');
  assert.equal(digest.items[0].urgency, 'now');
});

// ── Overdue reminder ───────────────────────────────────────────────────────────────────
test('an overdue reminder outranks one merely due later today, and a future one is excluded', () => {
  const overdue = normalizeReminderItem({ id: 'a', title: 'Renew insurance', next_run_at: hoursFromNow(-26) }, NOW);
  const dueToday = normalizeReminderItem({ id: 'b', title: 'Call the vet', next_run_at: hoursFromNow(6) }, NOW);
  const nextWeek = normalizeReminderItem({ id: 'c', title: 'Book MOT', next_run_at: hoursFromNow(24 * 7) }, NOW);

  assert.ok(overdue.priority > dueToday.priority);
  assert.match(overdue.detail, /overdue/);
  assert.equal(nextWeek, null);
  assert.equal(dueToday.ref.scheduledTaskId, 'b');
});

test('the recurring digest task never lists itself', () => {
  const selfTask = normalizeReminderItem(
    { id: 'digest', title: 'Morning brief', instruction: `Call ${DIGEST_MARKER} and relay it`, next_run_at: hoursFromNow(-1) },
    NOW
  );
  assert.equal(selfTask, null);
});

// ── Resolved item disappears next run ──────────────────────────────────────────────────
test('an item that has been resolved is simply absent from the next run', () => {
  const before = buildDailyDigest({
    now: NOW,
    replyNeeded: [{ threadId: 't1', sender: 'Mia', whatTheyNeed: 'confirm a time', kind: 'reply', urgency: 'now', waitingSince: daysAgo(1) }],
    watchUpdates: [{ id: 'b1', title: 'Parcel', body: 'Out for delivery.', metadata: { status: 'triggered' }, created_at: hoursFromNow(-1) }]
  });
  assert.equal(before.items.length, 2);

  // Next morning: the user replied (the thread no longer judges as needing a response) and
  // opened the parcel update (the briefing is read, so it is not in the unread query).
  const after = buildDailyDigest({ now: NOW, replyNeeded: [], watchUpdates: [] });
  assert.equal(after.empty, true);
});

test('a watch update older than the freshness window stops being news', () => {
  const stale = normalizeWatchUpdate({
    id: 'b1', title: 'Parcel', body: 'Out for delivery.',
    metadata: { status: 'triggered' }, created_at: hoursFromNow(-72)
  }, NOW);
  assert.equal(stale, null);
});

// ── Focus filters ──────────────────────────────────────────────────────────────────────
test('"anything urgent?" and "what can wait?" filter the same computed digest', () => {
  const sources = {
    now: NOW,
    replyNeeded: [{ threadId: 't1', sender: 'Mia', whatTheyNeed: 'confirm a time', kind: 'reply', urgency: 'now', waitingSince: daysAgo(5) }],
    occasions: [occasionInDays('Alisa', 12)]
  };

  const urgent = buildDailyDigest({ ...sources, focus: 'urgent' });
  assert.equal(urgent.items.length, 1);
  assert.equal(urgent.items[0].kind, 'reply_needed');

  const canWait = buildDailyDigest({ ...sources, focus: 'can_wait' });
  assert.equal(canWait.items.length, 1);
  assert.equal(canWait.items[0].kind, 'occasion');

  const nothingUrgent = buildDailyDigest({ now: NOW, occasions: [occasionInDays('Alisa', 12)], focus: 'urgent' });
  assert.equal(nothingUrgent.empty, true);
  assert.match(nothingUrgent.text, /Nothing urgent/);
});

// ── Honest coverage ────────────────────────────────────────────────────────────────────
test('a source that could not be checked is admitted, not silently dropped', () => {
  const digest = buildDailyDigest({
    now: NOW,
    coverage: { email: { ok: false, reason: 'Gmail is not connected' } }
  });
  assert.match(digest.text, /could not check email \(Gmail is not connected\)/);
  assert.match(digest.text, /may be incomplete/);
});

test('an approval waiting on the user outranks everything else', () => {
  const digest = buildDailyDigest({
    now: NOW,
    approvals: [{ approvalId: 'ap1', taskId: 'task1', taskGoal: 'Send the deposit email', action: { type: 'send_email', input: { to: 'a@b.com' } } }],
    calendarEvents: [{ id: 'ev', summary: 'Interview', start: { dateTime: hoursFromNow(1) } }]
  });
  assert.equal(digest.items[0].kind, 'approval');
  assert.equal(digest.items[0].ref.approvalId, 'ap1');
});

test('one watch reporting nine times is one line, not nine', () => {
  // Real data: a single price watch had run nine times, and nine identical cards filled the
  // digest and pushed a genuine birthday off it entirely.
  const updates = Array.from({ length: 9 }, (_, i) => ({
    id: `b${i}`, title: 'Track Brighton hotel price drops',
    body: 'No reliable price drop was established.',
    metadata: { status: 'triggered', scheduledTaskId: 'w1' },
    created_at: hoursFromNow(-i - 1)
  }));
  const digest = buildDailyDigest({
    now: NOW,
    watchUpdates: updates,
    occasions: [occasionInDays('Alisa', 3)]
  });

  const watchItems = digest.items.filter(i => i.kind === 'watch_update');
  assert.equal(watchItems.length, 1);
  assert.match(watchItems[0].detail, /9 updates from this watch/);
  assert.ok(digest.items.some(i => i.kind === 'occasion'), 'the birthday must not be crowded out');
});

test('two genuinely different watches are still two lines', () => {
  const digest = buildDailyDigest({
    now: NOW,
    watchUpdates: [
      { id: 'b1', title: 'Parcel', body: 'Out for delivery.', metadata: { status: 'triggered', scheduledTaskId: 'w1' }, created_at: hoursFromNow(-1) },
      { id: 'b2', title: 'Hotel price', body: 'Now £86.', metadata: { status: 'triggered', scheduledTaskId: 'w2' }, created_at: hoursFromNow(-2) }
    ]
  });
  assert.equal(digest.items.filter(i => i.kind === 'watch_update').length, 2);
});

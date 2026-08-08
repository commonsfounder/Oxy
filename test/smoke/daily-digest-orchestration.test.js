// The daily_digest action against REAL Supabase tables (occasions, scheduled_tasks,
// briefings) and the real demo-test-user. The point of these tests is that every source is
// genuinely re-read on each call — that is the whole difference between a recurring morning
// brief and a stored summary replayed every day, and it cannot be proved with a mock.
//
// demo-test-user has no connectors, so the Gmail-backed source legitimately fails here; the
// honest-coverage assertion below depends on that and is a real property, not a workaround.

require('dotenv').config();

const assert = require('node:assert/strict');
const test = require('node:test');

const app = require('../../api/index');
const { createSupabaseServiceClient } = require('../../runtime');

const supabase = createSupabaseServiceClient();
const USER_ID = 'demo-test-user';
const TEST_PERSON = 'Test Digest Alisa';
const TEST_TASK_TITLE = 'Test Digest — renew car insurance';
const TEST_DIGEST_TASK_TITLE = 'Test Digest — morning brief';
const TEST_BRIEFING_TITLE = 'Test Digest — track parcel';

async function cleanup() {
  await supabase.from('occasions').delete().eq('user_id', USER_ID).eq('person_name', TEST_PERSON);
  await supabase.from('scheduled_tasks').delete().eq('user_id', USER_ID).in('title', [TEST_TASK_TITLE, TEST_DIGEST_TASK_TITLE]);
  await supabase.from('briefings').delete().eq('user_id', USER_ID).eq('title', TEST_BRIEFING_TITLE);
}

test.beforeEach(cleanup);
test.after(cleanup);

function inDays(n) {
  const date = new Date(Date.now() + n * 86400000);
  return { month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

test('the digest reads live occasion, reminder and watch-update rows from the real database', async () => {
  const soon = inDays(3);
  await supabase.from('occasions').insert({
    user_id: USER_ID, person_name: TEST_PERSON, occasion_type: 'birthday',
    month: soon.month, day: soon.day, relationship: 'friend', source: 'test'
  });
  await supabase.from('scheduled_tasks').insert({
    user_id: USER_ID, title: TEST_TASK_TITLE, instruction: 'Remind about insurance',
    recurrence: 'once', time_of_day: '09:00',
    next_run_at: new Date(Date.now() - 3 * 3600000).toISOString(), active: true
  });
  await supabase.from('briefings').insert({
    user_id: USER_ID, kind: 'scheduled_task', title: TEST_BRIEFING_TITLE,
    body: 'Your parcel is now out for delivery.', source: 'agent',
    metadata: { status: 'triggered' }, read: false, created_at: new Date().toISOString()
  });

  const result = await app.executeAction(USER_ID, 'daily_digest', {});
  assert.equal(result.success, true);

  // Matched by title, not by kind: demo-test-user is a shared account with other real rows
  // in these tables, and the digest correctly returns those too.
  const occasion = result.items.find(i => i.kind === 'occasion' && i.title.includes(TEST_PERSON));
  const reminder = result.items.find(i => i.title === TEST_TASK_TITLE);
  const watch = result.items.find(i => i.title === TEST_BRIEFING_TITLE);

  assert.ok(occasion, 'the real occasions row should surface');
  assert.match(occasion.detail, /Test Digest Alisa's birthday is in 3 days/);
  assert.ok(reminder, 'the real overdue scheduled_tasks row should surface');
  assert.match(reminder.detail, /overdue/);
  assert.ok(watch, 'the real unread triggered briefing should surface');
  assert.match(watch.detail, /out for delivery/);

  // The overdue reminder and the parcel both beat a birthday three days out.
  assert.ok(reminder.priority > occasion.priority);
  assert.ok(watch.priority > occasion.priority);
});

test('follow-up refs point at the real underlying rows, not at prose', async () => {
  const { data: task } = await supabase.from('scheduled_tasks').insert({
    user_id: USER_ID, title: TEST_TASK_TITLE, instruction: 'Remind about insurance',
    recurrence: 'once', time_of_day: '09:00',
    next_run_at: new Date(Date.now() - 3600000).toISOString(), active: true
  }).select('id').single();

  const result = await app.executeAction(USER_ID, 'daily_digest', {});
  const reminder = result.items.find(i => i.kind === 'reminder' && i.title === TEST_TASK_TITLE);
  assert.ok(reminder);
  assert.equal(reminder.ref.scheduledTaskId, task.id);

  // "Move that reminder" is then a real cancel against that same id.
  const cancelled = await app.executeAction(USER_ID, 'cancel_scheduled_task', { id: task.id });
  assert.equal(cancelled.success, true);

  const after = await app.executeAction(USER_ID, 'daily_digest', {});
  assert.equal(after.items.some(i => i.ref?.scheduledTaskId === task.id), false,
    'a cancelled reminder must be gone from the very next digest');
});

test('a watch update the user has already seen drops out of the next digest', async () => {
  const { data: briefing } = await supabase.from('briefings').insert({
    user_id: USER_ID, kind: 'scheduled_task', title: TEST_BRIEFING_TITLE,
    body: 'Your parcel is now out for delivery.', source: 'agent',
    metadata: { status: 'triggered' }, read: false, created_at: new Date().toISOString()
  }).select('id').single();

  const before = await app.executeAction(USER_ID, 'daily_digest', {});
  assert.ok(before.items.some(i => i.ref?.briefingId === briefing.id));

  await supabase.from('briefings').update({ read: true, read_at: new Date().toISOString() }).eq('id', briefing.id);

  const after = await app.executeAction(USER_ID, 'daily_digest', {});
  assert.equal(after.items.some(i => i.ref?.briefingId === briefing.id), false);
});

test('the recurring morning-brief task does not list itself as work', async () => {
  await supabase.from('scheduled_tasks').insert({
    user_id: USER_ID, title: TEST_DIGEST_TASK_TITLE,
    instruction: 'Call daily_digest and relay the result to the user.',
    recurrence: 'daily', time_of_day: '07:30',
    next_run_at: new Date(Date.now() - 600000).toISOString(), active: true
  });

  const result = await app.executeAction(USER_ID, 'daily_digest', {});
  assert.equal(result.items.some(i => i.title === TEST_DIGEST_TASK_TITLE), false);
});

test('a source that genuinely could not be checked is reported honestly', async () => {
  // demo-test-user has no Gmail connection, so the reply-needed source really does fail.
  const result = await app.executeAction(USER_ID, 'daily_digest', {});
  assert.equal(result.success, true);
  assert.equal(result.coverage.email.ok, false);
  assert.ok(result.coverage.email.reason, 'a failed source must carry a real reason');
  assert.match(result.text, /could not check email/);
});

test('focus:"urgent" and focus:"can_wait" split the same live digest', async () => {
  const soon = inDays(12);
  await supabase.from('occasions').insert({
    user_id: USER_ID, person_name: TEST_PERSON, occasion_type: 'birthday',
    month: soon.month, day: soon.day, source: 'test'
  });
  await supabase.from('scheduled_tasks').insert({
    user_id: USER_ID, title: TEST_TASK_TITLE, instruction: 'Remind about insurance',
    recurrence: 'once', time_of_day: '09:00',
    next_run_at: new Date(Date.now() - 3 * 3600000).toISOString(), active: true
  });

  const urgent = await app.executeAction(USER_ID, 'daily_digest', { focus: 'urgent' });
  assert.ok(urgent.items.every(i => i.urgency === 'now'));
  assert.ok(urgent.items.some(i => i.title === TEST_TASK_TITLE));

  const canWait = await app.executeAction(USER_ID, 'daily_digest', { focus: 'can_wait' });
  assert.ok(canWait.items.every(i => i.urgency === 'soon'));
  assert.ok(canWait.items.some(i => i.kind === 'occasion'));
});

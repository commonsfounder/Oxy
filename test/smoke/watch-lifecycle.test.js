// Watch lifecycle against the REAL scheduled_tasks table and the real actions: creation,
// observation recording, notify/don't-notify verdicts, editing, duplicate avoidance and
// cancellation. The evaluator itself is unit-tested in watches.test.js; what is proved here
// is that it is genuinely driven by durable rows, not by in-memory state.

require('dotenv').config();

const assert = require('node:assert/strict');
const test = require('node:test');

const app = require('../../api/index');
const { createSupabaseServiceClient } = require('../../runtime');

const supabase = createSupabaseServiceClient();
const USER_ID = 'demo-test-user';
const PREFIX = 'WatchTest';

async function cleanup() {
  await supabase.from('scheduled_tasks').delete().eq('user_id', USER_ID).like('title', `${PREFIX}%`);
}

test.beforeEach(cleanup);
test.after(cleanup);

async function createWatch(overrides = {}) {
  const result = await app.executeAction(USER_ID, 'create_scheduled_task', {
    title: `${PREFIX} hotel price`,
    instruction: 'Check the room price',
    condition: 'the price drops below 90',
    interval_minutes: 1440,
    watch_type: 'threshold',
    threshold: 90,
    source_url: 'https://example.com/watchtest-room',
    ...overrides
  });
  assert.equal(result.success, true, result.error);
  return result;
}

async function stateOf(id) {
  const { data } = await supabase.from('scheduled_tasks').select('watch_state, recurrence, interval_minutes, next_run_at, condition, active').eq('id', id).single();
  return data;
}

// ── Creation carries real config ───────────────────────────────────────────────────────
test('a threshold watch stores what it will actually compare against', async () => {
  const created = await createWatch();
  const state = await stateOf(created.scheduledTask.id);
  assert.equal(state.watch_state.type, 'threshold');
  assert.equal(state.watch_state.threshold, 90);
  assert.equal(state.watch_state.comparator, 'below');
  assert.equal(state.watch_state.notifyRule, 'once');
  assert.equal(state.watch_state.sourceUrl, 'https://example.com/watchtest-room');
  assert.equal(state.recurrence, 'poll', 'a condition watch is a poll on the existing scheduler, not a new one');
});

// ── The observation loop, through the real action ──────────────────────────────────────
test('a price above the threshold records an observation and does not notify', async () => {
  const created = await createWatch();
  const recorded = await app.executeAction(USER_ID, 'record_watch_observation', {
    watch_id: created.scheduledTask.id, value: 104
  });
  assert.equal(recorded.success, true);
  assert.equal(recorded.notify, false);
  assert.match(recorded.text, /Do not notify the user this cycle/);

  const state = await stateOf(created.scheduledTask.id);
  assert.equal(state.watch_state.lastObserved.value, 104);
  assert.equal(state.watch_state.lastEvaluation.notify, false);
});

test('crossing the threshold notifies once and then stays quiet, across real rows', async () => {
  const created = await createWatch();
  await app.executeAction(USER_ID, 'record_watch_observation', { watch_id: created.scheduledTask.id, value: 104 });

  const crossed = await app.executeAction(USER_ID, 'record_watch_observation', { watch_id: created.scheduledTask.id, value: 86 });
  assert.equal(crossed.notify, true);
  assert.equal(crossed.terminal, true);
  assert.match(crossed.text, /This IS news/);

  // A fresh call re-reads the row, so the "already reported" memory is durable, not in-process.
  const again = await app.executeAction(USER_ID, 'record_watch_observation', { watch_id: created.scheduledTask.id, value: 84 });
  assert.equal(again.notify, false);
  assert.equal(again.kind, 'still_met');
});

test('a stock watch is silent on its baseline and on an unchanged check, and fires on the real change', async () => {
  const created = await createWatch({
    title: `${PREFIX} stock`, condition: 'it comes back in stock',
    watch_type: 'state_change', threshold: undefined, target_state: 'in stock',
    source_url: 'https://example.com/watchtest-product'
  });
  const id = created.scheduledTask.id;

  const baseline = await app.executeAction(USER_ID, 'record_watch_observation', { watch_id: id, state: 'Out of stock' });
  assert.equal(baseline.notify, false);
  assert.equal(baseline.kind, 'baseline');

  const unchanged = await app.executeAction(USER_ID, 'record_watch_observation', { watch_id: id, state: 'out of stock' });
  assert.equal(unchanged.notify, false);
  assert.equal(unchanged.kind, 'unchanged');

  const back = await app.executeAction(USER_ID, 'record_watch_observation', { watch_id: id, state: 'In stock' });
  assert.equal(back.notify, true);
  assert.equal(back.terminal, true, 'a one-shot target state ends the watch');
});

test('an inaccessible source is recorded as a failure, not as "nothing changed"', async () => {
  const created = await createWatch({ title: `${PREFIX} page`, watch_type: 'state_change', threshold: undefined });
  const id = created.scheduledTask.id;
  await app.executeAction(USER_ID, 'record_watch_observation', { watch_id: id, state: 'Applications closed' });

  const blocked = await app.executeAction(USER_ID, 'record_watch_observation', {
    watch_id: id, accessible: false, error: 'the page is behind a login now'
  });
  assert.equal(blocked.notify, true);
  assert.equal(blocked.kind, 'blocked');

  // And the watch says so when asked what is running.
  const listed = await app.executeAction(USER_ID, 'list_scheduled_tasks', {});
  const mine = listed.scheduledTasks.find(t => t.id === id);
  assert.match(mine.watch.lastCheckFailed, /behind a login/);
  assert.match(listed.text, /last check failed/);
});

// ── "What are you watching for me?" ────────────────────────────────────────────────────
test('the watch list reports what it inspects and what it last saw', async () => {
  const created = await createWatch();
  await app.executeAction(USER_ID, 'record_watch_observation', { watch_id: created.scheduledTask.id, value: 104 });

  const listed = await app.executeAction(USER_ID, 'list_scheduled_tasks', {});
  const mine = listed.scheduledTasks.find(t => t.id === created.scheduledTask.id);
  assert.equal(mine.watch.threshold, 90);
  assert.equal(mine.watch.lastObserved.value, 104);
  assert.match(listed.text, /until it goes below 90/);
  assert.match(listed.text, /last seen: 104/);
});

// ── Editing ────────────────────────────────────────────────────────────────────────────
test('"only notify me if it goes below 450" changes the threshold and keeps the history', async () => {
  const created = await createWatch();
  await app.executeAction(USER_ID, 'record_watch_observation', { watch_id: created.scheduledTask.id, value: 104 });

  const updated = await app.executeAction(USER_ID, 'update_scheduled_task', {
    title: `${PREFIX} hotel price`, threshold: 450
  });
  assert.equal(updated.success, true);

  const state = await stateOf(created.scheduledTask.id);
  assert.equal(state.watch_state.threshold, 450);
  assert.equal(state.watch_state.lastObserved.value, 104, 'the observation history must survive an edit');
  assert.equal(state.watch_state.history.length, 1);
});

test('"change that to weekly" reschedules without recreating the watch', async () => {
  const created = await createWatch();
  const before = await stateOf(created.scheduledTask.id);

  const updated = await app.executeAction(USER_ID, 'update_scheduled_task', {
    title: `${PREFIX} hotel price`, interval_minutes: 10080
  });
  assert.equal(updated.success, true);
  assert.equal(updated.scheduledTask.id, created.scheduledTask.id, 'the same watch, not a new one');

  const after = await stateOf(created.scheduledTask.id);
  assert.equal(after.interval_minutes, 10080);
  assert.notEqual(after.next_run_at, before.next_run_at);
});

test('a new threshold re-arms notification even if the old one had already fired', async () => {
  const created = await createWatch();
  await app.executeAction(USER_ID, 'record_watch_observation', { watch_id: created.scheduledTask.id, value: 86 });
  await app.executeAction(USER_ID, 'update_scheduled_task', { title: `${PREFIX} hotel price`, threshold: 100 });

  const recorded = await app.executeAction(USER_ID, 'record_watch_observation', { watch_id: created.scheduledTask.id, value: 95 });
  assert.equal(recorded.notify, true, 'the new question deserves its own first answer');
});

test('an edit to a watch that does not exist says so rather than creating one', async () => {
  const result = await app.executeAction(USER_ID, 'update_scheduled_task', { title: `${PREFIX} nothing like this`, threshold: 10 });
  assert.equal(result.success, false);
  assert.match(result.error, /could not find that watch/);
});

// ── Duplicate avoidance and cancellation ───────────────────────────────────────────────
test('asking for the same watch twice adjusts the first instead of running two', async () => {
  const first = await createWatch();
  await app.executeAction(USER_ID, 'record_watch_observation', { watch_id: first.scheduledTask.id, value: 104 });

  const second = await app.executeAction(USER_ID, 'create_scheduled_task', {
    title: `${PREFIX} hotel price drops`,
    instruction: 'Keep an eye on the room price',
    condition: 'the price drops below 90',
    interval_minutes: 1440,
    threshold: 90,
    source_url: 'https://example.com/watchtest-room'
  });
  assert.equal(second.deduped, true);
  assert.equal(second.scheduledTask.id, first.scheduledTask.id);
  assert.match(second.text, /already watching/i);

  const { data } = await supabase.from('scheduled_tasks').select('id').eq('user_id', USER_ID).like('title', `${PREFIX}%`).eq('active', true);
  assert.equal(data.length, 1);

  const state = await stateOf(first.scheduledTask.id);
  assert.equal(state.watch_state.lastObserved.value, 104, 'the existing baseline must not be wiped by re-asking');
});

test('a genuinely different watch is still created separately', async () => {
  await createWatch();
  const other = await app.executeAction(USER_ID, 'create_scheduled_task', {
    title: `${PREFIX} PS5 stock`,
    instruction: 'Check whether the PS5 is available',
    condition: 'it comes back in stock',
    watch_type: 'state_change',
    source_url: 'https://example.com/watchtest-ps5'
  });
  assert.notEqual(other.deduped, true);
  const { data } = await supabase.from('scheduled_tasks').select('id').eq('user_id', USER_ID).like('title', `${PREFIX}%`).eq('active', true);
  assert.equal(data.length, 2);
});

test('"stop checking that" really deactivates the watch', async () => {
  const created = await createWatch();
  const cancelled = await app.executeAction(USER_ID, 'cancel_scheduled_task', { title: `${PREFIX} hotel price` });
  assert.equal(cancelled.success, true);

  const state = await stateOf(created.scheduledTask.id);
  assert.equal(state.active, false);

  const listed = await app.executeAction(USER_ID, 'list_scheduled_tasks', {});
  assert.equal(listed.scheduledTasks.some(t => t.id === created.scheduledTask.id), false);
});

test('a recurring reassessment is always news, and never terminates itself', async () => {
  const created = await createWatch({
    title: `${PREFIX} reply sweep`, condition: 'there are threads still needing a reply',
    watch_type: 'recurring_check', threshold: undefined, source_url: undefined
  });
  const first = await app.executeAction(USER_ID, 'record_watch_observation', {
    watch_id: created.scheduledTask.id, state: '3 threads still need a reply'
  });
  assert.equal(first.notify, true);
  assert.equal(first.terminal, false);

  const second = await app.executeAction(USER_ID, 'record_watch_observation', {
    watch_id: created.scheduledTask.id, state: '3 threads still need a reply'
  });
  assert.equal(second.notify, true, 'the same answer is still this week\'s answer');
});

// ── Regressions found in live agentic testing ──────────────────────────────────────────
test('a watch stated without a separate condition sentence still polls, rather than firing once', async () => {
  // Live: "keep an eye on <url> and tell me if the price drops below £90" produced a
  // one-shot task with recurrence 'once' and no condition — it would have fired at 09:00
  // the next morning and never checked again.
  const created = await app.executeAction(USER_ID, 'create_scheduled_task', {
    title: `${PREFIX} no-condition`,
    instruction: 'Check the room price',
    threshold: 90,
    source_url: 'https://example.com/watchtest-nocondition'
  });
  assert.equal(created.success, true);

  const state = await stateOf(created.scheduledTask.id);
  assert.equal(state.recurrence, 'poll', 'a watch must poll, not fire once');
  assert.ok(state.condition, 'a condition is synthesized so the run instruction can carry the watch protocol');
  assert.match(state.condition, /below 90/);
  assert.equal(state.watch_state.threshold, 90);
});

test('"check it weekly" on such a watch actually changes the cadence, not just the reply', async () => {
  // Live: the cadence update reported success while leaving recurrence 'once' and
  // interval_minutes null — a fake success.
  const created = await app.executeAction(USER_ID, 'create_scheduled_task', {
    title: `${PREFIX} cadence`,
    instruction: 'Check the room price',
    threshold: 90,
    source_url: 'https://example.com/watchtest-cadence'
  });
  const updated = await app.executeAction(USER_ID, 'update_scheduled_task', {
    title: `${PREFIX} cadence`, interval_minutes: 10080
  });
  assert.equal(updated.success, true);

  const state = await stateOf(created.scheduledTask.id);
  assert.equal(state.recurrence, 'poll');
  assert.equal(state.interval_minutes, 10080);
});

test('a recurring reassessment keeps its stated cadence instead of becoming a poll', async () => {
  const created = await app.executeAction(USER_ID, 'create_scheduled_task', {
    title: `${PREFIX} friday sweep`,
    instruction: 'Tell me who I still owe a reply to',
    recurrence: 'weekly',
    day_of_week: 'Friday',
    time: '09:00',
    watch_type: 'recurring_check'
  });
  assert.equal(created.success, true);
  const state = await stateOf(created.scheduledTask.id);
  assert.equal(state.recurrence, 'weekly', '"every Friday" is a cadence, not a poll-until-something-happens');
  assert.equal(state.watch_state.type, 'recurring_check');
});

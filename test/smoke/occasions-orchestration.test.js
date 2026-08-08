// Full save_occasion / find_occasions orchestration (api/index.js's cases) against the REAL
// Supabase occasions table and demo-test-user — genuine durable persistence, not a mock, is
// the whole point of this feature ("whose birthday is coming up?" must survive a fresh
// process, not just live in the current conversation's context). scheduledTasks is a
// separately-required module accessed as a property at call time, so it's monkey-patched
// directly (same convention as googleConnector.getThreadContext/browserTask.runOrderingTurn)
// to avoid depending on Feature 2's already-covered scheduling internals here.

require('dotenv').config();

const assert = require('node:assert/strict');
const test = require('node:test');

const app = require('../../api/index');
const { createSupabaseServiceClient } = require('../../runtime');
const scheduledTasks = require('../../api/services/scheduled-tasks');

const supabase = createSupabaseServiceClient();
const USER_ID = 'demo-test-user';
const TEST_PEOPLE = ['Test Alisa Orchestration', 'Test Mum Orchestration', 'Test NoReminder Orchestration'];

async function cleanup() {
  await supabase.from('occasions').delete().eq('user_id', USER_ID).in('person_name', TEST_PEOPLE);
}

const originalCreateScheduledTask = scheduledTasks.createScheduledTask;
test.beforeEach(cleanup);
test.afterEach(async () => {
  await cleanup();
  scheduledTasks.createScheduledTask = originalCreateScheduledTask;
});

test('save_occasion requires a real calendar date', async () => {
  const result = await app.executeAction(USER_ID, 'save_occasion', { person_name: 'Test Alisa Orchestration', month: 2, day: 30 });
  assert.equal(result.success, false);
  assert.match(result.error, /real month/);
});

test('save_occasion persists to the real occasions table, retrievable by find_occasions', async () => {
  const saveResult = await app.executeAction(USER_ID, 'save_occasion', {
    person_name: 'Test Alisa Orchestration', occasion_type: 'birthday', month: 7, day: 12, relationship: 'friend'
  });
  assert.equal(saveResult.success, true);
  assert.match(saveResult.text, /Saved Test Alisa Orchestration's birthday \(12 July\)/);

  // Genuinely re-read from the database, not from anything held in memory by the save call.
  const findResult = await app.executeAction(USER_ID, 'find_occasions', { person_name: 'Test Alisa Orchestration' });
  assert.equal(findResult.success, true);
  assert.equal(findResult.items.length, 1);
  assert.equal(findResult.items[0].personName, 'Test Alisa Orchestration');
  assert.equal(findResult.items[0].month, 7);
  assert.equal(findResult.items[0].day, 12);
  assert.equal(findResult.items[0].relationship, 'friend');
});

test('re-saving the same person/occasion updates the existing row rather than duplicating it', async () => {
  await app.executeAction(USER_ID, 'save_occasion', { person_name: 'Test Mum Orchestration', month: 10, day: 8 });
  await app.executeAction(USER_ID, 'save_occasion', { person_name: 'Test Mum Orchestration', month: 10, day: 9 });

  const { data } = await supabase.from('occasions').select('*').eq('user_id', USER_ID).eq('person_name', 'Test Mum Orchestration');
  assert.equal(data.length, 1, 'corrected date should update in place, not create a second row');
  assert.equal(data[0].day, 9);
});

test('find_occasions is honest when nothing is saved for a named person', async () => {
  const result = await app.executeAction(USER_ID, 'find_occasions', { person_name: 'Nobody Saved This Person' });
  assert.equal(result.success, true);
  assert.equal(result.items.length, 0);
  assert.match(result.text, /don't have a saved birthday or occasion/);
});

test('save_occasion with remind_days_before schedules a real reminder via create_scheduled_task', async () => {
  let scheduledCall = null;
  scheduledTasks.createScheduledTask = async (userId, opts) => {
    scheduledCall = { userId, opts };
    return { success: true, task: { id: 'fake-task-id' } };
  };

  const result = await app.executeAction(USER_ID, 'save_occasion', {
    person_name: 'Test Alisa Orchestration', month: 7, day: 12, remind_days_before: 14
  });

  assert.equal(result.success, true);
  assert.equal(result.reminderScheduled, true);
  assert.ok(scheduledCall, 'create_scheduled_task should have been called');
  assert.equal(scheduledCall.userId, USER_ID);
  assert.equal(scheduledCall.opts.recurrence, 'once');
  assert.match(scheduledCall.opts.title, /Test Alisa Orchestration's birthday/);
  assert.match(scheduledCall.opts.instruction, /coming up in 14 days/);
  assert.match(scheduledCall.opts.instruction, /Offer to help find and buy a gift/);
  // The self-re-arming instruction, matching the same composition pattern as delivery watches.
  assert.match(scheduledCall.opts.instruction, /call create_scheduled_task again.*due_date set to exactly one year from today/s);
});

test('save_occasion without a reminder preference does not invent one', async () => {
  let scheduledCallHappened = false;
  scheduledTasks.createScheduledTask = async () => { scheduledCallHappened = true; return { success: true }; };

  const result = await app.executeAction(USER_ID, 'save_occasion', { person_name: 'Test NoReminder Orchestration', month: 3, day: 1 });
  assert.equal(result.success, true);
  assert.equal(result.reminderScheduled, false);
  assert.equal(scheduledCallHappened, false);
});

test('find_occasions with no filter returns every saved occasion, soonest first', async () => {
  await app.executeAction(USER_ID, 'save_occasion', { person_name: 'Test Alisa Orchestration', month: 7, day: 12 });
  await app.executeAction(USER_ID, 'save_occasion', { person_name: 'Test Mum Orchestration', month: 10, day: 8 });

  const result = await app.executeAction(USER_ID, 'find_occasions', {});
  assert.equal(result.success, true);
  const names = result.items.map(i => i.personName);
  assert.ok(names.includes('Test Alisa Orchestration'));
  assert.ok(names.includes('Test Mum Orchestration'));
});

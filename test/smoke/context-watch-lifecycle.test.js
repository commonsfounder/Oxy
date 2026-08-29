'use strict';

require('dotenv').config();

const assert = require('node:assert/strict');
const test = require('node:test');

const app = require('../../api/index');
const scheduledTasks = require('../../api/services/scheduled-tasks');
const { createSupabaseServiceClient } = require('../../runtime');

const supabase = createSupabaseServiceClient();
const USER_ID = 'demo-test-user';
const PREFIX = 'ContextWatchTest';
const HOME = { latitude: 51.5007, longitude: -0.1246 };
const AWAY = { latitude: 51.5207, longitude: -0.1246 };

function healthContext(restingHeartRate, at) {
  const recordedAt = at.toISOString();
  return {
    health: { restingHeartRate, restingHeartRateRecordedAt: recordedAt, capturedAt: recordedAt },
    capabilities: { healthKit: true },
    updated_at: recordedAt
  };
}

async function cleanup() {
  await supabase.from('scheduled_tasks').delete().eq('user_id', USER_ID).like('title', `${PREFIX}%`);
}

test.beforeEach(cleanup);
test.after(cleanup);

test('a durable reminder records its baseline and completes on one real arrival', async () => {
  const created = await app.executeAction(USER_ID, 'create_scheduled_task', {
    title: `${PREFIX} parcel`,
    instruction: 'Take the parcel with you tomorrow.',
    context_event: 'arrive_home'
  }, {
    userMessage: 'Remind me to take the parcel when I get home.',
    location: AWAY,
    homeLocation: HOME
  });
  assert.equal(created.success, true, created.error);
  assert.match(created.text, /when you arrive home/);

  const { data: before } = await supabase.from('scheduled_tasks')
    .select('active, completed, watch_state')
    .eq('id', created.scheduledTask.id)
    .single();
  assert.equal(before.active, true);
  assert.equal(before.watch_state.type, 'context');
  assert.equal(before.watch_state.context.event, 'arrive_home');
  assert.equal(before.watch_state.context.lastInside, false);

  const arrivedAt = new Date();
  const evaluated = await scheduledTasks.evaluateContextWatches(USER_ID, {
    location: HOME,
    settings: { locationReminders: true, homeLocation: HOME },
    updated_at: arrivedAt.toISOString()
  }, arrivedAt);
  assert.equal(evaluated.success, true, evaluated.error);
  assert.equal(evaluated.events.length, 1);
  assert.equal(evaluated.events[0].verdict.reason, 'arrived home');

  const { data: after } = await supabase.from('scheduled_tasks')
    .select('active, completed, watch_state')
    .eq('id', created.scheduledTask.id)
    .single();
  assert.equal(after.active, false);
  assert.equal(after.completed, true);
  assert.equal(after.watch_state.context.transitionCount, 1);

  const repeated = await scheduledTasks.evaluateContextWatches(USER_ID, {
    location: HOME,
    settings: { locationReminders: true, homeLocation: HOME },
    updated_at: arrivedAt.toISOString()
  }, arrivedAt);
  assert.equal(repeated.events.length, 0, 'a completed one-shot reminder cannot fire twice');
});

test('the action boundary refuses location monitoring without current-message consent', async () => {
  const title = `${PREFIX} rejected location inference`;
  const rejected = await app.executeAction(USER_ID, 'create_scheduled_task', {
    title,
    instruction: 'You are home.',
    context_event: 'arrive_home'
  }, {
    userMessage: 'Am I home right now?',
    location: AWAY,
    homeLocation: HOME
  });
  assert.equal(rejected.success, false);
  assert.match(rejected.error, /explicitly request/);

  const { count } = await supabase.from('scheduled_tasks')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', USER_ID)
    .eq('title', title);
  assert.equal(count, 0, 'rejected monitoring cannot leave a durable row behind');
});

test('a due contextual watch never enters the model-run scheduled queue', async () => {
  const contextual = await app.executeAction(USER_ID, 'create_scheduled_task', {
    title: `${PREFIX} deterministic boundary`,
    instruction: 'Take the parcel inside.',
    context_event: 'arrive_home'
  }, {
    userMessage: 'Remind me to take the parcel when I get home.',
    location: AWAY,
    homeLocation: HOME
  });
  assert.equal(contextual.success, true, contextual.error);

  const ordinary = await app.executeAction(USER_ID, 'create_scheduled_task', {
    title: `${PREFIX} ordinary reminder`,
    instruction: 'Check the boiler pressure.'
  });
  assert.equal(ordinary.success, true, ordinary.error);

  const dueAt = new Date(Date.now() - 60_000).toISOString();
  const { error } = await supabase.from('scheduled_tasks')
    .update({ next_run_at: dueAt })
    .in('id', [contextual.scheduledTask.id, ordinary.scheduledTask.id]);
  assert.equal(error, null);

  const due = await scheduledTasks.getDueScheduledTasks(USER_ID, new Date());
  const ids = due.map(task => task.id);
  assert.equal(ids.includes(contextual.scheduledTask.id), false, 'physical context cannot be delegated to the model');
  assert.equal(ids.includes(ordinary.scheduledTask.id), true, 'ordinary scheduled work still uses the general agent loop');
});

test('an explicit health watch persists a baseline and closes on a measured crossing', async () => {
  const created = await app.executeAction(USER_ID, 'create_scheduled_task', {
    title: `${PREFIX} resting heart rate`,
    instruction: 'Your resting heart rate crossed the threshold you set.',
    context_metric: 'resting_heart_rate',
    threshold: 45,
    comparator: 'below'
  }, { userMessage: 'Tell me if my resting heart rate drops below 45 bpm.' });
  assert.equal(created.success, true, created.error);
  assert.match(created.text, /when your resting heart rate goes below 45 bpm/);

  const { data: before } = await supabase.from('scheduled_tasks')
    .select('active, completed, watch_state')
    .eq('id', created.scheduledTask.id)
    .single();
  assert.equal(before.watch_state.type, 'context');
  assert.equal(before.watch_state.context.metric, 'resting_heart_rate');
  assert.equal(before.watch_state.context.lastMet, null);

  const baselineAt = new Date();
  const baseline = await scheduledTasks.evaluateContextWatches(USER_ID, healthContext(52, baselineAt), baselineAt);
  assert.equal(baseline.success, true, baseline.error);
  assert.equal(baseline.events.length, 0);

  const crossedAt = new Date(baselineAt.getTime() + 60_000);
  const crossed = await scheduledTasks.evaluateContextWatches(USER_ID, healthContext(44, crossedAt), crossedAt);
  assert.equal(crossed.success, true, crossed.error);
  assert.equal(crossed.events.length, 1);
  assert.match(crossed.events[0].verdict.reason, /went below 45 bpm/);

  const { data: after } = await supabase.from('scheduled_tasks')
    .select('active, completed, watch_state')
    .eq('id', created.scheduledTask.id)
    .single();
  assert.equal(after.active, false);
  assert.equal(after.completed, true);
  assert.equal(after.watch_state.context.transitionCount, 1);
});

test('changing a health threshold re-arms the same watch with a fresh baseline', async () => {
  const created = await app.executeAction(USER_ID, 'create_scheduled_task', {
    title: `${PREFIX} editable health threshold`,
    instruction: 'Your resting heart rate crossed the threshold you set.',
    context_metric: 'resting_heart_rate',
    threshold: 45,
    comparator: 'below'
  }, { userMessage: 'Tell me if my resting heart rate drops below 45 bpm.' });
  assert.equal(created.success, true, created.error);

  const firstAt = new Date();
  await scheduledTasks.evaluateContextWatches(USER_ID, healthContext(52, firstAt), firstAt);

  const updated = await scheduledTasks.updateScheduledTask(USER_ID, {
    id: created.scheduledTask.id,
    threshold: 40
  });
  assert.equal(updated.success, true, updated.error);
  assert.equal(updated.task.watch_state.type, 'context');
  assert.equal(updated.task.watch_state.context.threshold, 40);
  assert.equal(updated.task.watch_state.context.lastMet, null);
  assert.match(updated.task.condition, /below 40 bpm/);

  const newBaselineAt = new Date(firstAt.getTime() + 60_000);
  const newBaseline = await scheduledTasks.evaluateContextWatches(USER_ID, healthContext(44, newBaselineAt), newBaselineAt);
  assert.equal(newBaseline.events.length, 0, 'the first observation against a changed threshold is a baseline');

  const crossedAt = new Date(firstAt.getTime() + 120_000);
  const crossed = await scheduledTasks.evaluateContextWatches(USER_ID, healthContext(39, crossedAt), crossedAt);
  assert.equal(crossed.events.length, 1);
  assert.match(crossed.events[0].verdict.reason, /went below 40 bpm/);
});

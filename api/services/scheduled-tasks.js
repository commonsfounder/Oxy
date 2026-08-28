const { createSupabaseServiceClient } = require('../../runtime');
const watches = require('./watches');

const TIMEZONE = process.env.TIMEZONE || 'Europe/London';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let supabaseClient = null;
function getSupabase() {
  if (!supabaseClient) supabaseClient = createSupabaseServiceClient();
  return supabaseClient;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Minutes such that localTime = utcTime + offset, for the given instant/timezone.
function getTimezoneOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return (asUTC - date.getTime()) / 60000;
}

// Converts a wall-clock HH:MM on the given YYYY-MM-DD date (in `timeZone`) to a UTC Date.
function localTimeToUtc(dateKey, hh, mm, timeZone = TIMEZONE) {
  const naive = new Date(`${dateKey}T${pad2(hh)}:${pad2(mm)}:00.000Z`);
  const offsetMinutes = getTimezoneOffsetMinutes(naive, timeZone);
  return new Date(naive.getTime() - offsetMinutes * 60000);
}

function dateKeyInTimezone(date, timeZone = TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

function addDaysToDateKey(dateKey, days) {
  const noon = new Date(`${dateKey}T12:00:00.000Z`);
  noon.setUTCDate(noon.getUTCDate() + days);
  return dateKeyInTimezone(noon, 'UTC');
}

function weekdayIndexInTimezone(date, timeZone = TIMEZONE) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(date);
  return WEEKDAYS.indexOf(name);
}

function parseTimeOfDay(time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim());
  if (!match) return { hh: 9, mm: 0 };
  const hh = Math.min(23, Math.max(0, Number(match[1])));
  const mm = Math.min(59, Math.max(0, Number(match[2])));
  return { hh, mm };
}

function normalizeDayOfWeek(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6) return value;
  const text = String(value).trim().toLowerCase();
  const index = WEEKDAYS.findIndex(day => day.toLowerCase() === text || day.toLowerCase().startsWith(text.slice(0, 3)));
  return index >= 0 ? index : null;
}

function normalizeDateKey(value) {
  if (!value) return null;
  const text = String(value).trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match ? match[1] : null;
}

// Computes the next UTC run time for a task's recurrence/time/day-of-week, relative to `now`.
function computeNextRun(now, { recurrence = 'once', time_of_day, day_of_week, date } = {}) {
  const { hh, mm } = parseTimeOfDay(time_of_day);

  if (recurrence === 'weekly') {
    const target = normalizeDayOfWeek(day_of_week);
    const todayKey = dateKeyInTimezone(now, TIMEZONE);
    const todayWeekday = weekdayIndexInTimezone(now, TIMEZONE);
    if (target === null || target === todayWeekday) {
      const candidate = localTimeToUtc(todayKey, hh, mm);
      if (candidate.getTime() > now.getTime()) return candidate;
      const nextWeekKey = addDaysToDateKey(todayKey, target === null ? 1 : 7);
      return localTimeToUtc(nextWeekKey, hh, mm);
    }
    const daysToAdd = (target - todayWeekday + 7) % 7;
    return localTimeToUtc(addDaysToDateKey(todayKey, daysToAdd), hh, mm);
  }

  const explicitDateKey = normalizeDateKey(date);
  if (explicitDateKey) {
    return localTimeToUtc(explicitDateKey, hh, mm);
  }

  const todayKey = dateKeyInTimezone(now, TIMEZONE);
  const candidate = localTimeToUtc(todayKey, hh, mm);
  if (candidate.getTime() > now.getTime()) return candidate;
  return localTimeToUtc(addDaysToDateKey(todayKey, 1), hh, mm);
}

function describeSchedule(task) {
  const time = task.time_of_day || '09:00';
  if (task.recurrence === 'poll') {
    const mins = task.interval_minutes || 30;
    return task.condition ? `until ${task.condition}` : `every ${mins} minutes`;
  }
  if (task.recurrence === 'daily') return `every day at ${time}`;
  if (task.recurrence === 'weekly') {
    const day = WEEKDAYS[task.day_of_week] || 'the same day each week';
    return `every ${day} at ${time}`;
  }
  return `on ${new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(task.next_run_at))}`;
}

function buildScheduledRunInstruction(task) {
  const instruction = String(task?.instruction || task?.title || '').trim();
  if (!task?.condition) return instruction;
  const config = task.watch_state || {};
  const source = config.sourceUrl ? ` The source to inspect is ${config.sourceUrl}.` : '';
  const last = config.lastObserved
    ? ` Last time you observed: ${JSON.stringify(config.lastObserved.value ?? config.lastObserved.state).slice(0, 160)}.`
    : ' Nothing has been observed for this watch yet, so this run establishes the baseline.';
  // The observation call is what makes the verdict deterministic. Whether the user is
  // notified is decided from the recorded value by watches.evaluateObservation, NOT from
  // the marker below — a model can assert [WATCH_TRIGGERED], it cannot make a number be
  // below a threshold once the number is written down.
  return `${instruction}

This is a background watch. Check the condition: "${String(task.condition).slice(0, 240)}".${source}${last}

Inspect the REAL source this run — never answer from memory of a previous check, and never assume nothing changed. Then call record_watch_observation with watch_id "${task.id}" and the value you actually observed (a price as a plain number, a stock/availability state as a short phrase, otherwise a short description of the current state). If you could NOT read the source at all — login wall, CAPTCHA, page gone, site changed shape — call it with accessible:false and a short reason instead of guessing, and start your final answer with [WATCH_BLOCKED].

record_watch_observation tells you whether this is news. Relay only what it says: start your final answer with [WATCH_TRIGGERED] if it reports notify, otherwise [WATCH_PENDING]. Do not use [WATCH_TRIGGERED] without it.`;
}

// The recorded observation wins over the model's own marker whenever the run actually made
// one: the evaluation in watch_state is computed from a real value by watches.js, so it
// cannot be talked into firing. The marker remains the fallback for watches that predate
// this (or that legitimately record nothing, e.g. a recurring reassessment).
function scheduledConditionTriggered(task, result, latestWatchState = null) {
  if (!task?.condition) return false;
  const evaluation = (latestWatchState || task.watch_state || {}).lastEvaluation;
  const spoken = String(result?.spoken || result?.agentTrace?.finalSpoken || '');
  if (evaluation?.at && Date.parse(evaluation.at) >= (task.claimedAtMs || 0)) {
    return evaluation.notify === true;
  }
  return /\[WATCH_TRIGGERED\]/i.test(spoken);
}

function cleanScheduledResultText(value) {
  return String(value || '')
    .replace(/\[WATCH_TRIGGERED\]|\[WATCH_PENDING\]|\[WATCH_BLOCKED\]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const DEFAULT_POLL_MINUTES = 30;
const DEFAULT_POLL_EXPIRY_DAYS = 30;
const CLAIM_LEASE_MINUTES = 10;

// Whether a recurrence is a genuine repeating cadence, as opposed to 'once' or condition-driven
// 'poll'. A due_date may pin the first occurrence's timing but must never downgrade a recurrence
// to a one-shot — advanceScheduledTask branches on this, and would fire a "daily" task once.
function isRecurringCadence(recurrence) {
  return recurrence === 'daily' || recurrence === 'weekly';
}

async function createScheduledTask(userId, {
  title, instruction = null, recurrence = 'once', time, day_of_week, date, due_date,
  condition = null, interval_minutes, expires_at, budget_cap,
  watch_type, threshold, comparator, notify_rule, source_url, target_state
}) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) return { success: false, error: 'A title is required.' };

  // Anything carrying watch configuration IS a watch, even when the user's phrasing did not
  // produce a separate condition sentence. Without this, "tell me if the price at <url> drops
  // below £90" became a one-shot task that fired once and never polled — and a later "check
  // it weekly" then reported success while changing nothing.
  const isWatch = Boolean(condition || source_url || threshold !== undefined || watch_type);
  const isRecurringCheck = watch_type === 'recurring_check';
  let cleanCondition = condition ? String(condition).trim() : null;
  if (isWatch && !cleanCondition) {
    const comparatorWord = comparator === 'above' ? 'above' : 'below';
    cleanCondition = threshold !== undefined && threshold !== null
      ? `the value goes ${comparatorWord} ${threshold}${source_url ? ` at ${source_url}` : ''}`
      : target_state
        ? `it becomes "${String(target_state).trim().slice(0, 80)}"`
        : `the state${source_url ? ` at ${source_url}` : ''} changes`;
  }

  // A condition ("when tickets go on sale") becomes a poll task: re-check on an interval
  // until the condition is met or it expires. A recurring reassessment is the exception — the
  // user asked for a cadence ("every Friday"), not for polling until something happens.
  let resolvedRecurrence = (isRecurringCheck && isRecurringCadence(recurrence)) ? recurrence
    : cleanCondition ? 'poll'
      : (isRecurringCadence(recurrence) || recurrence === 'poll' ? recurrence : 'once');

  let nextRunAt;
  let timeOfDay = time || null;
  let dayOfWeek = normalizeDayOfWeek(day_of_week);
  let intervalMinutes = null;
  let expiresAt = null;

  if (resolvedRecurrence === 'poll') {
    intervalMinutes = Number.isFinite(interval_minutes) && interval_minutes > 0
      ? Math.round(interval_minutes) : DEFAULT_POLL_MINUTES;
    const expiry = expires_at ? new Date(expires_at) : null;
    expiresAt = expiry && !Number.isNaN(expiry.getTime())
      ? expiry
      : new Date(Date.now() + DEFAULT_POLL_EXPIRY_DAYS * 86400000);
    nextRunAt = new Date(Date.now() + intervalMinutes * 60000);
  } else if (due_date) {
    nextRunAt = new Date(due_date);
    if (Number.isNaN(nextRunAt.getTime())) return { success: false, error: 'due_date is not a valid date.' };
    if (!isRecurringCadence(resolvedRecurrence) && resolvedRecurrence !== 'poll') resolvedRecurrence = 'once';
    timeOfDay = timeOfDay || `${pad2(nextRunAt.getUTCHours())}:${pad2(nextRunAt.getUTCMinutes())}`;
  } else {
    if (!timeOfDay) timeOfDay = '09:00';
    nextRunAt = computeNextRun(new Date(), { recurrence: resolvedRecurrence, time_of_day: timeOfDay, day_of_week: dayOfWeek, date });
  }

  const cap = Number(budget_cap);
  const row = {
    user_id: userId,
    title: cleanTitle,
    instruction: instruction ? String(instruction).trim() : null,
    recurrence: resolvedRecurrence,
    time_of_day: timeOfDay,
    day_of_week: dayOfWeek,
    next_run_at: nextRunAt.toISOString(),
    condition: cleanCondition,
    interval_minutes: intervalMinutes,
    expires_at: expiresAt ? expiresAt.toISOString() : null,
    budget_cap: Number.isFinite(cap) && cap > 0 ? cap : null,
    active: true
  };

  // Watch configuration lives with the watch. Only condition-bearing tasks get one — a plain
  // "remind me on Tuesday" is not a watch and has nothing to observe.
  if (cleanCondition || source_url || threshold !== undefined) {
    row.watch_state = {
      ...watches.buildWatchConfig({ type: watch_type, threshold, comparator, notify_rule, source_url, condition: cleanCondition }),
      targetState: target_state ? String(target_state).trim().slice(0, 120) : null
    };
  }

  // Asking for the same watch twice must adjust the one that exists rather than leaving two
  // polling the same page. Observed for real: four separate "Brighton hotel price" watches,
  // all created by re-asking, all firing independently.
  if (row.watch_state) {
    const { data: active } = await getSupabase()
      .from('scheduled_tasks')
      .select('id, title, condition, recurrence, time_of_day, day_of_week, next_run_at, interval_minutes, expires_at, budget_cap, watch_state, active')
      .eq('user_id', userId)
      .eq('active', true);
    const duplicate = watches.findDuplicateWatch(active || [], { title: cleanTitle, condition: cleanCondition, source_url });
    if (duplicate) {
      const patch = {
        interval_minutes: intervalMinutes,
        expires_at: expiresAt ? expiresAt.toISOString() : duplicate.expires_at,
        // The existing watch keeps its observation history — replacing it would throw away
        // the baseline that makes "has it changed?" answerable.
        watch_state: { ...row.watch_state, ...pickObservationState(duplicate.watch_state) }
      };
      const { data: updated, error: updateError } = await getSupabase()
        .from('scheduled_tasks').update(patch).eq('id', duplicate.id)
        .select('id, title, recurrence, time_of_day, day_of_week, next_run_at, condition, interval_minutes, expires_at, budget_cap, watch_state')
        .single();
      if (updateError) return { success: false, error: updateError.message };
      return { success: true, task: updated, deduped: true };
    }
  }

  const { data, error } = await getSupabase()
    .from('scheduled_tasks')
    .insert(row)
    .select('id, title, recurrence, time_of_day, day_of_week, next_run_at, condition, interval_minutes, expires_at, budget_cap, watch_state')
    .single();
  if (error) return { success: false, error: error.message };

  return { success: true, task: data };
}

// What must survive an edit or a re-request: the observations, never the config.
function pickObservationState(existing = {}) {
  if (!existing) return {};
  const kept = {};
  for (const key of ['baseline', 'lastObserved', 'history', 'lastEvaluation', 'thresholdMet', 'lastBlockedAt']) {
    if (existing[key] !== undefined) kept[key] = existing[key];
  }
  return kept;
}

// "Change that to weekly", "only tell me if it goes below £450", "stop checking that" — a
// watch you cannot adjust is one the user has to delete and recreate, losing its history.
async function updateScheduledTask(userId, { id, title, ...changes } = {}) {
  let query = getSupabase().from('scheduled_tasks').select('*').eq('user_id', userId).eq('active', true);
  if (id) query = query.eq('id', id);
  else if (title) query = query.ilike('title', `%${String(title).trim().replace(/[\\%_]/g, m => `\\${m}`)}%`);
  else return { success: false, error: 'A title or id is required to change a watch.' };

  const { data: matches, error } = await query.order('next_run_at', { ascending: true }).limit(2);
  if (error) return { success: false, error: error.message };
  if (!matches?.length) return { success: false, error: 'not_found' };
  if (matches.length > 1) {
    return { success: false, error: 'ambiguous', candidates: matches.map(t => ({ id: t.id, title: t.title })) };
  }
  const task = matches[0];

  const patch = {};
  const config = { ...(task.watch_state || {}) };
  let configChanged = false;

  if (changes.threshold !== undefined && changes.threshold !== null) {
    config.threshold = watches.parseNumber(changes.threshold);
    config.type = 'threshold';
    // A new threshold is a new question: whether the OLD one had been met must not suppress
    // the first notification about the new one.
    config.thresholdMet = false;
    configChanged = true;
  }
  if (changes.comparator) { config.comparator = changes.comparator === 'above' ? 'above' : 'below'; configChanged = true; }
  if (changes.notify_rule && watches.NOTIFY_RULES.includes(changes.notify_rule)) { config.notifyRule = changes.notify_rule; configChanged = true; }
  if (changes.source_url) { config.sourceUrl = String(changes.source_url).trim().slice(0, 500); configChanged = true; }
  if (changes.condition) { patch.condition = String(changes.condition).trim(); config.condition = patch.condition; configChanged = true; }
  if (configChanged) patch.watch_state = config;

  if (changes.instruction) patch.instruction = String(changes.instruction).trim();
  if (changes.new_title) patch.title = String(changes.new_title).trim();
  if (changes.budget_cap !== undefined) {
    const cap = Number(changes.budget_cap);
    patch.budget_cap = Number.isFinite(cap) && cap > 0 ? cap : null;
  }

  // Cadence changes reschedule from now, so "make it weekly" takes effect on the next run
  // rather than whenever the old cadence happened to land.
  const cadenceGiven = changes.recurrence || changes.interval_minutes !== undefined || changes.time || changes.day_of_week !== undefined;
  if (cadenceGiven) {
    const recurrence = changes.recurrence || task.recurrence;
    const isWatchTask = Boolean(task.watch_state);
    if (recurrence === 'poll' || (task.recurrence === 'poll' && !changes.recurrence)
      || (isWatchTask && changes.interval_minutes !== undefined && !isRecurringCadence(changes.recurrence))) {
      const minutes = Number(changes.interval_minutes);
      patch.interval_minutes = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : task.interval_minutes;
      patch.recurrence = 'poll';
      patch.next_run_at = new Date(Date.now() + (patch.interval_minutes || DEFAULT_POLL_MINUTES) * 60000).toISOString();
    } else {
      patch.recurrence = isRecurringCadence(recurrence) ? recurrence : task.recurrence;
      if (changes.time) patch.time_of_day = changes.time;
      if (changes.day_of_week !== undefined) patch.day_of_week = normalizeDayOfWeek(changes.day_of_week);
      patch.next_run_at = computeNextRun(new Date(), {
        recurrence: patch.recurrence,
        time_of_day: patch.time_of_day || task.time_of_day,
        day_of_week: patch.day_of_week ?? task.day_of_week
      }).toISOString();
    }
  }

  const { data: updated, error: updateError } = await getSupabase()
    .from('scheduled_tasks').update(patch).eq('id', task.id)
    .select('id, title, recurrence, time_of_day, day_of_week, next_run_at, condition, interval_minutes, expires_at, budget_cap, watch_state')
    .single();
  if (updateError) return { success: false, error: updateError.message };
  return { success: true, task: updated, changed: Object.keys(patch) };
}

// Writes one real observation and returns the deterministic verdict for it.
async function recordWatchObservation(userId, { id, value, state, note, accessible = true, error: reason } = {}) {
  if (!id) return { success: false, error: 'A watch id is required.' };
  const { data: task, error } = await getSupabase()
    .from('scheduled_tasks').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  if (error) return { success: false, error: error.message };
  if (!task) return { success: false, error: 'not_found' };

  const verdict = watches.evaluateObservation(task.watch_state || {}, { value, state, note, accessible, error: reason });
  const { error: writeError } = await getSupabase()
    .from('scheduled_tasks')
    .update({ watch_state: verdict.state })
    .eq('id', id);
  if (writeError) return { success: false, error: writeError.message };

  return {
    success: true,
    notify: verdict.notify,
    kind: verdict.kind,
    reason: verdict.reason,
    terminal: verdict.terminal,
    watchId: id,
    title: task.title
  };
}

async function listScheduledTasks(userId) {
  const { data, error } = await getSupabase()
    .from('scheduled_tasks')
    .select('id, title, instruction, recurrence, time_of_day, day_of_week, next_run_at, condition, interval_minutes, expires_at, active, watch_state')
    .eq('user_id', userId)
    .eq('active', true)
    .order('next_run_at', { ascending: true });
  if (error) return { success: false, error: error.message };
  return { success: true, tasks: data || [] };
}

async function cancelScheduledTask(userId, { id, title }) {
  let query = getSupabase()
    .from('scheduled_tasks')
    .select('id, title')
    .eq('user_id', userId)
    .eq('active', true);

  if (id) {
    query = query.eq('id', id);
  } else if (title) {
    // Escape LIKE wildcards so a title with % or _ matches literally.
    const safe = String(title).trim().replace(/[\\%_]/g, m => `\\${m}`);
    query = query.ilike('title', `%${safe}%`);
  } else {
    return { success: false, error: 'A title or id is required to cancel a scheduled task.' };
  }

  const { data: matches, error } = await query.order('next_run_at', { ascending: true }).limit(1);
  if (error) return { success: false, error: error.message };
  if (!matches?.length) return { success: false, error: 'not_found' };

  const { error: updateError } = await getSupabase()
    .from('scheduled_tasks')
    .update({ active: false })
    .eq('id', matches[0].id);
  if (updateError) return { success: false, error: updateError.message };

  return { success: true, task: matches[0] };
}

async function getDueScheduledTasks(userId, now = new Date()) {
  const { data, error } = await getSupabase()
    .from('scheduled_tasks')
    .select('id, title, instruction, recurrence, time_of_day, day_of_week, next_run_at, condition, interval_minutes, expires_at, budget_cap, watch_state')
    .eq('user_id', userId)
    .eq('active', true)
    .eq('completed', false)
    .lte('next_run_at', now.toISOString());
  if (error) throw new Error(error.message);
  return data || [];
}

// A sweep can run on more than one Fly machine. Move the due timestamp forward
// with a compare-and-set so only one instance owns a scheduled run. If that instance dies,
// the lease expires and the next sweep can retry it; the durable agent task remains the
// user-visible record of what happened.
async function claimScheduledTask(task, now = new Date()) {
  if (!task?.id || !task.next_run_at) return null;
  const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MINUTES * 60000);
  const { data, error } = await getSupabase()
    .from('scheduled_tasks')
    .update({ next_run_at: leaseUntil.toISOString() })
    .eq('id', task.id)
    .eq('active', true)
    .eq('completed', false)
    .eq('next_run_at', task.next_run_at)
    .select('id, title, instruction, recurrence, time_of_day, day_of_week, next_run_at, condition, interval_minutes, expires_at, budget_cap, watch_state')
    .maybeSingle();
  if (error || !data) return null;
  // claimedAtMs lets scheduledConditionTriggered tell a verdict recorded BY THIS RUN from a
  // stale one left by the previous cycle.
  return { ...task, ...data, claimedUntil: leaseUntil.toISOString(), claimedAtMs: now.getTime() };
}

async function deferScheduledTask(task, now = new Date()) {
  if (!task?.id) return { ok: false, error: 'scheduled task id required' };
  const nextRunAt = new Date(now.getTime() + CLAIM_LEASE_MINUTES * 60000);
  const { error } = await getSupabase().from('scheduled_tasks').update({
    next_run_at: nextRunAt.toISOString(),
    last_run_at: now.toISOString()
  }).eq('id', task.id);
  return error ? { ok: false, error: error.message } : { ok: true, nextRunAt: nextRunAt.toISOString() };
}

// Mark a one-shot or condition task as fulfilled so a retried sweep can't double-run it.
async function completeScheduledTask(task, now = new Date()) {
  await getSupabase().from('scheduled_tasks').update({
    completed: true,
    active: false,
    last_run_at: now.toISOString()
  }).eq('id', task.id);
}

async function advanceScheduledTask(task, now = new Date()) {
  if (task.recurrence === 'once') {
    await getSupabase().from('scheduled_tasks').update({ active: false, last_run_at: now.toISOString() }).eq('id', task.id);
    return;
  }
  if (task.recurrence === 'poll') {
    // Stop polling once we pass the expiry; otherwise schedule the next check.
    if (task.expires_at && new Date(task.expires_at).getTime() <= now.getTime()) {
      await getSupabase().from('scheduled_tasks').update({ active: false, last_run_at: now.toISOString() }).eq('id', task.id);
      return;
    }
    const nextRunAt = new Date(now.getTime() + (task.interval_minutes || DEFAULT_POLL_MINUTES) * 60000);
    await getSupabase().from('scheduled_tasks').update({
      next_run_at: nextRunAt.toISOString(),
      last_run_at: now.toISOString()
    }).eq('id', task.id);
    return;
  }
  const nextRunAt = computeNextRun(now, { recurrence: task.recurrence, time_of_day: task.time_of_day, day_of_week: task.day_of_week });
  await getSupabase().from('scheduled_tasks').update({
    next_run_at: nextRunAt.toISOString(),
    last_run_at: now.toISOString()
  }).eq('id', task.id);
}

module.exports = {
  describeSchedule,
  buildScheduledRunInstruction,
  scheduledConditionTriggered,
  cleanScheduledResultText,
  isRecurringCadence,
  createScheduledTask,
  updateScheduledTask,
  recordWatchObservation,
  listScheduledTasks,
  cancelScheduledTask,
  getDueScheduledTasks,
  claimScheduledTask,
  deferScheduledTask,
  completeScheduledTask,
  advanceScheduledTask
};

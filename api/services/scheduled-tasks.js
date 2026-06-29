const { createSupabaseServiceClient } = require('../../runtime');

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
    return task.condition ? `keep watching until: ${task.condition}` : `check every ${mins} min`;
  }
  if (task.recurrence === 'daily') return `every day at ${time}`;
  if (task.recurrence === 'weekly') {
    const day = WEEKDAYS[task.day_of_week] || 'the same day each week';
    return `every ${day} at ${time}`;
  }
  return `on ${new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(task.next_run_at))}`;
}

const DEFAULT_POLL_MINUTES = 30;
const DEFAULT_POLL_EXPIRY_DAYS = 30;

async function createScheduledTask(userId, {
  title, instruction = null, recurrence = 'once', time, day_of_week, date, due_date,
  condition = null, interval_minutes, expires_at, budget_cap
}) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) return { success: false, error: 'A title is required.' };

  const cleanCondition = condition ? String(condition).trim() : null;
  // A condition ("when tickets go on sale") becomes a poll task: re-check on an interval
  // until the condition is met or it expires.
  let resolvedRecurrence = cleanCondition ? 'poll'
    : (recurrence === 'daily' || recurrence === 'weekly' || recurrence === 'poll' ? recurrence : 'once');

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
    resolvedRecurrence = 'once';
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

  const { data, error } = await getSupabase()
    .from('scheduled_tasks')
    .insert(row)
    .select('id, title, recurrence, time_of_day, day_of_week, next_run_at, condition, interval_minutes, expires_at, budget_cap')
    .single();
  if (error) return { success: false, error: error.message };

  return { success: true, task: data };
}

async function listScheduledTasks(userId) {
  const { data, error } = await getSupabase()
    .from('scheduled_tasks')
    .select('id, title, instruction, recurrence, time_of_day, day_of_week, next_run_at, active')
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
    .select('id, title, instruction, recurrence, time_of_day, day_of_week, next_run_at, condition, interval_minutes, expires_at, budget_cap')
    .eq('user_id', userId)
    .eq('active', true)
    .eq('completed', false)
    .lte('next_run_at', now.toISOString());
  if (error) throw new Error(error.message);
  return data || [];
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
  createScheduledTask,
  listScheduledTasks,
  cancelScheduledTask,
  getDueScheduledTasks,
  completeScheduledTask,
  advanceScheduledTask
};

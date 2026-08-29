'use strict';

// Scheduled-task actions, lifted out of the switch in api/index.js.
//
// Handler names carry an Action suffix so they cannot shadow the service functions the
// bodies call -- the same collision that would have made modify_itinerary recurse into
// itself when the travel domain was extracted.

const scheduledTasks = require('../services/scheduled-tasks');
const watches = require('../services/watches');
const contextWatches = require('../services/context-watches');

async function createScheduledTaskAction({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const {} = deps;
  const title = String(params?.title || '').trim();
  const instruction = String(params?.instruction || params?.prompt || '').trim();
  if (!title || !instruction) return { success: false, error: 'create_scheduled_task requires title and instruction' };
  if (params?.context_event && !contextWatches.explicitLocationWatchRequest({
    event: params.context_event,
    radiusMetres: params.context_radius_metres
  }, context?.userMessage)) {
    return {
      success: false,
      error: 'A location watch needs the user to explicitly request the matching home arrival or departure in this message; a custom radius must also be named.'
    };
  }
  if (params?.context_metric && !contextWatches.explicitMetricWatchRequest({
    metric: params.context_metric,
    threshold: params.threshold,
    comparator: params.comparator
  }, context?.userMessage)) {
    return {
      success: false,
      error: 'A health watch needs the user to explicitly name the metric, threshold, and monitoring request in this message.'
    };
  }
  const created = await scheduledTasks.createScheduledTask(userId, {
    title,
    instruction,
    recurrence: params?.recurrence,
    time: params?.time || params?.time_of_day,
    day_of_week: params?.day_of_week,
    date: params?.date,
    due_date: params?.due_date,
    condition: params?.condition,
    interval_minutes: params?.interval_minutes,
    expires_at: params?.expires_at,
    budget_cap: params?.budget_cap,
    watch_type: params?.watch_type,
    threshold: params?.threshold,
    comparator: params?.comparator,
    notify_rule: params?.notify_rule,
    source_url: params?.source_url,
    target_state: params?.target_state,
    context_event: params?.context_event,
    context_metric: params?.context_metric,
    context_radius_metres: params?.context_radius_metres,
    initial_context: context?.location && context?.homeLocation ? {
      location: context.location,
      homeLocation: context.homeLocation,
      settings: { homeLocation: context.homeLocation },
      updated_at: new Date().toISOString()
    } : null
  });
  if (!created.success) return created;
  const task = created.task || {};
  return {
    success: true,
    deduped: Boolean(created.deduped),
    text: created.deduped
      ? `Already watching “${task.title || title}” ${scheduledTasks.describeSchedule(task)}.`
      : `Watching “${task.title || title}” ${scheduledTasks.describeSchedule(task)}.`,
    actionSummary: 'Watch saved',
    scheduledTask: {
      id: task.id,
      title: task.title,
      recurrence: task.recurrence,
      nextRunAt: task.next_run_at,
      condition: task.condition || null,
      expiresAt: task.expires_at || null
    }
  };
}

async function listScheduledTasksAction({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const {} = deps;
  const listed = await scheduledTasks.listScheduledTasks(userId);
  if (!listed.success) return { success: false, error: listed.error };
  const rows = listed.tasks || [];
  const tasks = rows.map(task => ({
    id: task.id,
    title: task.title,
    recurrence: task.recurrence,
    nextRunAt: task.next_run_at,
    active: task.active !== false,
    condition: task.condition || null,
    // "What are you watching for me?" should answer with the real state of each watch —
    // what it looks at, what it last saw, and whether its last check actually worked.
    watch: task.watch_state ? {
      type: task.watch_state.type,
      threshold: task.watch_state.threshold ?? null,
      comparator: task.watch_state.comparator || null,
      notifyRule: task.watch_state.notifyRule || null,
      sourceUrl: task.watch_state.sourceUrl || null,
      contextEvent: task.watch_state.context?.event || null,
      contextMetric: task.watch_state.context?.metric || null,
      lastObserved: task.watch_state.lastObserved || null,
      lastCheckFailed: task.watch_state.lastEvaluation?.kind === 'blocked'
        ? task.watch_state.lastEvaluation.reason : null
    } : null
  }));
  return {
    success: true,
    text: tasks.length
      ? rows.map(task => {
        const detail = watches.describeWatch(task);
        return `• ${task.title} · ${scheduledTasks.describeSchedule(task)}${detail ? ` · ${detail}` : ''}`;
      }).join('\n')
      : 'Adam is not watching anything right now.',
    actionSummary: `${tasks.length} watch${tasks.length === 1 ? '' : 'es'}`,
    scheduledTasks: tasks
  };
}

async function cancelScheduledTaskAction({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const {} = deps;
  const id = String(params?.id || '').trim();
  const title = String(params?.title || '').trim();
  if (!id && !title) return { success: false, error: 'Tell me which background watch to cancel.' };
  const cancelled = await scheduledTasks.cancelScheduledTask(userId, { id, title });
  if (!cancelled.success) {
    return cancelled.error === 'not_found'
      ? { success: false, error: 'I could not find that background watch.' }
      : cancelled;
  }
  return {
    success: true,
    text: `Stopped watching “${cancelled.task?.title || title || 'that'}”.`,
    actionSummary: 'Watch stopped',
    scheduledTask: { id: cancelled.task?.id || id, title: cancelled.task?.title || title, active: false }
  };
}

// Adjusting a watch instead of deleting and recreating it — which would throw away the
// baseline and observation history that make "has it changed?" answerable at all.
async function updateScheduledTaskAction({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const {} = deps;
  const updated = await scheduledTasks.updateScheduledTask(userId, {
    id: params?.id,
    title: params?.title,
    new_title: params?.new_title,
    recurrence: params?.recurrence,
    interval_minutes: params?.interval_minutes,
    time: params?.time || params?.time_of_day,
    day_of_week: params?.day_of_week,
    condition: params?.condition,
    threshold: params?.threshold,
    comparator: params?.comparator,
    notify_rule: params?.notify_rule,
    source_url: params?.source_url,
    instruction: params?.instruction,
    budget_cap: params?.budget_cap
  });
  if (!updated.success) {
    if (updated.error === 'not_found') return { success: false, error: 'I could not find that watch.' };
    if (updated.error === 'ambiguous') {
      return { success: false, error: `More than one watch matches that: ${updated.candidates.map(c => c.title).join(', ')}. Which one?` };
    }
    return updated;
  }
  const task = updated.task || {};
  return {
    success: true,
    text: `Updated “${task.title}” — now ${scheduledTasks.describeSchedule(task)}${watches.describeWatch(task) ? ` · ${watches.describeWatch(task)}` : ''}.`,
    actionSummary: 'Watch updated',
    scheduledTask: { id: task.id, title: task.title, recurrence: task.recurrence, nextRunAt: task.next_run_at, watch: task.watch_state || null }
  };
}

module.exports = {
  handlers: {
    create_scheduled_task: createScheduledTaskAction,
    list_scheduled_tasks: listScheduledTasksAction,
    cancel_scheduled_task: cancelScheduledTaskAction,
    update_scheduled_task: updateScheduledTaskAction
  }
};

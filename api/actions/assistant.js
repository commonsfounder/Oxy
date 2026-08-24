'use strict';

// The remaining general-assistant actions, lifted out of the switch in api/index.js.
//
// These do not form one domain -- reminders, health, smart home, delegation, notification
// settings -- but they are each small and self-contained, and leaving them behind would
// have kept the switch alive for the sake of a few dozen lines.
//
// Connector and service modules are required as objects and called as properties, never
// destructured, so tests that monkey-patch the shared module object keep working.

const { dispatch: dispatchConnector } = require('../../connectors');
const googleConnector = require('../../connectors/google');
const telegram = require('../../connectors/telegram');
const notifications = require('../services/notifications');
const taskManager = require('../services/task-manager');
const scheduledTasks = require('../services/scheduled-tasks');
const { runCapabilitySweep } = require('../services/capability-sweep');
const { availableChannels, describeUnavailable } = require('../services/notification-delivery');
const { resolveDelegatedGuardMode } = require('../services/delegated-run-starter');

async function calculate({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, executeAction, delegatedRunLifecycle, startDelegatedTaskExecution, getPreferenceMap, setPreferenceValue } = deps;
  const expr = String(params?.expression || params?.query || '').trim();
  if (!expr) return { success: false, error: 'calculate requires expression' };
  try {
    // Safe-ish math eval (limited)
    const safe = expr.replace(/[^0-9+\-*/().%\s^]/g, '');
    // eslint-disable-next-line no-eval
    const val = (0, eval)(safe || '0');
    return { success: true, text: `${expr} = ${val}`, result: val };
  } catch {
    return { success: false, outcome: 'failed', error: `Could not calculate "${expr}" safely.` };
  }
}

async function createAgentTask({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, executeAction, delegatedRunLifecycle, startDelegatedTaskExecution, getPreferenceMap, setPreferenceValue } = deps;
  const goal = String(params?.goal || '').trim();
  if (!goal) return { success: false, error: 'create_agent_task requires goal' };
  try {
    // A child task can inherit a stricter approval policy, never weaken the
    // policy that governs the current user turn.
    const guardMode = resolveDelegatedGuardMode(params.guardMode, context.guardMode);
    const task = await delegatedRunLifecycle.create(userId, goal, {
      autonomy: params.autonomy,
      plan: params.plan,
      metadata: guardMode === undefined ? undefined : { guardMode }
    });
    const started = await startDelegatedTaskExecution({
      userId,
      task,
      runtime: {
        deviceType: context.deviceType || 'ambient_home',
        kind: 'task'
      }
    });
    if (started.status !== 200) {
      return {
        success: false,
        outcome: 'failed',
        error: started.body?.error || 'The task was saved but could not be started.',
        taskId: task.id,
        started: false
      };
    }
    return {
      success: true,
      outcome: 'incomplete',
      text: `Persistent agent task started: "${goal}". ID: ${task.id}. It is running in the background and can be resumed from Work.`,
      actionSummary: 'Persistent task started',
      taskId: task.id,
      started: true,
      delegatedTask: true
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Called by a watch's own background run with what it ACTUALLY observed. The notify
// decision comes back from watches.evaluateObservation — deterministic, computed from
// the recorded value, and therefore not something the model can talk itself into.
async function recordWatchObservation({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, executeAction, delegatedRunLifecycle, startDelegatedTaskExecution, getPreferenceMap, setPreferenceValue } = deps;
  const recorded = await scheduledTasks.recordWatchObservation(userId, {
    id: String(params?.watch_id || params?.id || '').trim(),
    value: params?.value,
    state: params?.state,
    note: params?.note,
    accessible: !(params?.accessible === false || String(params?.accessible) === 'false'),
    error: params?.error || params?.reason
  });
  if (!recorded.success) {
    return recorded.error === 'not_found'
      ? { success: false, error: 'That watch no longer exists.' }
      : recorded;
  }
  return {
    success: true,
    notify: recorded.notify,
    kind: recorded.kind,
    terminal: recorded.terminal,
    text: recorded.notify
      ? `This IS news: ${recorded.reason}. Report it to the user.`
      : `Not news: ${recorded.reason}. Do not notify the user this cycle.`
  };
}

async function simulateActions({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, executeAction, delegatedRunLifecycle, startDelegatedTaskExecution, getPreferenceMap, setPreferenceValue } = deps;
  const goal = String(params?.goal || '').trim();
  const actions = params?.actions || [];
  try {
    const outcomes = actions.length ? actions.map(a => ({ action: a, simulated: 'would execute if approved' })) : [{ simulated: 'full plan simulation would run here' }];
    await taskManager.recordSimulation(userId, goal, actions, outcomes);
    return { success: false, outcome: 'simulated', simulated: true, text: `Simulation for "${goal}" complete. ${outcomes.length} steps previewed. No real actions taken.`, outcomes };
  } catch (e) {
    return { success: false, outcome: 'simulated', simulated: true, text: `Simulation previewed for "${goal}", but its history could not be saved.`, storageError: e.message };
  }
}

// Expanded integrations for Poke-like breadth
async function logHealth({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, executeAction, delegatedRunLifecycle, startDelegatedTaskExecution, getPreferenceMap, setPreferenceValue } = deps;
  const metric = params?.metric || 'steps';
  const value = params?.value || 'updated';
  return { success: false, outcome: 'unavailable', unavailable: true, error: `HealthKit logging is not available on this device (${metric}: ${value}).` };
}

async function controlSmartHome({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, executeAction, delegatedRunLifecycle, startDelegatedTaskExecution, getPreferenceMap, setPreferenceValue } = deps;
  const device = params?.device || 'lights';
  const command = params?.command || 'toggle';
  return dispatchConnector('home_assistant', userId, 'control_smart_home', { ...params, device, command });
}

async function mcpTool({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, executeAction, delegatedRunLifecycle, startDelegatedTaskExecution, getPreferenceMap, setPreferenceValue } = deps;
  const name = params?.name;
  const args = params?.arguments || {};
  return { success: false, outcome: 'unavailable', unavailable: true, error: `MCP tool execution is not configured${name ? ` for ${name}` : ''}.`, mcp: { name, args } };
}

// Super easy consumer Reminders (uses your iPhone's built-in, no extra login)
async function createReminder({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, executeAction, delegatedRunLifecycle, startDelegatedTaskExecution, getPreferenceMap, setPreferenceValue } = deps;
  const title = params?.title || params?.text || 'Reminder';
  const due = params?.due_date || '';
  return {
    success: false,
    outcome: 'handoff_required',
    handoffRequired: true,
    text: `Reminder set for "${title}"${due ? ' ' + due : ''}.`,
    nativeExecution: 'reminder',
    cardText: title,
    deepLink: `x-apple-reminderkit://`
  };
}

// "What do I need to know today?" — composed from the capabilities that are already
// real, never a dump of every source. Everything here is re-read live on each call:
// that is what makes a recurring morning brief a genuine current-state digest rather
// than a stored summary replayed every day. Ranking/noise rules live in
// api/services/daily-digest.js; this case is purely the gathering.
async function capabilitySweep({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, executeAction, delegatedRunLifecycle, startDelegatedTaskExecution, getPreferenceMap, setPreferenceValue } = deps;
  return runCapabilitySweep({
    userId,
    inputs: params,
    execute: (type, input) => executeAction(userId, type, input, context)
  });
}

// How the user controls being interrupted. Deliberately four knobs, not a settings panel:
// which channel, which categories, urgent-only, and when to stay quiet.
async function setNotificationPreference({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, executeAction, delegatedRunLifecycle, startDelegatedTaskExecution, getPreferenceMap, setPreferenceValue } = deps;
  const scope = String(params?.category || '').trim().toLowerCase();
  const urgencyScope = String(params?.urgency || '').trim().toLowerCase();
  const channel = String(params?.channel || '').trim().toLowerCase();
  const updates = [];

  if (scope && urgencyScope) {
    return { success: false, error: 'Set a preference by category or by urgency, not both at once.' };
  }
  if (channel) {
    const valid = ['auto', ...notifications.CHANNELS, 'off'];
    if (!valid.includes(channel)) return { success: false, error: `channel must be one of ${valid.join(', ')}` };
    const key = scope ? notifications.PREF.category(notifications.normalizeCategory(scope))
      : urgencyScope ? notifications.PREF.urgency(notifications.normalizeUrgency(urgencyScope))
        : notifications.PREF.channel;
    await setPreferenceValue(userId, key, channel);
    updates.push(scope ? `${scope} notifications: ${channel}`
      : urgencyScope ? `${urgencyScope} notifications: ${channel}`
        : `default channel: ${channel}`);
  }
  if (params?.fallback !== undefined) {
    const raw = String(params.fallback || '').trim().toLowerCase();
    const list = raw.split(',').map(c => c.trim()).filter(Boolean);
    const bad = list.find(c => !notifications.CHANNELS.includes(c) || c === 'in_app');
    if (bad) return { success: false, error: `fallback channels must be one of ${notifications.CHANNELS.filter(c => c !== 'in_app').join(', ')}` };
    await setPreferenceValue(userId, notifications.PREF.fallback, list.join(','));
    updates.push(raw ? `falls back to ${list.join(', ')} if the chosen channel fails` : 'no fallback channel');
  }
  if (params?.urgent_only !== undefined) {
    const value = params.urgent_only === true || String(params.urgent_only) === 'true';
    await setPreferenceValue(userId, notifications.PREF.urgentOnly, String(value));
    updates.push(value ? 'only urgent things' : 'not just urgent things');
  }
  if (params?.quiet_hours !== undefined) {
    const raw = String(params.quiet_hours || '').trim();
    if (raw && !notifications.parseQuietHours(raw)) {
      return { success: false, error: 'quiet_hours must look like "22:00-07:00"' };
    }
    await setPreferenceValue(userId, notifications.PREF.quietHours, raw);
    updates.push(raw ? `quiet hours ${raw}` : 'no quiet hours');
  }
  if (params?.email_to) {
    await setPreferenceValue(userId, notifications.PREF.emailTo, String(params.email_to).trim());
    updates.push(`email to ${params.email_to}`);
  }
  if (!updates.length) return { success: false, error: 'Nothing to change — say which channel, category, urgency, fallback, quiet hours or destination.' };

  // Report what can actually deliver, so "email me if the price drops" or "urgent
  // things on Telegram" cannot look configured when the underlying channel is not.
  const prefs = await getPreferenceMap(userId);
  const { data: userRow } = await supabase.from('users').select('email, email_verified').eq('user_id', userId).maybeSingle();
  const mailbox = await googleConnector.getMailbox(userId).catch(() => null);
  const mailboxCanSend = Boolean(mailbox?.canSend && mailbox?.address);
  const emailTo = prefs[notifications.PREF.emailTo] || (userRow?.email_verified ? userRow.email : '') || mailbox?.address || '';
  const telegramDest = await telegram.getSelfDestination(userId).catch(() => null);
  const telegramCanSend = Boolean(telegramDest?.canSend);
  const { count: deviceCount } = await supabase.from('devices').select('*', { count: 'exact', head: true }).eq('user_id', userId);
  const available = availableChannels({ hasPushDevices: (deviceCount || 0) > 0, emailTo, mailboxCanSend, telegramCanSend });
  const blocked = describeUnavailable({ hasPushDevices: (deviceCount || 0) > 0, emailTo, mailboxCanSend, telegramCanSend });

  return {
    success: true,
    preferences: notifications.describePreference(prefs),
    available,
    unavailable: blocked,
    text: `Updated: ${updates.join('; ')}.${blocked.length ? ` Be aware — ${blocked.join('; ')}, so anything routed there will fall back until that is set up.` : ''}`
  };
}

// forgetMemory also backs a route in api/index.js, so it stays there and is handed over
// rather than duplicated.
async function forgetMemory({ userId, params, deps }) {
  return deps.forgetMemory(userId, params || {});
}

module.exports = {
  handlers: {
    forget_memory: forgetMemory,
    calculate: calculate,
    create_agent_task: createAgentTask,
    record_watch_observation: recordWatchObservation,
    simulate_actions: simulateActions,
    log_health: logHealth,
    control_smart_home: controlSmartHome,
    mcp_tool: mcpTool,
    create_reminder: createReminder,
    capability_sweep: capabilitySweep,
    set_notification_preference: setNotificationPreference
  }
};

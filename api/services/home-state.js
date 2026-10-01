'use strict';

// What the home screen is, in one shape — the four questions a person actually has:
//
//   needsYou   — stopped, waiting on a human decision
//   handling   — running right now, nothing required of you
//   changed    — happened since you last opened the app
//   completed  — finished, recently enough to still matter
//
// It owns no rules of its own: workflows, commitments and tasks each keep theirs, and this
// translates them into one vocabulary the UI renders without branching. Every source is
// optional and a failure in one never blanks the others.

const workflows = require('./workflows');
const commitments = require('./commitments');

const LAST_SEEN_KEY = 'home_last_seen_at';

// How far back "completed" reaches. Long enough that finishing something overnight is
// still visible in the morning, short enough that the lane is not an archive.
const COMPLETED_WINDOW_MS = 72 * 60 * 60 * 1000;

// A first-ever open has no watermark. Showing every event ever recorded as "changed"
// would be worse than showing none, so an absent watermark means this far back only.
const DEFAULT_CHANGED_WINDOW_MS = 24 * 60 * 60 * 1000;

const MAX_PER_LANE = 12;

// A channel-bound chat turn has a durable transcript in Conversations. It is not a piece
// of household work and must not be promoted into Home's changed/completed lanes. The
// channel is explicit metadata rather than a title or provider-name heuristic. The result
// check is only a compatibility bridge for older Telegram task rows written before channel
// metadata was persisted.
function isConversationalTask(task) {
  const channel = task?.metadata?.channel;
  if (typeof channel === 'string' && channel.trim().length > 0) return true;
  const results = Array.isArray(task?.results) ? task.results : [];
  return results.some(entry =>
    entry?.action === 'send_telegram' || entry?.type === 'send_telegram' ||
    entry?.result?.action === 'send_telegram' || entry?.result?.type === 'send_telegram'
  );
}

// Every chat turn gets a task row so its tool calls have somewhere durable to live. A turn that only
// talked (a question, a reaction, small talk) is conversation, not work, and must never appear as
// something Adam did. A turn counts as work only if it carried a plan or changed something in the world.
const READ_ONLY_ACTION = /^(get_|search_|find_|check_|list_|read_|lookup_)|^(web_search|browser_observe|browser_open|browser_close|transaction_status|workspace_read|workspace_list|workspace_write)$/;

function executedActionTypes(task) {
  const results = Array.isArray(task?.results) ? task.results : [];
  return results
    .map(entry => entry?.action || entry?.type || entry?.result?.action || entry?.result?.type)
    .filter(type => typeof type === 'string' && type);
}

// Chat turns are created with a model route, guard mode and search flag together (and, from now on,
// an explicit origin). Delegated goals made on purpose carry a plan instead.
function isChatTurnTask(task) {
  const meta = task?.metadata || {};
  if (meta.origin === 'chat_turn') return true;
  return Boolean(meta.modelRoute) && meta.guardMode !== undefined && meta.useSearch !== undefined;
}

function isRoutineChatTurn(task) {
  if (!isChatTurnTask(task)) return false;
  if (Array.isArray(task?.plan) && task.plan.length) return false;
  return !executedActionTypes(task).some(type => !READ_ONLY_ACTION.test(type));
}

// --- Watermark ---------------------------------------------------------------------

async function getLastSeen(supabase, userId) {
  const { data, error } = await supabase.from('preferences')
    .select('value').eq('user_id', userId).eq('key', LAST_SEEN_KEY).limit(1);
  if (error) throw error;
  const raw = data?.[0]?.value;
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

// Called when the user has actually seen the board, never as a side effect of loading
// it — a background poll that marked things seen would silently empty the Changed lane
// before the user ever looked at the screen.
async function markSeen(supabase, userId, at = new Date()) {
  const iso = at.toISOString();
  const { error } = await supabase.from('preferences')
    .upsert({ user_id: userId, key: LAST_SEEN_KEY, value: iso, updated_at: iso },
            { onConflict: 'user_id,key' });
  if (error) throw new Error(`Couldn't save your place: ${error.message}`);
  return iso;
}

// --- Lane construction -------------------------------------------------------------

function lastActivityOf(workflow) {
  return workflow.updated_at || workflow.created_at || null;
}

// A workflow's one-line subtitle. The pending question wins when there is one, because
// it is the only line that asks the user for anything.
function detailFor(workflow, pendingPrompt) {
  return pendingPrompt || workflow.next_action || workflow.current_step || '';
}

// Activity is a glanceable record, not a transcript title. The durable goal is
// still available in the work detail, but a timeline row needs the subject of
// the request in one short line. This is deliberately deterministic: it never
// invents a summary or changes the task the user asked Adam to perform.
function activityTitle(goal, maxLength = 72) {
  const firstThought = String(goal || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s|\n/, 1)[0]
    .replace(/^(?:please |can you |could you |would you |i need you to |i want you to )/i, '')
    .trim();
  if (firstThought.length <= maxLength) return firstThought || 'Untitled task';

  const boundary = firstThought.lastIndexOf(' ', maxLength - 1);
  const shortened = firstThought.slice(0, boundary > 24 ? boundary : maxLength).trim();
  return `${shortened.replace(/[,:;\-–—]+$/, '')}…`;
}

async function buildFromWorkflows(supabase, userId, { since, now }) {
  const handling = [];
  const needsYou = [];
  const changed = [];
  const completed = [];

  const { data: rows, error } = await supabase.from('workflows').select('*')
    .eq('user_id', userId).order('updated_at', { ascending: false });
  if (error) throw error;
  const all = rows || [];
  if (!all.length) return { handling, needsYou, changed, completed };

  const active = all.filter(w => workflows.ACTIVE_STATUSES.includes(w.status));

  // One query for every pending checkpoint rather than one per workflow — the previous
  // shape of this lookup was a loop, and the board reads it on every poll.
  const activeIds = active.map(w => w.id);
  let pendingByWorkflow = new Map();
  if (activeIds.length) {
    const { data: checkpoints, error: checkpointError } = await supabase.from('workflow_checkpoints')
      .select('*').in('workflow_id', activeIds).eq('status', 'pending');
    if (checkpointError) throw checkpointError;
    for (const checkpoint of checkpoints || []) {
      if (!pendingByWorkflow.has(checkpoint.workflow_id)) {
        pendingByWorkflow.set(checkpoint.workflow_id, checkpoint);
      }
    }
  }

  for (const workflow of active) {
    const checkpoint = pendingByWorkflow.get(workflow.id) || null;
    const blocked = !!checkpoint || workflow.status === 'waiting_for_user';
    const item = {
      id: `workflow-${workflow.id}`,
      workflowId: workflow.id,
      kind: workflow.type || 'general',
      title: activityTitle(workflow.goal),
      detail: detailFor(workflow, checkpoint?.prompt),
      at: lastActivityOf(workflow),
      deadline: workflow.deadline || null
    };
    if (blocked) {
      needsYou.push({
        ...item,
        checkpointId: checkpoint?.id || null,
        prompt: checkpoint?.prompt || workflow.blocked_reason || workflow.next_action || '',
        options: checkpoint?.options || null
      });
    } else {
      handling.push({
        ...item,
        // "Waiting on someone else" is not the same as "running", and a person reads the
        // difference immediately. Nothing is required of them either way.
        waitingExternal: workflow.status === 'waiting_external'
      });
    }
  }

  const completedCutoff = new Date(now.getTime() - COMPLETED_WINDOW_MS);
  for (const workflow of all) {
    if (!workflows.TERMINAL_STATUSES.includes(workflow.status)) continue;
    const closedAt = workflow.closed_at ? new Date(workflow.closed_at) : null;
    if (!closedAt || closedAt < completedCutoff) continue;
    completed.push({
      id: `workflow-${workflow.id}`,
      workflowId: workflow.id,
      kind: workflow.type || 'general',
      title: activityTitle(workflow.goal),
      detail: workflow.status === 'completed' ? (workflow.current_step || '') : workflow.blocked_reason || '',
      at: workflow.closed_at,
      failed: workflow.status !== 'completed'
    });
  }

  // Changed is the timeline, filtered to what happened while the user was away. Events
  // authored by the user themselves are excluded — being told what you just did is noise.
  const allIds = all.map(w => w.id);
  if (allIds.length) {
    const { data: events, error: eventsError } = await supabase.from('workflow_events')
      .select('*').in('workflow_id', allIds)
      .gt('created_at', since.toISOString())
      .order('created_at', { ascending: false })
      .limit(MAX_PER_LANE * 2);
    if (eventsError) throw eventsError;
    const titleById = new Map(all.map(w => [w.id, activityTitle(w.goal)]));
    for (const event of events || []) {
      if (event.actor === 'user') continue;
      // What happened is the headline; which piece of work it belongs to is the context.
      // The other way round made every row read as the same repeated goal, with the one
      // thing that actually changed demoted to a subtitle.
      changed.push({
        id: `event-${event.id}`,
        workflowId: event.workflow_id,
        kind: event.kind,
        title: event.summary || event.kind,
        detail: titleById.get(event.workflow_id) || '',
        at: event.created_at
      });
    }
  }

  return { handling, needsYou, changed, completed };
}

// Tasks predate workflows and still carry real work, so the board reads both. A task
// that already belongs to a workflow is skipped — it is the same job, and showing it
// twice is exactly the kind of thing that makes an assistant look forgetful.
async function buildFromTasks(supabase, userId, { since, now }) {
  const handling = [];
  const changed = [];
  const completed = [];

  const { data: rows, error } = await supabase.from('agent_tasks').select('*')
    .eq('user_id', userId).order('updated_at', { ascending: false }).limit(60);
  if (error) throw error;

  const completedCutoff = new Date(now.getTime() - COMPLETED_WINDOW_MS);
  for (const task of rows || []) {
    if (task.workflow_id) continue;
    if (isConversationalTask(task)) continue;
    if (isRoutineChatTurn(task)) continue;
    const status = String(task.status || '').toLowerCase();
    if (status === 'recipe') continue;

    if (status === 'running') {
      const plan = Array.isArray(task.plan) ? task.plan : [];
      handling.push({
        id: `task-${task.id}`,
        taskId: task.id,
        kind: 'task',
        title: activityTitle(task.goal),
        detail: '',
        at: task.heartbeat_at || task.updated_at || task.created_at,
        // Real step counts when the task carries a plan, rather than a spinner that
        // conveys nothing about how far along the work is.
        progress: plan.length ? { done: Math.min(task.current_step || 0, plan.length), total: plan.length } : null
      });
    } else if (status === 'completed' || status === 'failed') {
      const finishedAt = task.completed_at || task.updated_at;
      if (!finishedAt || new Date(finishedAt) < completedCutoff) continue;
      const item = {
        id: `task-${task.id}`,
        taskId: task.id,
        kind: 'task',
        title: activityTitle(task.goal),
        detail: status === 'failed' ? (task.last_error || '') : '',
        at: finishedAt,
        failed: status === 'failed'
      };
      completed.push(item);
      if (new Date(finishedAt) > since) changed.push({ ...item, kind: status });
    }
  }

  return { handling, changed, completed };
}

// A promise the user made and has not kept is the clearest possible "needs you": there
// is no machinery waiting, only them. Overdue first, then due today.
async function buildFromCommitments(supabase, userId, { now }) {
  const { data: rows, error } = await supabase.from('commitments').select('*')
    .eq('user_id', userId).eq('status', 'open').order('due_at', { ascending: true }).limit(50);
  if (error) throw error;

  const out = [];
  for (const commitment of rows || []) {
    const overdue = commitments.isOverdue(commitment, now);
    const dueToday = commitments.isDueToday(commitment, now);
    if (!overdue && !dueToday) continue;
    out.push({
      id: `commitment-${commitment.id}`,
      commitmentId: commitment.id,
      kind: 'promise',
      title: commitment.person_name
        ? `You told ${commitment.person_name} you'd ${commitment.what}`
        : `You said you'd ${commitment.what}`,
      detail: commitments.describeDue(commitment, now) || '',
      prompt: '',
      at: commitment.updated_at || commitment.created_at,
      overdue
    });
  }
  return out;
}

// --- Assembly ------------------------------------------------------------------------

function byRecency(a, b) {
  return new Date(b.at || 0) - new Date(a.at || 0);
}

// One failing source must never blank the board. Each lane contributor is awaited
// independently and an error there costs only its own rows.
async function settled(promise, fallback, onFailure = () => {}) {
  try {
    return await promise;
  } catch (err) {
    onFailure();
    console.warn('[home-state] source failed:', err.message);
    return fallback;
  }
}

async function getHomeState(supabase, userId, { now = new Date() } = {}) {
  const unavailableSources = new Set();
  const failed = source => () => unavailableSources.add(source);
  const lastSeen = await settled(getLastSeen(supabase, userId), null, failed('history'));
  const since = lastSeen || new Date(now.getTime() - DEFAULT_CHANGED_WINDOW_MS);

  const [fromWorkflows, fromTasks, fromCommitments] = await Promise.all([
    settled(buildFromWorkflows(supabase, userId, { since, now }),
            { handling: [], needsYou: [], changed: [], completed: [] }, failed('workflows')),
    settled(buildFromTasks(supabase, userId, { since, now }),
            { handling: [], changed: [], completed: [] }, failed('tasks')),
    settled(buildFromCommitments(supabase, userId, { now }), [], failed('commitments'))
  ]);

  // Promises the user owes float above machinery waiting on them: a person can act on a
  // promise immediately, whereas a checkpoint is a question about work already underway.
  const needsYou = [
    ...fromCommitments.filter(c => c.overdue),
    ...fromWorkflows.needsYou,
    ...fromCommitments.filter(c => !c.overdue)
  ].slice(0, MAX_PER_LANE);

  const handling = [...fromWorkflows.handling, ...fromTasks.handling]
    .sort(byRecency).slice(0, MAX_PER_LANE);
  const changed = [...fromWorkflows.changed, ...fromTasks.changed]
    .sort(byRecency).slice(0, MAX_PER_LANE);
  const completed = [...fromWorkflows.completed, ...fromTasks.completed]
    .sort(byRecency).slice(0, MAX_PER_LANE);

  return {
    generatedAt: now.toISOString(),
    unavailableSources: [...unavailableSources].sort(),
    lastSeenAt: lastSeen ? lastSeen.toISOString() : null,
    needsYou,
    handling,
    changed,
    completed,
    counts: {
      needsYou: needsYou.length,
      handling: handling.length,
      changed: changed.length,
      completed: completed.length
    }
  };
}

module.exports = {
  LAST_SEEN_KEY,
  COMPLETED_WINDOW_MS,
  DEFAULT_CHANGED_WINDOW_MS,
  MAX_PER_LANE,
  activityTitle,
  isConversationalTask,
  isRoutineChatTurn,
  getLastSeen,
  markSeen,
  getHomeState
};

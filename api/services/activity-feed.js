'use strict';

const { ACTION_WORDING } = require('../action-wording');

// Activity is Adam's record of what it noticed, did, asked and scheduled. It is built from the
// places those things are actually recorded (the action log, schedules, approvals, notices and
// finished durable work), never from the chat transcript: a message or a reaction is
// conversation, and lives in Chat.

const TYPES = Object.freeze(['noticed', 'did', 'asked', 'scheduled', 'checked']);

// Actions that only look at the world. Succeeding at one is "checked", not "did".
const READ_ONLY = /^(get_|search_|find_|check_|list_|read_|lookup_)|^(web_search|browser_observe|browser_open|transaction_status|workspace_read|workspace_list)$/;

// Bookkeeping that is shown elsewhere (memory chips in Chat) or is not something a person did or cares about.
const NOT_ACTIVITY = new Set([
  'remember_person', 'save_occasion', 'forget_person_detail', 'forget_memory',
  'workspace_write', 'browser_close', 'browser_act', 'browser_continue_without_account',
  'browser_fill_known_details', 'browser_upload', 'browser_download', 'set_notification_preference'
]);

const NOTICE_CATEGORIES = new Set(['watch', 'delivery', 'reply_needed', 'occasion', 'other']);

const STALE_AFTER_MS = 5 * 60 * 1000;
const COLLAPSE_WINDOW_MS = 10 * 60 * 1000;

function clean(value, max = 140) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function validDate(value) {
  const date = new Date(value || '');
  return Number.isFinite(date.getTime()) ? date : null;
}

function parseLogged(row) {
  try {
    const parsed = typeof row?.action === 'string' ? JSON.parse(row.action) : row?.action;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function humanize(type) {
  const words = String(type || '').replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Something';
}

// Past-tense, plain phrases for the common actions. Anything unmapped says what it was, not an internal name.
function describeAction(type, input = {}) {
  const feed = ACTION_WORDING[type]?.feed;
  return feed ? feed(input) : humanize(type);
}

function classifyAction(type) {
  return READ_ONLY.test(type) ? 'checked' : 'did';
}

function eventsFromActionLog(rows = []) {
  const events = [];
  for (const row of rows) {
    const logged = parseLogged(row);
    const type = clean(logged?.type, 80);
    const at = validDate(row?.created_at);
    if (!type || !at || NOT_ACTIVITY.has(type)) continue;
    const status = String(row?.status || logged?.status || '').toLowerCase();
    if (status === 'pending') continue; // waiting on the user: it surfaces as "asked"
    const failed = status === 'failed';
    const detail = failed
      ? clean(row?.error || logged?.error, 140)
      : clean(logged?.resultText, 140);
    events.push({
      id: `action-${row.id || `${at.getTime()}-${type}`}`,
      type: classifyAction(type),
      title: describeAction(type, logged?.input || {}),
      detail: detail || null,
      at: at.toISOString(),
      failed
    });
  }
  return events;
}

function eventsFromNotices(rows = []) {
  const events = [];
  for (const row of rows) {
    if (!NOTICE_CATEGORIES.has(String(row?.category || '').toLowerCase())) continue;
    const at = validDate(row?.created_at);
    const title = clean(row?.title, 120);
    if (!at || !title) continue;
    events.push({
      id: `notice-${row.id || at.getTime()}`,
      type: 'noticed',
      title,
      detail: clean(row?.body, 140) || null,
      at: at.toISOString(),
      failed: false
    });
  }
  return events;
}

// Durable work that finished (or couldn't). Chat turns never reach here: they are filtered upstream.
function eventsFromFinishedWork(completed = []) {
  return completed.filter(item => item?.at && item?.title).map(item => ({
    id: item.id || `work-${item.at}`,
    type: 'did',
    title: clean(item.title, 120),
    detail: clean(item.detail, 140) || null,
    at: new Date(item.at).toISOString(),
    failed: item.failed === true,
    workflowId: item.workflowId || null
  }));
}

function eventsFromAsks({ approvals = [], needsYou = [] } = {}) {
  const asks = [];
  for (const approval of approvals) {
    const subject = clean(approval?.detail || approval?.taskGoal || approval?.actionType, 120);
    if (!subject) continue;
    asks.push({
      id: `ask-${approval.approvalId || subject}`,
      type: 'asked',
      title: subject,
      detail: 'Waiting for your yes',
      at: validDate(approval.createdAt)?.toISOString() || null,
      failed: false,
      open: true
    });
  }
  for (const item of needsYou) {
    if (!item?.checkpointId) continue; // a promise you made is not Adam asking
    asks.push({
      id: `ask-${item.checkpointId}`,
      type: 'asked',
      title: clean(item.prompt || item.title, 120),
      detail: 'Waiting for your yes',
      at: validDate(item.at)?.toISOString() || null,
      failed: false,
      open: true,
      workflowId: item.workflowId || null
    });
  }
  return asks;
}

// A scheduled time in the past is not "upcoming". It is reported as stale, never as a date to wait for.
function upcomingFromSchedules(rows = [], now = new Date()) {
  const upcoming = [];
  for (const row of rows) {
    if (row?.active === false) continue;
    const title = clean(row?.title, 120);
    if (!title) continue;
    const next = validDate(row?.next_run_at || row?.nextRunAt);
    const stale = !next || next.getTime() < now.getTime() - STALE_AFTER_MS;
    upcoming.push({
      id: `scheduled-${row.id || title}`,
      type: 'scheduled',
      title,
      detail: clean(row?.recurrence, 40) || null,
      at: stale ? null : next.toISOString(),
      failed: false,
      stale
    });
  }
  return upcoming;
}

function collapse(events) {
  const kept = [];
  for (const event of events) {
    const last = kept[kept.length - 1];
    const sameKind = last && last.type === event.type && last.title === event.title && last.failed === event.failed;
    if (sameKind && Math.abs(Date.parse(last.at) - Date.parse(event.at)) <= COLLAPSE_WINDOW_MS) continue;
    kept.push(event);
  }
  return kept;
}

function buildActivityFeed({
  actionRows = [], noticeRows = [], scheduledRows = [], approvals = [], board = {}, now = new Date(), limit = 60
} = {}) {
  const dated = [
    ...eventsFromActionLog(actionRows),
    ...eventsFromNotices(noticeRows),
    ...eventsFromFinishedWork(board.completed)
  ].filter(event => Date.parse(event.at) <= now.getTime() + 60 * 1000)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const asks = eventsFromAsks({ approvals, needsYou: board.needsYou });
  const seen = new Set();
  const events = collapse(dated).filter(event => !seen.has(event.id) && seen.add(event.id)).slice(0, limit);

  return {
    generatedAt: now.toISOString(),
    events,
    asks,
    upcoming: upcomingFromSchedules(scheduledRows, now)
  };
}

module.exports = {
  TYPES,
  classifyAction,
  describeAction,
  eventsFromActionLog,
  eventsFromNotices,
  upcomingFromSchedules,
  buildActivityFeed
};

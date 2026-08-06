const MAX_ITEMS = 3;
const MAX_TEXT = 240;
const MAX_REVIEW_BODY = 1200;
const LONDON_TIME_ZONE = 'Europe/London';

function cleanText(value, fallback = '', max = MAX_TEXT) {
  const text = String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return fallback;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function cleanReviewRecipient(value) {
  const text = String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 180) : '';
}

function cleanSender(value) {
  const raw = cleanText(value, 'Someone', 120);
  const named = raw.match(/^(.+?)\s*<.*>$/);
  if (named?.[1]?.trim()) return cleanText(named[1], 'Someone', 80);
  if (raw.includes('@')) return 'Someone';
  return raw;
}

function asDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatEventTime(date, now) {
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: LONDON_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
  const nowDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: LONDON_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
  if (today === nowDay) return `Today at ${local}`;

  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: LONDON_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(tomorrow);
  if (today === tomorrowDay) return `Tomorrow at ${local}`;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON_TIME_ZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

function describeEventTiming(date, now) {
  const minutes = Math.round((date.getTime() - now.getTime()) / 60000);
  if (minutes <= 0) return 'Starting now';
  if (minutes < 60) return `In ${minutes} minute${minutes === 1 ? '' : 's'}`;
  if (minutes < 24 * 60) {
    const hours = Math.round(minutes / 60);
    return `In ${hours} hour${hours === 1 ? '' : 's'} · ${formatEventTime(date, now)}`;
  }
  return formatEventTime(date, now);
}

function normalizeTask(task = {}) {
  const status = String(task.status || 'pending').toLowerCase();
  if (['completed', 'cancelled', 'recipe'].includes(status)) return null;
  const goal = cleanText(task.goal, 'Untitled goal', 180);
  const awaitingApproval = task.awaiting_approval === true || task.awaitingApproval === true;
  const failed = status === 'failed' || Boolean(task.last_error);
  const paused = status === 'paused';

  if (awaitingApproval) {
    return {
      id: `approval-task:${task.id || goal}`,
      kind: 'approval',
      title: goal,
      detail: 'This needs your OK before Millie can continue.',
      prompt: `Approve this: ${goal}`,
      urgency: 'now',
      priority: 94,
      taskId: task.id || null,
      sortTime: 0
    };
  }
  if (failed) {
    return {
      id: `goal:${task.id || goal}`,
      kind: 'goal',
      title: goal,
      detail: 'This needs your attention before Millie can continue.',
      prompt: `Help Millie continue: ${goal}`,
      urgency: 'soon',
      priority: 88,
      taskId: task.id || null,
      sortTime: 1
    };
  }
  if (paused || task.resumable === true) {
    return {
      id: `goal:${task.id || goal}`,
      kind: 'goal',
      title: goal,
      detail: 'Paused. Millie saved the progress and can continue.',
      prompt: `Continue this: ${goal}`,
      urgency: 'soon',
      priority: 82,
      taskId: task.id || null,
      sortTime: 2
    };
  }
  if (status === 'running') {
    return {
      id: `goal:${task.id || goal}`,
      kind: 'goal',
      title: goal,
      detail: 'Millie is still handling this.',
      prompt: `Show me the update: ${goal}`,
      urgency: 'background',
      priority: 48,
      taskId: task.id || null,
      sortTime: 3
    };
  }
  return {
    id: `goal:${task.id || goal}`,
    kind: 'goal',
    title: goal,
    detail: 'Ready to keep moving when you are.',
    prompt: `Start this task: ${goal}`,
    urgency: 'background',
    priority: 42,
    taskId: task.id || null,
    sortTime: 4
  };
}

function normalizeApproval(approval = {}) {
  const goal = cleanText(
    approval.taskGoal || approval.task_goal || approval.action?.input?.title,
    'A task needs your approval',
    180
  );
  const action = approval.action || {};
  const input = action.input || {};
  const actionType = cleanText(action.type, '', 80);
  const review = ['send_email', 'send_outlook_email'].includes(actionType)
    ? {
      action: actionType,
      recipient: cleanReviewRecipient(input.to || input.email || input.recipient) || null,
      subject: cleanText(input.subject, '', 180) || null,
      body: cleanText(input.body || input.message || input.content, '', MAX_REVIEW_BODY) || null
    }
    : ['send_message', 'send_telegram'].includes(actionType)
      ? {
        action: actionType,
        recipient: cleanReviewRecipient(input.contact) || null,
        body: cleanText(input.message || input.body || input.text, '', MAX_REVIEW_BODY) || null
      }
      : null;
  return {
    id: `approval:${approval.approvalId || approval.taskId || goal}`,
    kind: 'approval',
    title: goal,
    detail: 'This needs your OK before Millie can continue.',
    prompt: `Approve this: ${goal}`,
    urgency: 'now',
    priority: 100,
    taskId: approval.taskId || null,
    approvalId: approval.approvalId || null,
    review,
    sortTime: 0
  };
}

function normalizeEvent(event = {}, now) {
  const date = asDate(event.start?.dateTime || event.start?.date || event.start);
  if (!date || date.getTime() < now.getTime()) return null;
  const hours = (date.getTime() - now.getTime()) / (60 * 60 * 1000);
  if (hours > 48) return null;
  const title = cleanText(event.summary || event.title, 'Calendar event', 180);
  const timing = describeEventTiming(date, now);
  return {
    id: `calendar:${event.id || `${title}:${date.toISOString()}`}`,
    kind: 'calendar',
    title,
    detail: timing,
    prompt: `Help me prepare for ${title}`,
    urgency: hours <= 6 ? 'now' : 'soon',
    priority: hours <= 2 ? 84 : hours <= 6 ? 78 : hours <= 24 ? 68 : 56,
    sortTime: date.getTime()
  };
}

function normalizeEmail(email = {}, index = 0) {
  const subject = cleanText(email.subject, 'A message needs a look', 180);
  const summary = cleanText(email.summary, '', 210);
  const cta = cleanText(email.cta, '', 30).toLowerCase();
  const summaryLooksInformational = /nothing needed|nothing to do|for your information|just letting you know/i.test(summary);
  if (cta === 'ignore' || summaryLooksInformational) return null;
  const sender = cleanSender(email.from);
  const detail = summary || `${sender} may be waiting on you.`;
  return {
    id: `message:${email.messageId || `${sender}:${subject}:${index}`}`,
    kind: 'message',
    title: subject,
    detail,
    prompt: `Handle this message from ${sender}: ${subject}`,
    urgency: 'soon',
    priority: cta ? 62 : 55,
    sortTime: asDate(email.date)?.getTime() || Number.MAX_SAFE_INTEGER
  };
}

function normalizeScheduledTask(task = {}, now = new Date()) {
  const title = cleanText(task.title, 'Something Millie is watching', 180);
  const schedule = task.condition
    ? `Until ${cleanText(task.condition, 'a change', 120)}.`
    : task.next_run_at
      ? `Next check ${formatEventTime(asDate(task.next_run_at) || now, now)}.`
      : 'Millie is watching this.';
  return {
    id: `watch:${task.id || title}`,
    kind: 'watch',
    title,
    detail: schedule,
    prompt: `Update me on ${title}`,
    urgency: 'background',
    priority: 40,
    sortTime: asDate(task.next_run_at)?.getTime() || Number.MAX_SAFE_INTEGER
  };
}

function itemSort(a, b) {
  return b.priority - a.priority || a.sortTime - b.sortTime || a.title.localeCompare(b.title);
}

function dedupeItems(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.taskId ? `task:${item.taskId}` : item.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function publicItem(item) {
  const output = {
    id: item.id,
    kind: item.kind,
    title: cleanText(item.title, 'Something needs your attention', 180),
    detail: cleanText(item.detail, '', 220),
    urgency: item.urgency,
    prompt: cleanText(item.prompt, '', 220)
  };
  if (item.taskId) output.taskId = String(item.taskId);
  if (item.approvalId) output.approvalId = String(item.approvalId);
  if (item.review) output.review = item.review;
  return output;
}

function buildLifeBriefing({ tasks = [], approvals = [], emails = [], events = [], scheduledTasks = [], now = new Date() } = {}) {
  const reference = asDate(now) || new Date();
  const taskItems = tasks.map(normalizeTask).filter(Boolean);
  const approvalItems = approvals.map(normalizeApproval).filter(Boolean);
  const eventItems = events.map(event => normalizeEvent(event, reference)).filter(Boolean);
  const emailItems = emails.map(normalizeEmail).filter(Boolean);
  const scheduledItems = scheduledTasks.map(task => normalizeScheduledTask(task, reference)).filter(Boolean);
  const items = dedupeItems([
    ...approvalItems,
    ...taskItems,
    ...eventItems,
    ...emailItems,
    ...scheduledItems
  ]).sort(itemSort).slice(0, MAX_ITEMS).map(publicItem);

  const headline = items.length === 0
    ? 'Nothing pressing right now.'
    : items.length === 1
      ? 'One thing needs your attention.'
      : `${items.length} things need your attention.`;

  return {
    headline,
    items,
    empty: items.length === 0,
    generatedAt: reference.toISOString(),
    coverage: {
      goals: tasks.length > 0,
      approvals: approvals.length > 0,
      messages: emails.length > 0,
      calendar: events.length > 0,
      watches: scheduledTasks.length > 0
    }
  };
}

function formatLifeBriefing(briefing) {
  if (!briefing || briefing.empty || !briefing.items?.length) {
    return 'Nothing pressing right now. I’ll keep an eye on what’s moving.';
  }
  const parts = briefing.items.map((item, index) =>
    `${index + 1}. ${item.title} — ${item.detail}`
  );
  return `${briefing.headline} ${parts.join(' ')}`;
}

module.exports = {
  MAX_ITEMS,
  buildLifeBriefing,
  formatLifeBriefing,
  normalizeTask,
  normalizeApproval,
  normalizeEvent,
  normalizeEmail,
  normalizeScheduledTask
};

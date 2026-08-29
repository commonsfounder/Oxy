'use strict';

// Inbox actions. The service modules are called as properties, never destructured, so the
// orchestration tests can monkey-patch them on the shared module object. dailyDigestAction
// carries its suffix so it can't shadow the dailyDigest service its body calls.

const googleConnector = require('../../connectors/google');
const agentApprovals = require('../services/agent-approval-runtime');
const dailyDigest = require('../services/daily-digest');
const watches = require('../services/watches');
const commitments = require('../services/commitments');
const scheduledTasks = require('../services/scheduled-tasks');
const {
  buildCleanupQuery,
  classifyForCleanup,
  dedupeSendersForUnsubscribe,
  senderLabel: cleanupSenderLabel,
  summarizeCleanupResult
} = require('../services/gmail-cleanup');
const {
  isObviouslyNoReplyNeeded,
  latestMessagePerThread,
  buildReplyNeededPrompt,
  parseReplyNeededResponse,
  formatReplyNeededSummary
} = require('../services/reply-needed');

// Orchestrates real Gmail search + the shared triage classifier (emailTriageSignals,
// not a second parallel one) + the real archive/unsubscribe mutation primitives in
// connectors/google.js. See api/services/gmail-cleanup.js for the pure decision logic.
async function cleanInbox({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, FAST_MODEL, dispatch, generateBrain, emailTriageSignals, gatherCalendarContext, reconcileCommitmentsForSentEmail, executeAction } = deps;
  const { sender, since, before, query, unsubscribe_senders } = params || {};
  const searchQuery = buildCleanupQuery({ sender, since, before, query });
  const cap = Math.max(1, Math.min(Number(params?.max_results) || 300, 500));

  const searchResult = await dispatch(userId, 'search_emails', { query: searchQuery, max_results: cap });
  if (!searchResult?.success) {
    return { success: false, error: searchResult?.error || 'Could not search your inbox for that.' };
  }
  const emails = searchResult.emails || [];
  if (!emails.length) {
    return { success: true, archived: 0, preserved: 0, unsubscribed: [], text: 'Nothing matched that in your inbox — there was nothing to clean up.' };
  }

  const classified = emails.map(email => {
    const signal = emailTriageSignals(email, '');
    return { email, signal, decision: classifyForCleanup(email, signal) };
  });
  const toArchive = classified.filter(c => c.decision.archive);
  const preservedCount = classified.length - toArchive.length;

  let archived = 0;
  let archiveFailed = 0;
  if (toArchive.length) {
    const archiveResult = await dispatch(userId, 'archive_emails', { message_ids: toArchive.map(c => c.email.id) });
    archived = archiveResult?.modified || 0;
    archiveFailed = (archiveResult?.failed || []).length;
  }

  const unsubscribed = [];
  const unsubscribeFailed = [];
  const needsBrowserUnsubscribe = [];
  if (unsubscribe_senders !== false) {
    const targets = dedupeSendersForUnsubscribe(toArchive.filter(c => c.decision.unsubscribeCandidate));
    for (const target of targets) {
      const result = await dispatch(userId, 'unsubscribe_email', { message_id: target.email.id });
      const label = cleanupSenderLabel(target.email);
      if (result?.success) unsubscribed.push({ sender: label, method: result.method });
      else if (result?.needsBrowser) needsBrowserUnsubscribe.push({ sender: label, url: result.url });
      else unsubscribeFailed.push({ sender: label, reason: result?.error || 'unknown error' });
    }
  }

  const text = summarizeCleanupResult({
    scanned: emails.length,
    archived,
    archiveFailed,
    preservedCount,
    unsubscribed,
    unsubscribeFailed,
    needsBrowserUnsubscribe
  });
  return {
    success: true,
    scanned: emails.length,
    archived,
    archiveFailed,
    preserved: preservedCount,
    unsubscribed,
    unsubscribeFailed,
    needsBrowserUnsubscribe,
    text
  };
}

// "Who's waiting on me?" — a thread-level judgment, distinct from emailTriageSignals'
// message-level one, so it has its own classifier in api/services/reply-needed.js.
async function findReplyNeeded({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, FAST_MODEL, dispatch, generateBrain, emailTriageSignals, gatherCalendarContext, reconcileCommitmentsForSentEmail, executeAction } = deps;
  const maxThreads = Math.max(1, Math.min(Number(params?.max_threads) || 20, 40));
  const searchResult = await dispatch(userId, 'search_emails', { query: 'in:inbox', max_results: 100 });
  if (!searchResult?.success) {
    return { success: false, error: searchResult?.error || 'Could not search your inbox.' };
  }
  const emails = searchResult.emails || [];
  const latestPerThread = latestMessagePerThread(emails).filter(email => !isObviouslyNoReplyNeeded(email));
  const candidates = latestPerThread.slice(0, maxThreads);

  if (!candidates.length) {
    return { success: true, items: [], text: formatReplyNeededSummary([]) };
  }

  const threadContexts = [];
  for (const email of candidates) {
    try {
      const thread = await googleConnector.getThreadContext(userId, email.threadId);
      threadContexts.push({
        threadId: email.threadId,
        senderName: email.senderName,
        senderAddress: email.senderAddress,
        subject: email.subject,
        date: email.date,
        threadText: thread?.text || email.body || email.snippet || ''
      });
    } catch {
      // A thread we can't fetch can't be judged — skip it rather than guessing.
    }
  }
  if (!threadContexts.length) {
    return { success: true, items: [], text: formatReplyNeededSummary([]) };
  }

  let items = [];
  try {
    const prompt = buildReplyNeededPrompt(threadContexts, {});
    const judgment = await generateBrain({ model: FAST_MODEL, contents: [{ role: 'user', parts: [{ text: prompt }] }], config: {} });
    items = parseReplyNeededResponse(judgment.text || '', threadContexts);
  } catch (e) {
    return { success: false, error: `Could not judge which threads need a response: ${e.message}` };
  }

  return {
    success: true,
    items,
    scanned: emails.length,
    threadsConsidered: threadContexts.length,
    text: formatReplyNeededSummary(items)
  };
}

async function dailyDigestAction({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, FAST_MODEL, dispatch, generateBrain, emailTriageSignals, gatherCalendarContext, reconcileCommitmentsForSentEmail, executeAction } = deps;
  const focusRaw = String(params?.focus || 'all').trim().toLowerCase();
  const focus = ['urgent', 'can_wait', 'all'].includes(focusRaw) ? focusRaw : 'all';
  const now = new Date();
  const coverage = {};

  const watchSince = new Date(now.getTime() - dailyDigest.WATCH_UPDATE_MAX_AGE_HOURS * 3600000).toISOString();
  const [replyResult, occasionResult, commitmentResult, scheduledResult, watchResult, calendarEvents, approvalResult] = await Promise.all([
    // Real thread-level judgment, not a stored list — someone may have replied since
    // yesterday, in which case they correctly drop off today's digest.
    executeAction(userId, 'find_reply_needed', { max_threads: 15 }).catch(e => ({ success: false, error: e.message })),
    executeAction(userId, 'find_occasions', {}).catch(e => ({ success: false, error: e.message })),
    supabase.from('commitments').select('*').eq('user_id', userId).eq('status', 'open').limit(50),
    scheduledTasks.listScheduledTasks(userId).catch(e => ({ success: false, error: e.message })),
    supabase.from('briefings')
      .select('id, kind, title, body, metadata, read, created_at')
      .eq('user_id', userId)
      .eq('kind', 'scheduled_task')
      // Unread only: once the user has seen a parcel update it stops being news, which
      // is also what makes a resolved item disappear from the next run.
      .eq('read', false)
      .gte('created_at', watchSince)
      .order('created_at', { ascending: false })
      .limit(20),
    gatherCalendarContext(userId).catch(() => []),
    agentApprovals.listPendingApprovals(supabase, userId).catch(e => ({ approvals: [], error: e.message }))
  ]);

  if (replyResult?.success) coverage.email = { ok: true };
  else coverage.email = { ok: false, reason: replyResult?.error || 'your inbox was unreachable' };
  if (scheduledResult?.success) coverage.reminders = { ok: true };
  else coverage.reminders = { ok: false, reason: scheduledResult?.error || 'reminders were unreachable' };
  coverage.calendar = calendarEvents?.length ? { ok: true } : { ok: true, empty: true };
  if (watchResult?.error) coverage.watches = { ok: false, reason: watchResult.error.message || 'watch updates were unreachable' };

  const scheduledList = scheduledResult?.tasks || [];
  // A recurring digest is itself a scheduled task whose run writes a briefing row.
  // Without this its own output would show up in tomorrow's digest as something on the
  // user's plate.
  const digestTaskIds = new Set(
    scheduledList.filter(task => String(task.instruction || '').includes(dailyDigest.DIGEST_MARKER)).map(task => task.id)
  );
  const watchUpdates = (watchResult?.data || []).filter(row => !digestTaskIds.has(row?.metadata?.scheduledTaskId));

  const digest = dailyDigest.buildDailyDigest({
    replyNeeded: replyResult?.items || [],
    occasions: occasionResult?.items || [],
    commitments: commitmentResult?.data || [],
    scheduledTasks: scheduledList,
    watchUpdates,
    calendarEvents: calendarEvents || [],
    approvals: approvalResult?.approvals || [],
    coverage,
    focus,
    now
  });

  return { success: true, ...digest };
}

// Sending is where a promise becomes real. Everything about commitments used to depend on
// the user separately telling Adam "track this" — looksLikeCommitment and
// matchesSentEvidence existed, were unit-tested, and were called from nowhere. So the
// send is intercepted here: the message goes out first, and only a send Gmail actually
// accepted is allowed to change what the user is on the hook for.
async function sendEmail({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, FAST_MODEL, dispatch, generateBrain, emailTriageSignals, gatherCalendarContext, reconcileCommitmentsForSentEmail, executeAction } = deps;
  const result = await dispatch(userId, 'send_email', enrichedParams);
  // A failed send promises nothing and discharges nothing. This is the rule that stops
  // "I tried to send it" from ever reading as done.
  if (!result?.success) return result;

  try {
    const bookkeeping = await reconcileCommitmentsForSentEmail(userId, {
      to: result.to || enrichedParams?.to || enrichedParams?.email || enrichedParams?.recipient,
      subject: result.subject || enrichedParams?.subject,
      body: enrichedParams?.body || enrichedParams?.message || enrichedParams?.content,
      threadId: result.threadId,
      messageId: result.messageId
    });
    if (bookkeeping.captured) result.commitmentCaptured = bookkeeping.captured;
    if (bookkeeping.resolved.length) result.commitmentsResolved = bookkeeping.resolved;
  } catch (err) {
    // The email really did go. Failing to file it must not turn a successful send into a
    // reported failure.
    console.warn('[commitments] post-send bookkeeping failed:', err.message);
  }
  return result;
}

module.exports = {
  handlers: {
    clean_inbox: cleanInbox,
    find_reply_needed: findReplyNeeded,
    daily_digest: dailyDigestAction,
    send_email: sendEmail
  }
};

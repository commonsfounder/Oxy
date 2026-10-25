'use strict';

// Where things go wrong: sorts failed steps into plain causes and counts them per action.
// Works on rows already in action_log (and on live /chat results), so it needs no new table.

const CAUSES = [
  ['bot_wall', /bot wall|blocking automated access|access denied|blocked by our security/i],
  ['blank_page', /blank page/i],
  ['error_page', /site's own error page|error page/i],
  ['control_missing', /not on the current page|no longer on the page|could not find (?:the )?(?:element|control)/i],
  ['timeout', /timed? ?out|timeout|took too long|aborted/i],
  ['not_connected', /not connected|connect (?:it|your|the)|reconnect|sign in again|no connector|not configured|isn'?t set up/i],
  ['needs_you', /need(?:s)? your|enable location|waiting for (?:your )?approval|needs? (?:a )?review/i],
  ['rate_limited', /rate limit|too many requests|\b429\b/i],
  ['provider_down', /\b5\d\d\b|upstream|provider|overloaded|service unavailable/i],
  ['bad_input', /requires|missing|invalid|needs? at least/i],
];

function causeOf(error) {
  const text = String(error || '');
  if (!text) return 'unknown';
  const hit = CAUSES.find(([, pattern]) => pattern.test(text));
  return hit ? hit[0] : 'other';
}

const FAILED_OUTCOMES = new Set(['failed', 'unavailable']);

// One step from a live /chat result: { action, result: { outcome, success, error }, input }.
function stepFrom(entry) {
  const result = entry?.result || {};
  const failed = FAILED_OUTCOMES.has(result.outcome) || (result.outcome == null && result.success === false);
  return {
    action: entry?.action || 'unknown',
    ok: !failed,
    outcome: result.outcome || (result.success ? 'completed' : 'failed'),
    cause: failed ? causeOf(result.error) : null,
    error: failed ? String(result.error || '').slice(0, 200) : null,
    input: entry?.input ? JSON.stringify(entry.input).slice(0, 200) : null,
  };
}

function summarizeTurn(actions) {
  const steps = (Array.isArray(actions) ? actions : []).map(stepFrom);
  const firstFailure = steps.find((step) => !step.ok) || null;
  return { steps, failures: steps.filter((step) => !step.ok).length, firstFailure };
}

function actionName(row) {
  const raw = row?.action;
  if (raw && typeof raw === 'object') return raw.type || raw.action || 'unknown';
  if (typeof raw === 'string') {
    try { const parsed = JSON.parse(raw); return parsed.type || parsed.action || raw; } catch { return raw; }
  }
  return 'unknown';
}

// Rows from action_log: { action, status, error, created_at }.
function buildFailureReport(rows, { days = 7, now = new Date() } = {}) {
  const since = now.getTime() - days * 86400000;
  const recent = (rows || []).filter((row) => {
    const at = new Date(row.created_at).getTime();
    return Number.isFinite(at) && at >= since && ['executed', 'failed'].includes(row.status);
  });
  const byAction = new Map();
  const byCause = {};
  for (const row of recent) {
    const name = actionName(row);
    const entry = byAction.get(name) || { action: name, total: 0, failed: 0, causes: {}, lastError: null };
    entry.total += 1;
    if (row.status === 'failed') {
      const cause = causeOf(row.error);
      entry.failed += 1;
      entry.causes[cause] = (entry.causes[cause] || 0) + 1;
      entry.lastError = String(row.error || '').slice(0, 160) || entry.lastError;
      byCause[cause] = (byCause[cause] || 0) + 1;
    }
    byAction.set(name, entry);
  }
  const actions = [...byAction.values()]
    .map((entry) => ({ ...entry, failureRate: entry.total ? Number((entry.failed / entry.total).toFixed(2)) : 0 }))
    .sort((a, b) => b.failed - a.failed || b.total - a.total);
  return {
    days,
    total: recent.length,
    failed: recent.filter((row) => row.status === 'failed').length,
    byCause,
    actions,
  };
}

module.exports = { causeOf, stepFrom, summarizeTurn, buildFailureReport, CAUSES };

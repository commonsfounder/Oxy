const crypto = require('crypto');
const { actionDisplayName } = require('./user-facing-copy');

const APPROVAL_TABLE = 'agent_runtime_approvals';
const APPROVAL_STATES = new Set(['pending', 'claimed', 'approved', 'cancelled', 'failed']);
const MAX_TEXT = 1200;
const MAX_GOAL = 240;
const MAX_ACTION_BYTES = 32000;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'approve', 'approved', 'are', 'can', 'confirm', 'confirmed',
  'do', 'for', 'go', 'it', 'me', 'now', 'okay', 'ok', 'please', 'proceed',
  'send', 'sure', 'that', 'the', 'this', 'to', 'yes', 'yeah', 'yep', 'yup'
]);

function cleanText(value, fallback = '', max = MAX_TEXT) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, max) : fallback;
}

function cleanNullableText(value, max = MAX_TEXT) {
  const text = cleanText(value, '', max);
  return text || null;
}

function cloneForStorage(value, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return typeof value === 'string' ? value.slice(0, MAX_TEXT * 4) : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 80).map(entry => cloneForStorage(entry, depth + 1));
  if (typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, entry]) => [
    cleanText(key, 'field', 120),
    cloneForStorage(entry, depth + 1)
  ]));
}

function normalizeAction(action = {}) {
  const normalized = {
    type: cleanText(action.type, '', 160),
    input: cloneForStorage(action.input || {})
  };
  if (action._toolCallId) normalized._toolCallId = cleanText(action._toolCallId, '', 180);
  return normalized.type ? normalized : null;
}

function actionPayload(action) {
  const payload = { action: normalizeAction(action) };
  let encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, 'utf8') <= MAX_ACTION_BYTES) return payload;

  // Review records are internal execution state, but they must still be bounded. Keep the
  // action shape intact and trim only oversized string fields rather than allowing a model
  // response to create an unbounded database row.
  const trimmed = normalizeAction(action) || { type: 'unknown', input: {} };
  const input = trimmed.input && typeof trimmed.input === 'object' && !Array.isArray(trimmed.input)
    ? { ...trimmed.input }
    : {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') input[key] = value.slice(0, 4000);
  }
  trimmed.input = input;
  const fallback = { action: trimmed, truncated: true };
  encoded = JSON.stringify(fallback);
  if (Buffer.byteLength(encoded, 'utf8') <= MAX_ACTION_BYTES) return fallback;

  return {
    action: { type: trimmed.type, input: {} },
    truncated: true
  };
}

function isMissingTable(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || error?.details || '').toLowerCase();
  return code === '42P01' || code === 'PGRST205' || /relation .*agent_runtime_approvals.*does not exist|could not find the table/.test(message);
}

function approvalRow(userId, input = {}) {
  const action = normalizeAction(input.action);
  if (!action) throw new Error('A review approval needs an action.');
  const payload = actionPayload(action);
  return {
    id: input.approvalId || crypto.randomUUID(),
    user_id: cleanText(userId, '', 240),
    task_id: cleanNullableText(input.taskId, 120),
    session_id: cleanNullableText(input.sessionId, 120),
    task_goal: cleanNullableText(input.taskGoal, MAX_GOAL),
    action_type: action.type,
    action_payload: payload,
    user_message: cleanNullableText(input.userMessage, MAX_TEXT),
    location: input.location ? cloneForStorage(input.location) : null,
    native_hints: input.nativeHints ? cloneForStorage(input.nativeHints) : null,
    status: 'pending',
    created_at: input.createdAt || new Date().toISOString()
  };
}

function normalizeApproval(row) {
  if (!row) return null;
  const payload = row.action_payload || {};
  const action = normalizeAction(payload.action || payload);
  if (!action) return null;
  return {
    approvalId: row.id || null,
    taskId: row.task_id || null,
    sessionId: row.session_id || null,
    taskGoal: cleanText(row.task_goal, '', MAX_GOAL) || null,
    action,
    createdAt: row.created_at || null,
    userMessage: cleanText(row.user_message, '', MAX_TEXT),
    location: row.location || null,
    nativeHints: row.native_hints || null,
    storage: 'runtime'
  };
}

function tokenize(value) {
  return [...new Set(String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])]
    .filter(token => !STOP_WORDS.has(token));
}

function approvalSummary(approval) {
  const actionType = actionDisplayName(cleanText(approval?.action?.type, 'action', 100));
  return {
    approvalId: approval?.approvalId || null,
    taskId: approval?.taskId || null,
    taskGoal: cleanText(approval?.taskGoal, '', 120) || null,
    actionType,
    createdAt: approval?.createdAt || null
  };
}

function selectPendingApproval(approvals = [], message = '') {
  const valid = approvals.filter(Boolean);
  if (valid.length <= 1) return valid[0] || null;

  const tokens = tokenize(message);
  if (!tokens.length) return { ambiguous: true, approvals: valid.map(approvalSummary) };

  const ranked = valid.map(approval => {
    const haystack = tokenize([
      approval.taskGoal,
      approval.userMessage,
      approval.action?.type,
      approval.action?.input?.title,
      approval.action?.input?.subject,
      approval.action?.input?.to,
      approval.action?.input?.repo
    ].filter(Boolean).join(' '));
    const score = tokens.reduce((total, token) => total + (haystack.includes(token) ? (token.length >= 6 ? 2 : 1) : 0), 0);
    return { approval, score };
  }).sort((a, b) => b.score - a.score);

  if (ranked[0].score > 0 && ranked[0].score > ranked[1].score) return ranked[0].approval;
  return { ambiguous: true, approvals: valid.map(approvalSummary) };
}

function describeAmbiguousApprovals(approvals = []) {
  const labels = approvals.map((approval, index) => {
    const goal = cleanText(approval.taskGoal, '', 90);
    const action = cleanText(approval.actionType, 'action', 80);
    return `${index + 1}. ${goal || action}`;
  });
  if (!labels.length) return 'I have more than one approval waiting. Tell me which task to handle.';
  return `I have more than one approval waiting:\n${labels.join('\n')}\nTell me which task to approve or cancel.`;
}

async function createApproval(supabase, userId, input = {}) {
  const row = approvalRow(userId, input);
  const result = await supabase.from(APPROVAL_TABLE)
    .insert(row)
    .select('*')
    .single();
  if (result.error) return { available: false, error: result.error, missingTable: isMissingTable(result.error) };
  return { available: true, approval: normalizeApproval(result.data || row) };
}

async function listPendingApprovals(supabase, userId) {
  const result = await supabase.from(APPROVAL_TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(20);
  if (result.error) return { available: false, error: result.error, missingTable: isMissingTable(result.error), approvals: [] };
  return { available: true, approvals: (result.data || []).map(normalizeApproval).filter(Boolean) };
}

async function claimApproval(supabase, userId, approvalId) {
  if (!approvalId) return false;
  const result = await supabase.from(APPROVAL_TABLE)
    .update({ status: 'claimed', claimed_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('id', approvalId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  return !result.error && Boolean(result.data?.id);
}

async function settleApproval(supabase, userId, approvalId, status) {
  if (!approvalId || !APPROVAL_STATES.has(status) || status === 'pending' || status === 'claimed') return false;
  const result = await supabase.from(APPROVAL_TABLE)
    .update({ status, settled_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('id', approvalId)
    .eq('status', 'claimed')
    .select('id')
    .maybeSingle();
  return !result.error && Boolean(result.data?.id);
}

async function restoreApproval(supabase, userId, approvalId) {
  if (!approvalId) return false;
  const result = await supabase.from(APPROVAL_TABLE)
    .update({ status: 'pending', claimed_at: null, settled_at: null })
    .eq('user_id', userId)
    .eq('id', approvalId)
    .eq('status', 'claimed')
    .select('id')
    .maybeSingle();
  return !result.error && Boolean(result.data?.id);
}

module.exports = {
  APPROVAL_TABLE,
  APPROVAL_STATES,
  approvalRow,
  normalizeApproval,
  approvalSummary,
  actionPayload,
  isMissingTable,
  selectPendingApproval,
  describeAmbiguousApprovals,
  createApproval,
  listPendingApprovals,
  claimApproval,
  settleApproval,
  restoreApproval
};

'use strict';

// A failed action deserves a later interruption only when there is a concrete step that
// requires the person. The rule is expressed in recovery vocabulary shared by every action,
// never in a list of task domains. Transient/provider failures remain Adam's responsibility;
// validation failures stay in the turn where they happened.

const USER_RECOVERY_TYPES = new Set(['open_connector_settings', 'reauth_login']);
const DEFAULT_MAX_AGE_MS = 90 * 60 * 1000;
const notifications = require('./notifications');
const { actionDisplayName } = require('./user-facing-copy');

function clean(value, fallback = '', max = 180) {
  const text = String(value ?? '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return fallback;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function cleanIdentifier(value, max = 80) {
  const text = String(value || '').trim();
  return /^[a-z0-9._-]+$/i.test(text) ? text.slice(0, max) : '';
}

function boundedRecoveryAction(value = {}) {
  const type = cleanIdentifier(value?.type, 64);
  if (!type) return null;
  const action = { type };
  const connectorId = cleanIdentifier(value.connectorId, 64);
  const site = cleanIdentifier(value.site, 120);
  if (connectorId) action.connectorId = connectorId;
  if (site) action.site = site;
  return action;
}

// Persist only the recovery decision needed after the turn. Never duplicate an action's
// input, connector payload, URL, credentials, or arbitrary provider error into this field.
function recoverySnapshot(result = {}) {
  if (result.success !== false) return null;
  const action = boundedRecoveryAction(result.recoveryAction);
  const snapshot = {
    cardText: clean(result.cardText || result.actionSummary),
    retryable: result.retryable === true,
    healthStatus: cleanIdentifier(result.healthStatus, 64),
    action
  };
  return snapshot.cardText || snapshot.retryable || snapshot.healthStatus || snapshot.action
    ? snapshot
    : null;
}

function parseLoggedAction(row = {}) {
  const raw = row.action;
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw || '{}')) || {};
  } catch {
    return {};
  }
}

function legacyRecovery(error) {
  const detail = String(error || '');
  if (/permission|PERMISSION_DENIED|REQUEST_DENIED|access denied/i.test(detail)) {
    return { type: 'open_connector_settings', reason: 'permission' };
  }
  if (/not connected|not configured|not authorized|authenticate|reconnect|expired|revoked|missing refresh token/i.test(detail)) {
    return { type: 'open_connector_settings', reason: 'connection' };
  }
  return null;
}

function buildActionFollowUp(row = {}, { actionLabel = 'Action' } = {}) {
  const payload = parseLoggedAction(row);
  if (String(row.status || payload.status || '').toLowerCase() !== 'failed') return null;

  const actionType = cleanIdentifier(payload.type || payload.action, 100) || 'action';
  const snapshot = payload.recovery && typeof payload.recovery === 'object' ? payload.recovery : {};
  const recoveryAction = boundedRecoveryAction(snapshot.action) || legacyRecovery(payload.error || row.error);
  if (!recoveryAction || !USER_RECOVERY_TYPES.has(recoveryAction.type)) return null;

  const label = clean(actionLabel, 'Action', 100);
  let body = clean(snapshot.cardText);
  if (recoveryAction.type === 'reauth_login') {
    body = body || `${label} needs you to sign in again before Adam can finish it.`;
  } else if (recoveryAction.reason === 'permission' || snapshot.healthStatus === 'permission_blocked') {
    body = body || `${label} needs its permission restored in Settings before Adam can finish it.`;
  } else {
    body = body || `${label} needs its connection restored in Settings before Adam can finish it.`;
  }

  return {
    actionType,
    title: `${label} needs you`,
    body,
    recoveryAction,
    sourceRef: {
      actionLogId: row.id || null,
      actionType,
      recoveryType: recoveryAction.type,
      ...(recoveryAction.connectorId ? { connectorId: recoveryAction.connectorId } : {}),
      ...(recoveryAction.site ? { site: recoveryAction.site } : {})
    }
  };
}

async function raiseRecentActionFollowUp({
  userId,
  failures = [],
  raise,
  now = new Date(),
  maxAgeMs = DEFAULT_MAX_AGE_MS
} = {}) {
  if (typeof raise !== 'function') throw new TypeError('raiseRecentActionFollowUp requires raise');

  for (const row of failures) {
    const failedAt = new Date(row?.created_at).getTime();
    if (Number.isNaN(failedAt) || now.getTime() - failedAt > maxAgeMs || failedAt > now.getTime()) continue;

    const payload = parseLoggedAction(row);
    const actionType = cleanIdentifier(payload.type || payload.action, 100) || 'action';
    const followUp = buildActionFollowUp(row, { actionLabel: actionDisplayName(actionType) });
    if (!followUp) continue;

    const event = {
      category: 'action_required',
      urgency: notifications.gradeUrgency({ category: 'action_required' }),
      title: followUp.title,
      body: followUp.body,
      dedupeKey: notifications.dedupeKeyFor({ category: 'action_required', state: row.id }),
      sourceRef: followUp.sourceRef
    };
    const raised = await raise(userId, event);
    // A duplicate may be the newest failure every sweep. Continue through the bounded list
    // so an older, distinct recovery need is not permanently hidden behind it.
    if (raised?.ok && raised.created) return { type: 'action_required', text: followUp.body, event };
  }
  return null;
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  USER_RECOVERY_TYPES,
  boundedRecoveryAction,
  buildActionFollowUp,
  parseLoggedAction,
  raiseRecentActionFollowUp,
  recoverySnapshot
};

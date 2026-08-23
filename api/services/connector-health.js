const { adapterForAction } = require('./action-catalog');

// Compatibility export for callers that still import this name. Ownership is read from the
// executable contract; there is no second action-to-connector table to drift.
const ACTION_CONNECTOR = new Proxy({}, {
  get: (_target, actionType) => {
    if (typeof actionType !== 'string') return undefined;
    return adapterForAction(actionType)?.kind === 'connector'
      ? adapterForAction(actionType).id
      : undefined;
  }
});

function connectorForAction(actionType) {
  const adapter = adapterForAction(actionType);
  return adapter?.kind === 'connector' ? adapter.id : null;
}

function diagnoseConnectorIssue(action, result = {}) {
  const connectorId = connectorForAction(action?.type || action?.action);
  if (!connectorId || result.success !== false) return {};

  const error = String(result.error || '').trim();
  if (!error) return { connectorId, healthStatus: 'failed' };

  if (/not connected|not configured|not authorized|authenticate|reconnect|expired|revoked|missing refresh token/i.test(error)) {
    return {
      connectorId,
      healthStatus: 'needs_reconnect',
      recoveryAction: { type: 'open_connector_settings', connectorId },
      cardText: `Reconnect ${humanConnectorName(connectorId)} in Settings.`,
      retryable: true
    };
  }

  if (/permission|PERMISSION_DENIED|REQUEST_DENIED|access denied|current rail data permissions/i.test(error)) {
    return {
      connectorId,
      healthStatus: 'permission_blocked',
      recoveryAction: { type: 'open_connector_settings', connectorId },
      cardText: `Check ${humanConnectorName(connectorId)} permissions.`,
      retryable: true
    };
  }

  if (/timeout|timed out|ECONNRESET|ENOTFOUND|EAI_AGAIN|network|temporarily unavailable|rate limit|429|5\d\d/i.test(error)) {
    return {
      connectorId,
      healthStatus: 'temporarily_unavailable',
      recoveryAction: { type: 'retry_action', action },
      cardText: `${humanConnectorName(connectorId)} is temporarily unavailable. Try again.`,
      retryable: true
    };
  }

  return {
    connectorId,
    healthStatus: 'failed'
  };
}

function humanConnectorName(connectorId) {
  switch (connectorId) {
    case 'google': return 'Google';
    case 'maps': return 'Maps';
    case 'uber': return 'Uber';
    case 'telegram': return 'Telegram';
    case 'trainline': return 'Trainline';
    case 'github': return 'GitHub';
    case 'microsoft': return 'Outlook';
    case 'notion': return 'Notion';
    case 'youtube': return 'YouTube';
    case 'indeed': return 'Indeed';
    case 'linkedin': return 'LinkedIn';
    case 'spotify': return 'Spotify';
    case 'linear': return 'Linear';
    default: return connectorId ? connectorId.replace(/_/g, ' ') : 'connector';
  }
}

module.exports = {
  ACTION_CONNECTOR,
  connectorForAction,
  diagnoseConnectorIssue,
  humanConnectorName
};

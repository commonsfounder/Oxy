const ACTION_CONNECTOR = {
  send_email: 'google',
  get_emails: 'google',
  search_emails: 'google',
  create_calendar_event: 'google',
  get_calendar_events: 'google',
  book_uber: 'uber',
  find_place: 'maps',
  get_directions: 'maps',
  send_telegram: 'telegram',
  get_telegram_contacts: 'telegram',
  search_trains: 'trainline',
  station_board: 'trainline',
  order_uber_eats: 'ubereats',
  order_deliveroo: 'deliveroo',
  search_netflix_title: 'netflix',
  add_to_netflix_list: 'netflix'
};

function connectorForAction(actionType) {
  return ACTION_CONNECTOR[actionType] || null;
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
    case 'ubereats': return 'Uber Eats';
    case 'deliveroo': return 'Deliveroo';
    case 'telegram': return 'Telegram';
    case 'trainline': return 'Trainline';
    case 'netflix': return 'Netflix';
    default: return connectorId ? connectorId.replace(/_/g, ' ') : 'connector';
  }
}

module.exports = {
  ACTION_CONNECTOR,
  connectorForAction,
  diagnoseConnectorIssue,
  humanConnectorName
};

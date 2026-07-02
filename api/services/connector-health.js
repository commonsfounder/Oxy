const ACTION_CONNECTOR = {
  send_email: 'google',
  get_emails: 'google',
  search_emails: 'google',
  create_calendar_event: 'google',
  get_calendar_events: 'google',
  book_uber: 'uber',
  find_place: 'maps',
  get_directions: 'maps',
  plan_trip: 'maps',
  send_telegram: 'telegram',
  get_telegram_contacts: 'telegram',
  search_trains: 'trainline',
  station_board: 'trainline',
  search_github: 'github',
  get_github_notifications: 'github',
  create_github_issue: 'github',
  comment_github_issue: 'github',
  send_outlook_email: 'microsoft',
  get_outlook_emails: 'microsoft',
  search_outlook_emails: 'microsoft',
  create_outlook_event: 'microsoft',
  get_outlook_events: 'microsoft',
  search_youtube: 'youtube',
  search_indeed_jobs: 'indeed',
  search_linkedin_jobs: 'linkedin',
  share_linkedin_post: 'linkedin',
  search_notion: 'notion',
  create_notion_page: 'notion',
  append_notion_page: 'notion',
  create_google_doc: 'google',
  search_google_docs: 'google',
  append_google_doc: 'google',
  get_google_doc: 'google',
  search_spotify: 'spotify',
  play_spotify: 'spotify',
  control_spotify_playback: 'spotify',
  add_to_spotify_queue: 'spotify',
  add_to_spotify_playlist: 'spotify',
  get_now_playing_spotify: 'spotify',
  search_linear_issues: 'linear',
  get_linear_issues: 'linear',
  create_linear_issue: 'linear',
  comment_linear_issue: 'linear'
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

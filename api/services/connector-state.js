'use strict';

// A connection that is switched on but has no login behind it cannot do anything, so it must
// not be shown as connected or offered to the model as a capability.

function hasCredentials(connectorId, tokens) {
  if (!tokens || typeof tokens !== 'object') return false;
  if (connectorId === 'google' || connectorId === 'microsoft') {
    return Boolean(tokens.refresh_token || tokens.session || tokens.encrypted);
  }
  return Object.values(tokens).some((value) => {
    if (value === null || value === undefined || value === '') return false;
    return !(typeof value === 'object' && !Object.keys(value).length);
  });
}

// `definition` is the entry from the connector catalogue; only account connections need a login.
function needsLogin(definition, enabled, tokens) {
  return Boolean(definition && definition.kind === 'connection' && enabled && !hasCredentials(definition.id, tokens));
}

module.exports = { hasCredentials, needsLogin };

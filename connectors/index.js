const {
  CONNECTOR_MODULES,
  getExecutableActionCatalog
} = require('../api/services/action-catalog');

// Connector modules are effectful at import time (some create a Supabase client), so only
// their paths are loaded here. A module is required after an action has passed validation.
const moduleCache = new Map();
// Explicit test seam only. This does not own or advertise actions; production ownership
// remains the declared adapter passed into dispatch below.
const dispatchOverrides = {};

function loadConnector(connectorId) {
  const path = CONNECTOR_MODULES[connectorId];
  if (!path) return null;
  if (!moduleCache.has(connectorId)) moduleCache.set(connectorId, require(path));
  return moduleCache.get(connectorId);
}

function getConnector(connectorId) {
  const connector = loadConnector(connectorId);
  return connector;
}

async function dispatch(connectorId, userId, action, params) {
  if (dispatchOverrides[action]) return dispatchOverrides[action].execute(userId, action, params);
  if (!CONNECTOR_MODULES[connectorId]) {
    return { success: false, outcome: 'unavailable', unavailable: true, error: 'That capability is not available yet. No action was taken.' };
  }
  const connector = getConnector(connectorId);
  if (typeof connector?.execute !== 'function') {
    throw new Error(`Connector ${connectorId} does not export execute`);
  }
  return connector.execute(userId, action, params);
}

// A module existing on disk is not enough to advertise it as an executable connector:
// only named adapters referenced by an executable contract count. Inline handoffs such as
// Apple Music intentionally do not make the Spotify connector a second owner.
const IMPLEMENTED_CONNECTORS = new Set(getExecutableActionCatalog()
  .filter(action => action.adapter.kind === 'connector')
  .map(action => action.adapter.id));

module.exports = {
  CONNECTOR_MODULES,
  dispatchOverrides,
  IMPLEMENTED_CONNECTORS,
  getConnector,
  loadConnector,
  dispatch
};

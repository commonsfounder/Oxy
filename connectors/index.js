const google = require('./google');

// Registry: action name → connector module
// To add a new connector: create connectors/myservice.js and register its actions here
const registry = {};

for (const action of google.SUPPORTED_ACTIONS) {
  registry[action] = google;
}

// Set of connector IDs that have a live implementation
const IMPLEMENTED_CONNECTORS = new Set(['google']);

async function dispatch(userId, action, params) {
  const connector = registry[action];
  if (!connector) return { success: false, error: `No connector registered for action: ${action}` };
  return connector.execute(userId, action, params);
}

module.exports = { dispatch, registry, IMPLEMENTED_CONNECTORS };

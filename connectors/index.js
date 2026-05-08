const google = require('./google');
const uber = require('./uber');
const { executeTool } = require('../api/tools');

// Registry: action name → connector module
// To add a new connector: create connectors/myservice.js and register its actions here
const registry = {};

for (const action of google.SUPPORTED_ACTIONS) {
  registry[action] = google;
}

for (const action of uber.SUPPORTED_ACTIONS) {
  registry[action] = uber;
}

// Set of connector IDs that have a live implementation
const IMPLEMENTED_CONNECTORS = new Set(['google', 'uber']);

async function dispatch(userId, action, params) {
  const connector = registry[action];
  if (connector) return connector.execute(userId, action, params);
  // Fall back to tools (send_message, make_call, create_reminder, play_music, etc.)
  return executeTool(action, params);
}

module.exports = { dispatch, registry, IMPLEMENTED_CONNECTORS };

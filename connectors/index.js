const google = require('./google');
const uber = require('./uber');
const telegram = require('./telegram');
const trainline = require('./trainline');

// Registry: action name → connector module
// To add a new connector: create connectors/myservice.js and register its actions here
const registry = {};

for (const action of google.SUPPORTED_ACTIONS) registry[action] = google;
for (const action of uber.SUPPORTED_ACTIONS) registry[action] = uber;
for (const action of telegram.SUPPORTED_ACTIONS) registry[action] = telegram;
for (const action of trainline.SUPPORTED_ACTIONS) registry[action] = trainline;

// Set of connector IDs that have a live implementation
const IMPLEMENTED_CONNECTORS = new Set(['google', 'uber', 'telegram', 'trainline']);

async function dispatch(userId, action, params) {
  const connector = registry[action];
  if (connector) return connector.execute(userId, action, params);
  return { success: false, error: `No connector registered for action: ${action}` };
}

module.exports = { dispatch, registry, IMPLEMENTED_CONNECTORS };

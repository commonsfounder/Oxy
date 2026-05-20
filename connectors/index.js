const google = require('./google');
const uber = require('./uber');
const ubereats = require('./ubereats');
const deliveroo = require('./deliveroo');
const netflix = require('./netflix');
const telegram = require('./telegram');
const trainline = require('./trainline');

// Registry: action name → connector module
// To add a new connector: create connectors/myservice.js and register its actions here
// Use Object.create(null) to prevent prototype pollution (no inherited properties)
const registry = Object.create(null);

for (const action of google.SUPPORTED_ACTIONS) registry[action] = google;
for (const action of uber.SUPPORTED_ACTIONS) registry[action] = uber;
for (const action of ubereats.SUPPORTED_ACTIONS) registry[action] = ubereats;
for (const action of deliveroo.SUPPORTED_ACTIONS) registry[action] = deliveroo;
for (const action of netflix.SUPPORTED_ACTIONS) registry[action] = netflix;
for (const action of telegram.SUPPORTED_ACTIONS) registry[action] = telegram;
for (const action of trainline.SUPPORTED_ACTIONS) registry[action] = trainline;

// Set of connector IDs that have a live implementation
const IMPLEMENTED_CONNECTORS = new Set(['google', 'uber', 'ubereats', 'deliveroo', 'netflix', 'telegram', 'trainline']);

async function dispatch(userId, action, params) {
  if (!Object.prototype.hasOwnProperty.call(registry, action)) {
    return { success: false, error: `No connector registered for action: ${action}` };
  }
  const connector = registry[action];
  return connector.execute(userId, action, params);
}

module.exports = { dispatch, registry, IMPLEMENTED_CONNECTORS };

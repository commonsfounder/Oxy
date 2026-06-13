const google = require('./google');
const uber = require('./uber');
const ubereats = require('./ubereats');
const deliveroo = require('./deliveroo');
const netflix = require('./netflix');
const telegram = require('./telegram');
const trainline = require('./trainline');
const maps = require('./maps');
const github = require('./github');
const microsoft = require('./microsoft');
const notion = require('./notion');
const youtube = require('./youtube');
const indeed = require('./indeed');
const linkedin = require('./linkedin');
const spotify = require('./spotify');
const linear = require('./linear');

// Registry: action name → connector module
// To add a new connector: create connectors/myservice.js and add it to this list.
const MODULES = {
  google, uber, ubereats, deliveroo, netflix, telegram, trainline, maps,
  github, microsoft, notion, youtube, indeed, linkedin, spotify, linear
};

const registry = {};
for (const mod of Object.values(MODULES)) {
  for (const action of mod.SUPPORTED_ACTIONS) registry[action] = mod;
}

const IMPLEMENTED_CONNECTORS = new Set(Object.keys(MODULES));

async function dispatch(userId, action, params) {
  const connector = registry[action];
  if (connector) return connector.execute(userId, action, params);
  return { success: false, error: `No connector registered for action: ${action}` };
}

module.exports = { dispatch, registry, IMPLEMENTED_CONNECTORS };

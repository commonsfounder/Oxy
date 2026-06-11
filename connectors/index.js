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
// To add a new connector: create connectors/myservice.js and register its actions here
const registry = {};

for (const action of google.SUPPORTED_ACTIONS) registry[action] = google;
for (const action of uber.SUPPORTED_ACTIONS) registry[action] = uber;
for (const action of ubereats.SUPPORTED_ACTIONS) registry[action] = ubereats;
for (const action of deliveroo.SUPPORTED_ACTIONS) registry[action] = deliveroo;
for (const action of netflix.SUPPORTED_ACTIONS) registry[action] = netflix;
for (const action of telegram.SUPPORTED_ACTIONS) registry[action] = telegram;
for (const action of trainline.SUPPORTED_ACTIONS) registry[action] = trainline;
for (const action of maps.SUPPORTED_ACTIONS) registry[action] = maps;
for (const action of github.SUPPORTED_ACTIONS) registry[action] = github;
for (const action of microsoft.SUPPORTED_ACTIONS) registry[action] = microsoft;
for (const action of notion.SUPPORTED_ACTIONS) registry[action] = notion;
for (const action of youtube.SUPPORTED_ACTIONS) registry[action] = youtube;
for (const action of indeed.SUPPORTED_ACTIONS) registry[action] = indeed;
for (const action of linkedin.SUPPORTED_ACTIONS) registry[action] = linkedin;
for (const action of spotify.SUPPORTED_ACTIONS) registry[action] = spotify;
for (const action of linear.SUPPORTED_ACTIONS) registry[action] = linear;

// Set of connector IDs that have a live implementation
const IMPLEMENTED_CONNECTORS = new Set(['google', 'uber', 'ubereats', 'deliveroo', 'netflix', 'telegram', 'trainline', 'maps', 'github', 'microsoft', 'notion', 'youtube', 'indeed', 'linkedin', 'spotify', 'linear']);

async function dispatch(userId, action, params) {
  const connector = registry[action];
  if (connector) return connector.execute(userId, action, params);
  return { success: false, error: `No connector registered for action: ${action}` };
}

module.exports = { dispatch, registry, IMPLEMENTED_CONNECTORS };

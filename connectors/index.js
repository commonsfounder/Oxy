const google = require('./google');
const microsoft = require('./microsoft');
const uber = require('./uber');
const telegram = require('./telegram');
const trainline = require('./trainline');
const maps = require('./maps');
const spotify = require('./spotify');
const notion = require('./notion');
const github = require('./github');
const stripe = require('./stripe');
const weather = require('./weather');
const amazon = require('./amazon');
const slack = require('./slack');
const lyft = require('./lyft');
const strava = require('./strava');
const oura = require('./oura');
const flights = require('./flights');
const hotels = require('./hotels');
const stocks = require('./stocks');

// Registry: action name → connector module
// To add a new connector: create connectors/myservice.js and register its actions here
const registry = {};

for (const action of google.SUPPORTED_ACTIONS) registry[action] = google;
for (const action of microsoft.SUPPORTED_ACTIONS) registry[action] = microsoft;
for (const action of uber.SUPPORTED_ACTIONS) registry[action] = uber;
for (const action of telegram.SUPPORTED_ACTIONS) registry[action] = telegram;
for (const action of trainline.SUPPORTED_ACTIONS) registry[action] = trainline;
for (const action of maps.SUPPORTED_ACTIONS) registry[action] = maps;
for (const action of spotify.SUPPORTED_ACTIONS) registry[action] = spotify;
for (const action of notion.SUPPORTED_ACTIONS) registry[action] = notion;
for (const action of github.SUPPORTED_ACTIONS) registry[action] = github;
for (const action of stripe.SUPPORTED_ACTIONS) registry[action] = stripe;
for (const action of weather.SUPPORTED_ACTIONS) registry[action] = weather;
for (const action of amazon.SUPPORTED_ACTIONS) registry[action] = amazon;
for (const action of slack.SUPPORTED_ACTIONS) registry[action] = slack;
for (const action of lyft.SUPPORTED_ACTIONS) registry[action] = lyft;
for (const action of strava.SUPPORTED_ACTIONS) registry[action] = strava;
for (const action of oura.SUPPORTED_ACTIONS) registry[action] = oura;
for (const action of flights.SUPPORTED_ACTIONS) registry[action] = flights;
for (const action of hotels.SUPPORTED_ACTIONS) registry[action] = hotels;
for (const action of stocks.SUPPORTED_ACTIONS) registry[action] = stocks;

// Real API connectors (actual server actions)
const REAL_API_CONNECTORS = new Set(['google', 'microsoft', 'telegram', 'maps', 'notion', 'github', 'stripe', 'weather', 'slack', 'strava', 'oura', 'flights', 'hotels', 'stocks']);

// Handoff / convenience connectors (open apps with prefill - still useful for consumer)
const HANDOFF_CONNECTORS = new Set(['uber', 'trainline', 'spotify', 'lyft', 'amazon']);

// All "implemented" for UI purposes
const IMPLEMENTED_CONNECTORS = new Set([...REAL_API_CONNECTORS, ...HANDOFF_CONNECTORS]);

async function dispatch(userId, action, params) {
  const connector = registry[action];
  if (connector) return connector.execute(userId, action, params);
  return { success: false, error: `No connector registered for action: ${action}` };
}

module.exports = { dispatch, registry, IMPLEMENTED_CONNECTORS };

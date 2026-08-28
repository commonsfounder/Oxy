'use strict';

// Action handler registry. A handler is async ({ userId, action, params, enrichedParams,
// context, deps }); deps carries index.js's Supabase client and services so tests can fake them.

const travel = require('./travel');
const people = require('./people');
const project = require('./project');
const calendar = require('./calendar');
const scheduled = require('./scheduled');
const display = require('./display');
const responsibilities = require('./responsibilities');
const messaging = require('./messaging');
const browser = require('./browser');
const email = require('./email');
const money = require('./money');
const media = require('./media');
const appointments = require('./appointments');
const assistant = require('./assistant');

const MODULES = [travel, people, project, calendar, scheduled, display, responsibilities, messaging, browser, email, money, media, appointments, assistant];

const handlers = Object.create(null);
for (const mod of MODULES) {
  for (const [name, handler] of Object.entries(mod.handlers)) {
    if (handlers[name]) throw new Error(`Duplicate action handler registered: ${name}`);
    handlers[name] = handler;
  }
}

function handlerFor(action) {
  return handlers[action] || null;
}

module.exports = { handlerFor, handlers };

'use strict';

// Action handler registry.
//
// api/index.js grew a single 2,600-line `switch (action)` covering 77 actions across a
// dozen unrelated domains. Every new capability made that one function longer and riskier
// to touch. Handlers now live in a module per domain and register themselves here.
//
// The switch in executeActionRaw is still the fallback for actions that have not been
// moved yet, so migration is one domain at a time with the suite green in between rather
// than one enormous rewrite.
//
// Contract: a handler is `async ({ userId, action, params, enrichedParams, context, deps })`
// and returns the same result shape the switch branch returned. `deps` carries what
// index.js owns -- the Supabase client, shared service modules, and constants -- so a
// handler never builds a second database client and tests can still inject fakes.

const travel = require('./travel');
const people = require('./people');
const project = require('./project');
const calendar = require('./calendar');
const scheduled = require('./scheduled');
const display = require('./display');
const responsibilities = require('./responsibilities');
const messaging = require('./messaging');

const MODULES = [travel, people, project, calendar, scheduled, display, responsibilities, messaging];

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

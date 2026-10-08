'use strict';

// Every action is defined in one place and worded in others. This fails when an action is added
// to one layer and forgotten in another, or when a wording table keeps a name that no longer exists.

const assert = require('node:assert/strict');
const test = require('node:test');

// Requiring the handlers loads connectors that build clients at import time.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.OXY_SESSION_SECRET = process.env.OXY_SESSION_SECRET || 'test-session-secret';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';

const { ACTION_CONTRACTS } = require('../../api/action-contracts');
const { handlers } = require('../../api/actions');
const { getConnectorDefinition } = require('../../api/services/action-catalog');
const { PROGRESS_LINES } = require('../../api/services/progress-lines');
const { ACTION_NAMES } = require('../../api/services/user-facing-copy');

const types = Object.keys(ACTION_CONTRACTS);
const visible = types.filter(type => ACTION_CONTRACTS[type].modelVisible !== false);

function report(label, names) {
  return `${label}:\n  ${names.join('\n  ')}`;
}

test('every inline action has a handler, every other action has a known connector', () => {
  const broken = types.filter(type => {
    const adapter = ACTION_CONTRACTS[type].adapter;
    if (adapter?.kind === 'inline') return typeof handlers[type] !== 'function';
    if (adapter?.kind === 'connector') return !getConnectorDefinition(adapter.id);
    return true;
  });
  assert.deepEqual(broken, [], report('actions with no way to run', broken));
});

test('no handler exists for an action that has no contract', () => {
  const orphans = Object.keys(handlers).filter(type => !ACTION_CONTRACTS[type]);
  assert.deepEqual(orphans, [], report('handlers without a contract', orphans));
});

test('every action has a progress line, and no progress line names a missing action', () => {
  const missing = types.filter(type => typeof PROGRESS_LINES[type] !== 'function');
  const stale = Object.keys(PROGRESS_LINES).filter(type => !ACTION_CONTRACTS[type]);
  assert.deepEqual(missing, [], report('actions with no progress line', missing));
  assert.deepEqual(stale, [], report('progress lines for missing actions', stale));
});

test('no display name is kept for an action that no longer exists', () => {
  const stale = Object.keys(ACTION_NAMES).filter(type => !ACTION_CONTRACTS[type]);
  assert.deepEqual(stale, [], report('display names for missing actions', stale));
});

test('every model-visible action says its risk, its confirmation rule and its outcome wording', () => {
  const gaps = visible.filter(type => {
    const c = ACTION_CONTRACTS[type];
    return !c.risk || !c.confirmation || !c.successSummary || !c.failureSummary;
  });
  assert.deepEqual(gaps, [], report('actions missing risk, confirmation or summaries', gaps));
});

const assert = require('node:assert/strict');
const test = require('node:test');

const { CONNECTORS } = require('../../api/index');

// Regression guard: `kind` distinguishes a genuine external-account connection (real OAuth or
// personal token) from a functionality (server-key API, deep-link handoff, in-app plumbing).
// The Connections screen filters on this — a wrong/missing kind silently mislabels an entry.
const REAL_CONNECTIONS = new Set(['google', 'microsoft', 'telegram', 'notion', 'github', 'slack', 'strava', 'oura']);

test('every CONNECTORS entry has a kind of connection or functionality', () => {
  for (const c of CONNECTORS) {
    assert.ok(['connection', 'functionality'].includes(c.kind), `${c.id} has an invalid/missing kind: ${c.kind}`);
  }
});

test('only the confirmed real external-account connections are classified as kind: connection', () => {
  const actual = new Set(CONNECTORS.filter(c => c.kind === 'connection').map(c => c.id));
  assert.deepEqual(actual, REAL_CONNECTIONS);
});

test('money/finance plumbing (concierge account, Stripe) is a functionality, not a connection', () => {
  const stripe = CONNECTORS.find(c => c.id === 'stripe');
  const concierge = CONNECTORS.find(c => c.id === 'concierge_account');
  assert.equal(stripe.kind, 'functionality');
  assert.equal(concierge.kind, 'functionality');
});

const assert = require('node:assert/strict');
const test = require('node:test');

const { aggregateEntityReferenceStats } = require('../../api/services/session-events');

test('aggregateEntityReferenceStats counts bare vs named and resolution/routing rates', () => {
  const rows = [
    { detail: { kind: 'bare', resolved: true, routedDirectly: true } },
    { detail: { kind: 'bare', resolved: true, routedDirectly: false } },
    { detail: { kind: 'bare', resolved: false, routedDirectly: false } },
    { detail: { kind: 'named', resolved: true, routedDirectly: true } }
  ];
  const stats = aggregateEntityReferenceStats(rows);
  assert.equal(stats.total, 4);
  assert.equal(stats.bare, 3);
  assert.equal(stats.named, 1);
  assert.equal(stats.resolved, 3);
  assert.equal(stats.resolvedRate, 0.75);
  assert.equal(stats.routedDirectly, 2);
  assert.equal(stats.routedDirectlyRateOfResolved, 2 / 3);
});

test('aggregateEntityReferenceStats handles no events without dividing by zero', () => {
  const stats = aggregateEntityReferenceStats([]);
  assert.deepEqual(stats, {
    total: 0,
    bare: 0,
    named: 0,
    resolved: 0,
    resolvedRate: 0,
    routedDirectly: 0,
    routedDirectlyRateOfResolved: 0
  });
});

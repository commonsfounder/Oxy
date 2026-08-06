const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveTaskReference } = require('../../api/services/task-context');

const tasks = [
  { id: 'website', goal: 'Build the Milgrain website landing page', status: 'paused', updated_at: '2026-08-05T09:00:00Z' },
  { id: 'flights', goal: 'Watch for cheaper flights to Turkey', status: 'paused', updated_at: '2026-08-05T10:00:00Z' }
];

test('task continuity resolves an explicit follow-up to the matching paused goal', () => {
  assert.equal(resolveTaskReference(tasks, 'Continue the website work').id, 'website');
});

test('task continuity resolves a bare continuation only when one goal exists', () => {
  assert.equal(resolveTaskReference([tasks[0]], 'Keep going').id, 'website');
  assert.equal(resolveTaskReference(tasks, 'Keep going'), null);
});

test('task continuity never silently attaches an ordinary new request', () => {
  assert.equal(resolveTaskReference([tasks[0]], 'Find me a good laptop under £1000'), null);
});

test('task continuity will not resume an approval-paused or running task', () => {
  assert.equal(resolveTaskReference([{ ...tasks[0], status: 'running' }], 'Continue the website work'), null);
  assert.equal(resolveTaskReference([{ ...tasks[0], metadata: { awaitingApproval: true } }], 'Continue the website work'), null);
});

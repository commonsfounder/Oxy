'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { stopWorkflow } = require('../../api/services/workflows');

function database(workflow, runs) {
  const writes = [];
  return {
    writes,
    from(table) {
      let patch = null;
      const result = () => {
        if (table === 'workflows' && patch) { Object.assign(workflow, patch); return { data: workflow, error: null }; }
        if (table === 'workflows') return { data: [workflow], error: null };
        if (table === 'agent_tasks') return { data: runs, error: null };
        return { data: { id: 'event' }, error: null };
      };
      const query = { then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject) };
      for (const method of ['select', 'eq', 'in', 'limit', 'order', 'single']) query[method] = () => query;
      query.update = next => { patch = next; writes.push([table, next]); return query; };
      query.insert = row => { writes.push([table, row]); return query; };
      return query;
    }
  };
}

test('stopping work cancels its runs and closes it as cancelled by the person', async () => {
  const workflow = { id: 'w1', user_id: 'u1', status: 'working', closed_at: null };
  const db = database(workflow, [{ id: 't1', status: 'running' }]);
  const cancelled = [];
  const saved = await stopWorkflow(db, 'u1', 'w1', { cancelTask: async id => cancelled.push(id) });
  assert.deepEqual(cancelled, ['t1']);
  assert.equal(saved.status, 'cancelled');
  assert.ok(saved.closed_at);
  assert.ok(db.writes.some(([table, row]) => table === 'workflow_events' && row.actor === 'user' && row.summary === 'You stopped this'));
});

test('stopping finished work changes nothing', async () => {
  const workflow = { id: 'w2', user_id: 'u1', status: 'completed', closed_at: '2026-10-01T00:00:00Z' };
  const db = database(workflow, []);
  const saved = await stopWorkflow(db, 'u1', 'w2', { cancelTask: async () => { throw new Error('should not run'); } });
  assert.equal(saved.status, 'completed');
  assert.equal(db.writes.length, 0);
});

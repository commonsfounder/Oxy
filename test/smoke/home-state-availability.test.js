'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { getHomeState } = require('../../api/services/home-state');

function database({ failedTable, rows = {} } = {}) {
  return {
    from(table) {
      const result = table === failedTable
        ? { data: null, error: { message: 'Source unavailable' } }
        : { data: rows[table] || [], error: null };
      const query = { then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
      for (const method of ['select', 'eq', 'order', 'limit', 'in', 'gt']) query[method] = () => query;
      return query;
    }
  };
}

test('an empty successful Home read is distinguishable from unavailable sources', async () => {
  const board = await getHomeState(database(), 'test-user');
  assert.deepEqual(board.unavailableSources, []);
  assert.deepEqual(board.counts, { needsYou: 0, handling: 0, changed: 0, completed: 0 });
});

test('database errors remain visible while independent Home work is preserved', async () => {
  for (const [failedTable, source] of [
    ['preferences', 'history'], ['workflows', 'workflows'],
    ['workflow_checkpoints', 'workflows'], ['workflow_events', 'workflows'],
    ['commitments', 'commitments']
  ]) {
    const board = await getHomeState(database({
      failedTable,
      rows: {
        workflows: [{ id: 'workflow-1', status: 'working', goal: 'Arrange a repair' }],
        agent_tasks: [{ id: 'task-1', status: 'running', goal: 'Find the receipt' }]
      }
    }), 'test-user');
    assert.deepEqual(board.unavailableSources, [source], failedTable);
    assert.ok(board.handling.some(item => item.taskId === 'task-1'), failedTable);
    assert.equal(JSON.stringify(board).includes('Source unavailable'), false);
  }
});

test('a failed task read does not become a successful empty task list', async () => {
  const board = await getHomeState(database({ failedTable: 'agent_tasks' }), 'test-user');
  assert.deepEqual(board.unavailableSources, ['tasks']);
});

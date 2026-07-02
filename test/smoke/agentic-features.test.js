const assert = require('node:assert/strict');
const test = require('node:test');

const taskManager = require('../../api/services/task-manager');
const { runAgentLoop, generatePlan, reflectOnResults } = require('../../api/services/agent-orchestrator');

test('agentic task manager module loads and has expected functions', () => {
  assert.ok(typeof taskManager.createTask === 'function');
  assert.ok(typeof taskManager.listTasks === 'function');
  assert.ok(typeof taskManager.getTask === 'function');
  assert.ok(typeof taskManager.updateTask === 'function');
});

test('agent orchestrator exports core agentic functions', () => {
  assert.ok(typeof runAgentLoop === 'function');
  assert.ok(typeof generatePlan === 'function');
  assert.ok(typeof reflectOnResults === 'function');
});

test('action contracts now include new agentic tools', () => {
  const { ACTION_CONTRACTS } = require('../../api/action-contracts');
  assert.ok(ACTION_CONTRACTS.web_browse);
  assert.ok(ACTION_CONTRACTS.calculate);
  assert.ok(ACTION_CONTRACTS.create_agent_task);
  assert.ok(ACTION_CONTRACTS.simulate_actions);
});

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
process.env.OXY_SESSION_SECRET = process.env.OXY_SESSION_SECRET || 'test-secret';

const projectRuntime = require('../../api/services/agent-project-runtime');
const { buildToolsForGemini, ACTION_CONTRACTS } = require('../../api/action-contracts');
const { connectorForAction } = require('../../api/services/connector-health');
const { executeAction } = require('../../api');

const real = { ...projectRuntime };

test('project actions are declared, local, and route through the isolated adapter', async t => {
  t.after(() => Object.assign(projectRuntime, real));

  const declarations = buildToolsForGemini(false)[0].functionDeclarations;
  const byName = Object.fromEntries(declarations.map(declaration => [declaration.name, declaration]));
  for (const name of ['project_status', 'project_diff', 'project_write', 'project_check', 'project_commit', 'project_rollback', 'project_sync']) {
    assert.ok(byName[name], `${name} must be declared to the model`);
    assert.equal(connectorForAction(name), null, `${name} must not depend on a connector`);
    assert.ok(ACTION_CONTRACTS[name]);
  }
  assert.deepEqual(byName.project_write.parameters.required, ['project_ref', 'path', 'content']);
  assert.deepEqual(byName.project_commit.parameters.required, ['project_ref', 'message']);
  for (const name of ['project_status', 'project_diff', 'project_check']) {
    assert.deepEqual(byName[name].parameters.required, [], `${name} must use configured task context`);
    assert.ok(byName[name].parameters.properties.project_ref, `${name} may still accept an explicit project reference`);
  }
  assert.equal(ACTION_CONTRACTS.project_rollback.executionMode, 'review');
  assert.equal(ACTION_CONTRACTS.project_sync.executionMode, 'review');

  const calls = [];
  projectRuntime.gitStatus = async (...args) => {
    calls.push(['status', ...args]);
    return { projectRef: 'adam', projectName: 'Adam', branch: 'oxy/task-123', dirty: false, files: [], truncated: false };
  };
  projectRuntime.gitDiff = async (...args) => {
    calls.push(['diff', ...args]);
    return { projectRef: 'adam', projectName: 'Adam', diff: 'diff --git a/README.md b/README.md', truncated: false };
  };
  projectRuntime.writeProjectFile = async (...args) => {
    calls.push(['write', ...args]);
    return { projectRef: 'adam', projectName: 'Adam', path: 'README.md', bytes: 12 };
  };
  projectRuntime.runProjectCheck = async (...args) => {
    calls.push(['check', ...args]);
    return { projectRef: 'adam', projectName: 'Adam', check: 'test', success: true, exitCode: 0, output: 'ok', timedOut: false };
  };
  projectRuntime.commitProjectChanges = async (...args) => {
    calls.push(['commit', ...args]);
    return { projectRef: 'adam', projectName: 'Adam', branch: 'oxy/task-123', commit: 'a'.repeat(40), message: 'Save work', text: 'Saved.' };
  };
  projectRuntime.rollbackProjectChanges = async (...args) => {
    calls.push(['rollback', ...args]);
    return { projectRef: 'adam', projectName: 'Adam', branch: 'oxy/task-123', text: 'Rolled back.' };
  };
  projectRuntime.publishProjectBranch = async (...args) => {
    calls.push(['sync', ...args]);
    return { projectRef: 'adam', projectName: 'Adam', branch: 'oxy/task-123', published: true, text: 'Synchronized.' };
  };

  const context = { persistedTaskId: 'task-123', projectRef: 'adam' };
  assert.equal((await executeAction('user-1', 'project_status', {}, context)).success, true);
  assert.equal((await executeAction('user-1', 'project_diff', {}, context)).success, true);
  assert.equal((await executeAction('user-1', 'project_write', { project_ref: 'adam', path: 'README.md', content: '# update' }, context)).success, true);
  assert.equal((await executeAction('user-1', 'project_check', { check: 'test' }, context)).success, true);
  assert.equal((await executeAction('user-1', 'project_commit', { project_ref: 'adam', message: 'Save work' }, context)).success, true);
  assert.equal((await executeAction('user-1', 'project_rollback', { project_ref: 'adam' }, { ...context, bypassReview: true })).success, true);
  assert.equal((await executeAction('user-1', 'project_sync', { project_ref: 'adam' }, { ...context, bypassReview: true })).success, true);
  assert.deepEqual(calls.map(call => call[0]), ['status', 'diff', 'write', 'check', 'commit', 'rollback', 'sync']);
  assert.ok(calls.every(call => call[1] === 'user-1' && call[2] === 'task-123' && call[3] === 'adam'));
});

test('project writes cannot detach from a durable task', async () => {
  let called = false;
  projectRuntime.writeProjectFile = async () => { called = true; };
  try {
    const result = await executeAction('user-1', 'project_write', {
      project_ref: 'adam',
      path: 'README.md',
      content: 'no task'
    });
    assert.equal(result.success, false);
    assert.match(result.error, /durable task/);
    assert.equal(called, false);
  } finally {
    Object.assign(projectRuntime, real);
  }
});

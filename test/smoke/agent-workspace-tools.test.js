const assert = require('node:assert/strict');
const test = require('node:test');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
process.env.OXY_SESSION_SECRET = process.env.OXY_SESSION_SECRET || 'test-secret';

/*
 * The seam that lets the model reach the workspace: a declared tool routed through executeAction
 * to the workspace service. index.js resolves `agentWorkspace.<fn>` at call time, so replacing
 * the exports here swaps the storage under the real code path — only the database is a double.
 */
const agentWorkspace = require('../../api/services/agent-workspace');
const agentRuntime = require('../../api/services/agent-runtime');
const { buildToolsForGemini, ACTION_CONTRACTS } = require('../../api/action-contracts');
const { connectorForAction } = require('../../api/services/connector-health');
const { executeAction } = require('../../api');

const real = { ...agentWorkspace };
const realRuntime = { ...agentRuntime };
function restore() {
  Object.assign(agentWorkspace, real);
  Object.assign(agentRuntime, realRuntime);
}

test('the workspace tools are declared to the model', () => {
  const decls = buildToolsForGemini(false)[0].functionDeclarations;
  const byName = Object.fromEntries(decls.map(d => [d.name, d]));

  for (const name of ['workspace_write', 'workspace_read', 'workspace_list']) {
    assert.ok(byName[name], `${name} must be declared or the model can never call it`);
    assert.ok(ACTION_CONTRACTS[name], `${name} needs a contract`);
  }
  assert.deepEqual(byName.workspace_write.parameters.required, ['path', 'content']);
  assert.deepEqual(byName.workspace_list.parameters.required, []);
});

test('the workspace tools are not gated behind a connector', () => {
  for (const name of ['workspace_write', 'workspace_read', 'workspace_list']) {
    assert.equal(connectorForAction(name), null, `${name} must not require a connector to be enabled`);
  }
});

test('workspace_write persists through to the workspace service', async (t) => {
  t.after(restore);
  const calls = [];
  agentWorkspace.writeWorkspaceFile = async (_db, userId, path, content, kind) => {
    calls.push({ userId, path, content, kind });
    return { path, version: 2, content };
  };

  const result = await executeAction('user-1', 'workspace_write', {
    path: 'research/laptops.md',
    content: 'Shortlist: three models under £1000.'
  });

  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, 'user-1');
  assert.equal(calls[0].path, 'research/laptops.md');
  assert.match(result.actionSummary, /research\/laptops\.md/);
});

test('workspace_write records a bounded artifact for a durable runtime session', async (t) => {
  t.after(restore);
  agentWorkspace.writeWorkspaceFile = async () => ({ id: 'file-1', path: 'projects/milgrain/brief.md', version: 3 });
  const calls = [];
  agentRuntime.writeFileArtifact = async (_db, userId, input) => {
    calls.push({ userId, input });
    return {
      file: { id: 'file-1', path: input.path, version: 3 },
      artifact: { id: 'artifact-1', kind: 'file', path: input.path, title: input.path, summary: 'Created artifact.', status: 'created' }
    };
  };

  const result = await executeAction('user-1', 'workspace_write', {
    path: 'projects/milgrain/brief.md',
    content: 'private project content'
  }, { runtimeSessionId: 'session-1', persistedTaskId: 'task-1' });

  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.sessionId, 'session-1');
  assert.equal(calls[0].input.taskId, 'task-1');
  assert.equal(result.artifact.id, 'artifact-1');
  assert.doesNotMatch(JSON.stringify(result), /private project content/);
});

test('workspace_write rejects a missing path or non-text content', async (t) => {
  t.after(restore);
  let called = false;
  agentWorkspace.writeWorkspaceFile = async () => { called = true; return {}; };

  const noPath = await executeAction('user-1', 'workspace_write', { content: 'x' });
  assert.equal(noPath.success, false);
  assert.match(noPath.error, /requires path/);

  const badContent = await executeAction('user-1', 'workspace_write', { path: 'a.md', content: { not: 'text' } });
  assert.equal(badContent.success, false);
  assert.match(badContent.error, /content as text/);
  assert.equal(called, false, 'invalid input must never reach storage');
});

test('a path-traversal attempt is refused before any database call', async (t) => {
  t.after(restore);
  // The REAL write path, so normalizeWorkspacePath is what actually decides. No supabase
  // double is supplied: if validation ever moves back behind ensureWorkspace, this test
  // fails on a live fetch instead of quietly passing.
  agentWorkspace.writeWorkspaceFile = real.writeWorkspaceFile;

  for (const path of ['../../etc/passwd', '/etc/passwd', '../outside.txt']) {
    const result = await executeAction('user-1', 'workspace_write', { path, content: 'nope' });
    assert.equal(result.success, false, `${path} must be refused`);
    assert.match(result.error, /Invalid workspace path/, `${path} rejected for the wrong reason`);
  }
});

test('an oversized write is refused before any database call', async (t) => {
  t.after(restore);
  agentWorkspace.writeWorkspaceFile = real.writeWorkspaceFile;
  const result = await executeAction('user-1', 'workspace_write', {
    path: 'big.md',
    content: 'x'.repeat(512 * 1024 + 1)
  });
  assert.equal(result.success, false);
  assert.match(result.error, /too large/);
});

test('workspace_read returns content, and says so plainly when there is none', async (t) => {
  t.after(restore);
  agentWorkspace.readWorkspaceFile = async (_db, _userId, path) =>
    path === 'notes.md' ? { path, content: 'saved earlier', version: 3 } : null;

  const found = await executeAction('user-1', 'workspace_read', { path: 'notes.md' });
  assert.equal(found.success, true);
  assert.equal(found.text, 'saved earlier');

  const missing = await executeAction('user-1', 'workspace_read', { path: 'ghost.md' });
  assert.equal(missing.success, false);
  assert.match(missing.error, /No workspace file at ghost\.md/);
});

test('workspace_list returns paths and sizes, never file contents', async (t) => {
  t.after(restore);
  agentWorkspace.listWorkspaceFiles = async () => ({
    workspace: { id: 'ws-1' },
    files: [
      { path: 'notes.md', kind: 'file', size_bytes: 12, updated_at: 't', content: 'SECRET BODY' },
      { path: 'research/laptops.md', kind: 'file', size_bytes: 40, updated_at: 't', content: 'MORE SECRET' }
    ]
  });

  const result = await executeAction('user-1', 'workspace_list', {});
  assert.equal(result.success, true);
  assert.equal(result.files.length, 2);
  assert.deepEqual(Object.keys(result.files[0]).sort(), ['bytes', 'kind', 'path', 'updatedAt']);
  assert.doesNotMatch(
    JSON.stringify(result),
    /SECRET/,
    'listing must not replay every file body into the next prompt'
  );
});

test('workspace_list reports an empty workspace in words the model can act on', async (t) => {
  t.after(restore);
  agentWorkspace.listWorkspaceFiles = async () => ({ workspace: { id: 'ws-1' }, files: [] });
  const result = await executeAction('user-1', 'workspace_list', {});
  assert.equal(result.success, true);
  assert.match(result.text, /empty/i);
});

test('a storage failure surfaces as a failed action, not a thrown request', async (t) => {
  t.after(restore);
  agentWorkspace.writeWorkspaceFile = async () => { throw new Error('database is down'); };
  const result = await executeAction('user-1', 'workspace_write', { path: 'a.md', content: 'x' });
  assert.equal(result.success, false);
  assert.match(result.error, /database is down/);
});

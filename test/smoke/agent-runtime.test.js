const assert = require('node:assert/strict');
const test = require('node:test');

const runtime = require('../../api/services/agent-runtime');

function fakeSupabase({ session = null, artifact = null } = {}) {
  const calls = [];
  const chainFor = (table) => {
    const state = { table, filters: {}, patch: null, insertRow: null };
    const chain = {
      select() { return chain; },
      eq(key, value) { state.filters[key] = value; return chain; },
      order() { return chain; },
      limit() { return chain; },
      maybeSingle() {
        if (state.table === 'agent_runtime_sessions') {
          return Promise.resolve({ data: session && Object.entries(state.filters).every(([k, v]) => session[k] === v) ? session : null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      insert(row) { state.insertRow = row; calls.push({ table, operation: 'insert', row }); return chain; },
      update(patch) { state.patch = patch; calls.push({ table, operation: 'update', patch }); return chain; },
      single() {
        if (state.table === 'agent_runtime_sessions') return Promise.resolve({ data: session || { id: 'session-1', ...state.insertRow }, error: null });
        return Promise.resolve({ data: artifact || { id: 'artifact-1', ...state.insertRow }, error: null });
      }
    };
    return chain;
  };
  return { calls, from: chainFor };
}

test('runtime session rows default to an ambient home device', () => {
  const row = runtime.runtimeSessionRow('user-1', { taskId: 'task-1', title: 'Battery issue' });
  assert.equal(row.device_type, 'ambient_home');
  assert.equal(row.kind, 'task');
  assert.equal(row.state, 'ready');
});

test('device types are normalized without preserving arbitrary model text', () => {
  assert.equal(runtime.normalizeDeviceType('Pendant'), 'ambient_home');
  assert.equal(runtime.normalizeDeviceType('ios_companion'), 'ios_companion');
  assert.equal(runtime.normalizeDeviceType('secret-device'), 'ambient_home');
});

test('artifact rows are bounded and never include file contents', () => {
  const row = runtime.artifactRow('user-1', {
    sessionId: 'session-1',
    taskId: 'task-1',
    kind: 'file',
    path: 'projects/milgrain/brief.md',
    title: 'Milgrain brief',
    summary: 'Created the project brief.',
    content: 'This must never be stored in the artifact receipt.'
  });
  assert.equal(row.path, 'projects/milgrain/brief.md');
  assert.equal(row.content, undefined);
  assert.ok(row.summary.length <= 600);
});

test('ensureSession reuses the task execution identity', async () => {
  const existing = {
    id: 'session-1',
    user_id: 'user-1',
    task_id: 'task-1',
    device_type: 'ambient_home',
    kind: 'task',
    state: 'running'
  };
  const db = fakeSupabase({ session: existing });
  const result = await runtime.ensureSession(db, 'user-1', { taskId: 'task-1' });
  assert.equal(result.id, 'session-1');
  assert.equal(db.calls.length, 0);
});

test('recordArtifact writes a receipt-shaped row', async () => {
  const db = fakeSupabase({ artifact: { id: 'artifact-1', kind: 'file', path: 'brief.md', summary: 'Created brief.' } });
  const result = await runtime.recordArtifact(db, 'user-1', {
    sessionId: 'session-1',
    taskId: 'task-1',
    kind: 'file',
    path: 'brief.md',
    summary: 'Created brief.'
  });
  assert.equal(result.id, 'artifact-1');
  assert.equal(db.calls[0].operation, 'insert');
  assert.equal(db.calls[0].row.content, undefined);
});

const assert = require('node:assert/strict');
const test = require('node:test');

const approvals = require('../../api/services/agent-approval-runtime');

function fakeSupabase() {
  const rows = [];
  let sequence = 0;
  const from = table => {
    const state = { table, filters: {}, insertRow: null, updatePatch: null, operation: null };
    const matches = row => Object.entries(state.filters).every(([key, value]) => row[key] === value);
    const chain = {
      select() { return chain; },
      eq(key, value) { state.filters[key] = value; return chain; },
      order() { return chain; },
      limit() { return Promise.resolve({ data: rows.filter(matches).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))), error: null }); },
      insert(row) { state.operation = 'insert'; state.insertRow = { ...row }; return chain; },
      update(patch) { state.operation = 'update'; state.updatePatch = patch; return chain; },
      single() {
        const row = { ...state.insertRow, id: state.insertRow.id || `approval-${++sequence}` };
        rows.push(row);
        return Promise.resolve({ data: row, error: null });
      },
      maybeSingle() {
        const row = rows.find(matches);
        if (!row || state.operation !== 'update') return Promise.resolve({ data: null, error: null });
        Object.assign(row, state.updatePatch);
        return Promise.resolve({ data: { id: row.id }, error: null });
      }
    };
    return chain;
  };
  return { rows, from };
}

const action = type => ({ type, input: { title: type === 'create_github_issue' ? 'Website battery issue' : 'Supplier quote' } });

test('approval rows retain task and runtime identity without unbounded payloads', () => {
  const row = approvals.approvalRow('user-1', {
    taskId: 'task-1',
    sessionId: 'session-1',
    taskGoal: 'Continue the website work',
    action: { type: 'send_email', input: { body: 'x'.repeat(100000) } }
  });
  assert.equal(row.user_id, 'user-1');
  assert.equal(row.task_id, 'task-1');
  assert.equal(row.session_id, 'session-1');
  assert.ok(Buffer.byteLength(JSON.stringify(row.action_payload), 'utf8') <= 32000);
});

test('multiple pending approvals do not overwrite each other or silently choose on yes', async () => {
  const db = fakeSupabase();
  await approvals.createApproval(db, 'user-1', {
    taskId: 'task-website',
    taskGoal: 'Continue the website work',
    action: action('create_github_issue')
  });
  await approvals.createApproval(db, 'user-1', {
    taskId: 'task-supplier',
    taskGoal: 'Ask the supplier for a quote',
    action: action('send_email')
  });

  const pending = await approvals.listPendingApprovals(db, 'user-1');
  assert.equal(pending.available, true);
  assert.equal(pending.approvals.length, 2);
  assert.equal(approvals.selectPendingApproval(pending.approvals, 'yes').ambiguous, true);
  assert.equal(approvals.selectPendingApproval(pending.approvals, 'approve the website work').taskId, 'task-website');
});

test('runtime approval claim is single-flight and settles only the claimed row', async () => {
  const db = fakeSupabase();
  const created = await approvals.createApproval(db, 'user-1', {
    taskId: 'task-1',
    action: action('send_email')
  });
  const id = created.approval.approvalId;
  assert.equal(await approvals.claimApproval(db, 'user-1', id), true);
  assert.equal(await approvals.claimApproval(db, 'user-1', id), false);
  assert.equal(await approvals.settleApproval(db, 'user-1', id, 'approved'), true);
  assert.equal(db.rows[0].status, 'approved');
  assert.equal(await approvals.restoreApproval(db, 'user-1', id), false);
});

test('missing approval table is detectable for the legacy fallback', () => {
  assert.equal(approvals.isMissingTable({ code: '42P01', message: 'relation "agent_runtime_approvals" does not exist' }), true);
  assert.equal(approvals.isMissingTable({ code: 'PGRST205', message: 'Could not find the table' }), true);
  assert.equal(approvals.isMissingTable({ code: '42501', message: 'permission denied' }), false);
});

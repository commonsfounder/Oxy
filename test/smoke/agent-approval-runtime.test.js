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

test('cross-device review selects only the exact owned task and never falls back', async () => {
  const db = fakeSupabase();
  const runtime = approvals.createApprovalRuntime(db);
  const first = await runtime.park('user-1', action('send_email'), { persistedTaskId: 'task-1' });
  await runtime.park('user-1', action('send_email'), { persistedTaskId: 'task-2' });
  const selection = { approvalId: first.approvalId, taskId: 'task-1' };
  assert.equal((await runtime.pending('user-1', 'yes', selection)).approvalId, first.approvalId);
  assert.equal(await runtime.pending('user-2', 'yes', selection), null);
  assert.equal(await runtime.pending('user-1', 'yes', { ...selection, taskId: 'task-2' }), null);
  assert.equal(await runtime.pending('user-1', 'yes', { ...selection, approvalId: 'expired' }), null);
  assert.equal(await runtime.claim('user-1', first), true);
  assert.equal(await runtime.claim('user-1', first), false);
  assert.equal(await runtime.pending('user-1', 'yes', selection), null);
});

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

test('contact-specific approval language selects among repeated action labels', () => {
  const pending = [
    {
      approvalId: 'arina-message',
      taskGoal: 'Message',
      userMessage: 'Message',
      action: { type: 'send_telegram', input: { contact: 'Arina', message: 'Hey Arina' } }
    },
    {
      approvalId: 'bob-message',
      taskGoal: 'Message',
      userMessage: 'Message',
      action: { type: 'send_telegram', input: { contact: 'Bob', message: 'Hi Bob' } }
    }
  ];
  assert.equal(approvals.selectPendingApproval(pending, 'approve the message to arina').approvalId, 'arina-message');
  assert.equal(approvals.approvalSummary(pending[0]).detail, 'Arina · Hey Arina');
  assert.match(
    approvals.describeAmbiguousApprovals(pending.map(approval => approvals.approvalSummary(approval))),
    /Message — Arina · Hey Arina/
  );
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

test('bound approval runtime owns park, selection, claim, and settlement', async () => {
  const db = fakeSupabase();
  const runtime = approvals.createApprovalRuntime(db, { now: () => new Date('2026-09-03T20:00:00.000Z') });

  const parked = await runtime.park('user-1', action('send_email'), {
    userMessage: 'Email the supplier for a quote',
    persistedTaskId: 'task-supplier',
    taskGoal: 'Ask the supplier for a quote'
  });
  assert.equal(parked.createdAt, '2026-09-03T20:00:00.000Z');

  const selected = await runtime.pending('user-1', 'approve the supplier email');
  assert.equal(selected.approvalId, parked.approvalId);
  assert.equal(await runtime.claim('user-1', selected), true);
  assert.equal(await runtime.settle('user-1', selected, 'approved'), true);
  assert.equal((await runtime.list('user-1')).length, 0);
});

test('bound approval runtime fails closed when durable approval storage is unavailable', async () => {
  const unavailable = new Error('approval database unavailable');
  const chain = {
    insert() { return chain; },
    select() { return chain; },
    eq() { return chain; },
    order() { return chain; },
    single: async () => ({ data: null, error: unavailable }),
    limit: async () => ({ data: null, error: unavailable })
  };
  const runtime = approvals.createApprovalRuntime({ from: () => chain });

  await assert.rejects(
    () => runtime.park('user-1', action('send_email'), { userMessage: 'Email the supplier' }),
    /approval database unavailable/
  );
  await assert.rejects(() => runtime.pending('user-1', 'yes'), /approval database unavailable/);
});

test('the push for a waiting approval is short, plain and names what is waiting', () => {
  const { approvalNotification } = require('../../api/services/agent-approval-runtime');
  const notice = approvalNotification({
    approvalId: 'a1',
    taskId: 't1',
    taskGoal: 'Buy the headphones',
    action: { type: 'send_email', input: { to: 'Arina', subject: 'Are you free later?' } }
  });
  assert.equal(notice.category, 'action_required');
  assert.equal(notice.title, 'Needs a yes');
  assert.match(notice.body, /Arina/);
  assert.equal(notice.approvalId, 'a1');
  assert.equal(notice.taskId, 't1');
});

test('the push still says something sensible when the action has no detail', () => {
  const { approvalNotification } = require('../../api/services/agent-approval-runtime');
  const notice = approvalNotification({ approvalId: 'a2', action: { type: 'confirm_browser_payment' } });
  assert.equal(notice.title, 'Needs a yes');
  assert.ok(notice.body.length > 0);
});

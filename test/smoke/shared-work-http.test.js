'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_KEY = 'test-key';
process.env.OXY_SESSION_SECRET = 'test-shared-work-secret';

const approvalModule = require('../../api/services/agent-approval-runtime');
const taskManager = require('../../api/services/task-manager');
const originalApprovalFactory = approvalModule.createApprovalRuntime;
const originalTaskFactory = taskManager.createTaskManager;
const selected = [];
const pending = [{ approvalId: 'review-1', taskId: 'task-1', action: { type: 'send_email', input: { to: 'test@example.com', body: 'Full message' } } }];
approvalModule.createApprovalRuntime = () => ({
  list: async user => user === 'owner' ? pending : [],
  pending: async (user, message, selection) => { selected.push({ user, message, selection }); return null; }
});
taskManager.createTaskManager = () => ({
  updateRun: async () => {}, updateTaskCas: async () => {},
  getTask: async (user, id) => user === 'owner' && id === 'task-1'
    ? { id, user_id: user, goal: 'A request', status: 'paused', metadata: { awaitingApproval: true } }
    : null
});
const app = require('../../api/index');
approvalModule.createApprovalRuntime = originalApprovalFactory;
taskManager.createTaskManager = originalTaskFactory;
const { createSessionToken } = require('../../auth');
let server;
let baseURL;

test.before(async () => {
  server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  baseURL = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

async function request(path, user, body) {
  return fetch(baseURL + path, {
    method: body ? 'POST' : 'GET',
    headers: { ...(user ? { Authorization: `Bearer ${createSessionToken(user)}` } : {}), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
}

test('phone reads the owned review over HTTP without exposing another account', async () => {
  assert.equal((await request('/agent/tasks/task-1/reviews')).status, 401);
  assert.equal((await request('/agent/tasks/task-1/reviews', 'someone-else')).status, 404);
  const response = await request('/agent/tasks/task-1/reviews', 'owner');
  assert.equal(response.status, 200);
  const { reviews } = await response.json();
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].id, 'review-1');
  assert.ok(reviews[0].detail.includes('test@example.com'));
  assert.ok(reviews[0].detail.includes('Full message'));
});

test('stale and malformed phone decisions stop before any generic yes interpretation', async () => {
  for (const body of [
    { approvalId: 'review-1' },
    { approvalId: 'review-1', approvalTaskId: 'task-1', message: 'do something else' }
  ]) {
    const response = await request('/chat', 'owner', { userId: 'owner', message: 'Yes, confirm.', ...body });
    assert.equal(response.status, 400);
  }
  assert.equal(selected.length, 0);
  const response = await request('/chat', 'owner', {
    userId: 'owner', message: 'Yes, confirm.', approvalId: 'old-review', approvalTaskId: 'task-1'
  });
  assert.equal(response.status, 409);
  assert.deepEqual(selected[0].selection, { approvalId: 'old-review', taskId: 'task-1' });
});

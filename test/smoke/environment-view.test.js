const test = require('node:test');
const assert = require('node:assert/strict');
const sessions = require('../../api/services/browser-session');
const { getEnvironmentView, pageAddress } = require('../../api/services/environment-view');

function session(userId, taskId = 'task-1', screenshot) {
  let captures = 0;
  const record = sessions.createSession(userId, {
    agentTaskId: taskId,
    browser: { isConnected: () => true, close: async () => {} },
    page: { isClosed: () => false, url: () => 'https://site.example/account?token=secret#private', title: async () => 'Account',
      locator: selector => ({ selector }),
      screenshot: async options => { captures++; assert.equal(options.timeout, 3000); return screenshot ? screenshot(options) : Buffer.from('jpeg'); } }
  });
  return { record, captures: () => captures };
}

test.afterEach(() => sessions._liveSessions.clear());

test('viewing is owner scoped, task scoped, and never creates a session', async () => {
  const live = session('owner');
  assert.equal((await getEnvironmentView('other')).state, 'disconnected');
  assert.equal((await getEnvironmentView('owner', { taskId: 'other-task' })).state, 'disconnected');
  assert.equal(live.captures(), 0);
  assert.equal(sessions._liveSessions.size, 1);
});

test('a real capture carries its time and never extends browser activity', async () => {
  const live = session('owner');
  const before = live.record.lastActivityAt;
  const result = await getEnvironmentView('owner');
  assert.equal(result.state, 'live');
  assert.equal(result.address, 'https://site.example/account');
  assert.equal(result.title, 'Account');
  assert.equal(result.frame.mimeType, 'image/jpeg');
  assert.ok(Number.isFinite(Date.parse(result.capturedAt)));
  assert.equal(live.record.lastActivityAt, before);
  assert.equal(pageAddress('not-a-url'), '');
  assert.equal(pageAddress('about:blank'), '');
});

test('concurrent viewers share a capture and password controls are masked', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const live = session('owner', 'task-1', async options => {
    assert.deepEqual(options.mask, [{ selector: 'input[type="password"]' }]);
    await blocked; return Buffer.from('jpeg');
  });
  const a = getEnvironmentView('owner');
  const b = getEnvironmentView('owner');
  release();
  assert.deepEqual(await a, await b);
  await getEnvironmentView('owner');
  assert.equal(live.captures(), 1);
});

test('closed, failed, expired and replaced sessions never expose stale frames as live', async () => {
  const live = session('owner');
  live.record.page.isClosed = () => true;
  assert.equal((await getEnvironmentView('owner')).frame, null);
  const failed = session('owner', 'task-1', async () => { throw new Error('private details'); });
  const result = await getEnvironmentView('owner');
  assert.equal(result.state, 'unavailable');
  assert.equal(result.frame, null);
  assert.ok(!JSON.stringify(result).includes('private details'));
  failed.record.lastActivityAt = 0;
  assert.equal((await getEnvironmentView('owner')).state, 'disconnected');
  session('owner', 'task-1', async () => { sessions._liveSessions.delete('owner'); return Buffer.from('jpeg'); });
  assert.equal((await getEnvironmentView('owner')).state, 'disconnected');
});

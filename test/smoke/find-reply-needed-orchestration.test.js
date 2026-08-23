// Full find_reply_needed orchestration: search inbox -> group to latest-message-per-thread ->
// cheap pre-filter -> fetch real thread context -> LLM batch judgment -> truthful prioritized
// summary (api/index.js's find_reply_needed case). Mocks only the outermost I/O boundary:
// connectors/index.js's dispatch registry (for search_emails), connectors/google.js's
// getThreadContext (a property access at call time, so a direct monkey-patch works), and the
// generateBrain call that api/index.js destructures at require time (needs a Module._load
// intercept, same convention as gmail-cleanup-mutations.test.js's axios/runtime mock) — so the
// REAL orchestration code in api/index.js and the REAL logic in reply-needed.js both run.

require('dotenv').config();

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

// generateBrain is destructured by api/index.js at require time
// (`const { generateBrain } = require('./services/brain-provider')`), so mutating the module's
// exports after the fact wouldn't reach api/index.js's already-bound reference. Intercept the
// require itself, scoped to that one literal request string so agent-orchestrator.js's own
// (differently-pathed, property-style) require of the same file is unaffected.
let fakeGenerateBrain = async () => ({ text: '[]' });
const originalLoad = Module._load;
Module._load = function mockBrainProviderForApiIndex(request, parent, isMain) {
  if (request === './services/brain-provider' && parent && parent.filename && parent.filename.endsWith('api/index.js')) {
    const real = originalLoad.call(this, request, parent, isMain);
    return { ...real, generateBrain: (...args) => fakeGenerateBrain(...args) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const app = require('../../api/index');
const googleConnector = require('../../connectors/google');
Module._load = originalLoad;

const connectors = require('../../connectors');
const originalDispatchOverrides = { ...connectors.dispatchOverrides };

function installFakeConnector(action, execute) {
  connectors.dispatchOverrides[action] = { execute };
}
function restoreRegistry() {
  for (const key of Object.keys(connectors.dispatchOverrides)) delete connectors.dispatchOverrides[key];
  Object.assign(connectors.dispatchOverrides, originalDispatchOverrides);
}

const originalGetThreadContext = googleConnector.getThreadContext;
test.afterEach(() => {
  restoreRegistry();
  googleConnector.getThreadContext = originalGetThreadContext;
  fakeGenerateBrain = async () => ({ text: '[]' });
});

function fakeInbox() {
  return [
    // Thread 1: Sam asked a direct question, user hasn't replied -> needs response.
    { id: 'm1', threadId: 't1', senderName: 'Sam', senderAddress: 'sam@example.com', subject: 'Q3 numbers?', date: 'Mon, 01 Jun 2026 09:00:00 +0100', snippet: 'Can you send the Q3 numbers?' },
    // Thread 2: newsletter -> filtered before the LLM ever sees it.
    { id: 'm2', threadId: 't2', senderName: 'Daily Digest', senderAddress: 'news@example.com', subject: 'Your weekly digest', date: 'Mon, 01 Jun 2026 08:00:00 +0100', snippet: 'Top stories this week. Unsubscribe anytime.', listUnsubscribe: '<https://example.com/unsub>' },
    // Thread 3: user already replied and resolved it -> the LLM will see it but should say false.
    { id: 'm3', threadId: 't3', senderName: 'Jo', senderAddress: 'jo@example.com', subject: 'Lunch Friday', date: 'Tue, 02 Jun 2026 09:00:00 +0100', snippet: 'Sounds great, see you then!' }
  ];
}

function fakeThreadText(threadId) {
  const map = {
    t1: 'Sam: Can you send the Q3 numbers?',
    t3: 'Jo: Want to grab lunch Friday?\nMe: Sounds great, see you then!\nJo: Sounds great, see you then!'
  };
  return map[threadId] || '';
}

test('find_reply_needed searches the inbox, skips obvious noise, judges real thread content, and returns a truthful prioritized list', async () => {
  let searchedQuery = null;
  installFakeConnector('search_emails', async (userId, action, params) => {
    searchedQuery = params.query;
    return { success: true, emails: fakeInbox() };
  });

  const fetchedThreadIds = [];
  googleConnector.getThreadContext = async (userId, threadId) => {
    fetchedThreadIds.push(threadId);
    return { text: fakeThreadText(threadId) };
  };

  let promptSeen = null;
  fakeGenerateBrain = async ({ contents }) => {
    promptSeen = contents[0].parts[0].text;
    // Two threads reach the LLM (t1, t3) since t2 is filtered by the cheap pre-filter.
    return {
      text: JSON.stringify([
        { needsResponse: true, kind: 'reply', whatTheyNeed: 'send the Q3 numbers', reasoning: 'direct question, unanswered', urgency: 'soon' },
        { needsResponse: false, kind: null, whatTheyNeed: '', reasoning: 'user already resolved it', urgency: null }
      ])
    };
  };

  const result = await app.executeAction('user-1', 'find_reply_needed', {});

  assert.equal(searchedQuery, 'in:inbox');
  assert.equal(result.success, true);
  // The newsletter thread never reaches getThreadContext or the LLM.
  assert.deepEqual(fetchedThreadIds.sort(), ['t1', 't3']);
  assert.match(promptSeen, /Sam: Can you send the Q3 numbers\?/);
  assert.match(promptSeen, /Jo: Sounds great, see you then!/);
  // Only the genuinely-needs-response thread survives into the result.
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].threadId, 't1');
  assert.equal(result.items[0].sender, 'Sam');
  assert.equal(result.items[0].whatTheyNeed, 'send the Q3 numbers');
  assert.match(result.text, /Sam is waiting on you to send the Q3 numbers/);
});

test('find_reply_needed reassesses fresh each run: once the user has answered, the thread stops showing up', async () => {
  installFakeConnector('search_emails', async () => ({
    success: true,
    // Only the resolved thread remains "latest" now — no new message from Sam since the reply.
    emails: [{ id: 'm3', threadId: 't3', senderName: 'Jo', senderAddress: 'jo@example.com', subject: 'Lunch Friday', date: 'Tue, 02 Jun 2026 09:00:00 +0100', snippet: 'Sounds great, see you then!' }]
  }));
  googleConnector.getThreadContext = async (userId, threadId) => ({ text: fakeThreadText(threadId) });
  fakeGenerateBrain = async () => ({ text: JSON.stringify([{ needsResponse: false, kind: null, whatTheyNeed: '', reasoning: 'resolved' }]) });

  const result = await app.executeAction('user-1', 'find_reply_needed', {});
  assert.equal(result.items.length, 0);
  assert.match(result.text, /Nobody's waiting on you right now/);
});

test('find_reply_needed is honest when the inbox search itself fails, rather than claiming nobody is waiting', async () => {
  installFakeConnector('search_emails', async () => ({ success: false, error: 'Google not connected: token expired.' }));
  const result = await app.executeAction('user-1', 'find_reply_needed', {});
  assert.equal(result.success, false);
  assert.match(result.error, /token expired/);
});

test('find_reply_needed skips a thread it cannot fetch rather than guessing at its content', async () => {
  installFakeConnector('search_emails', async () => ({
    success: true,
    emails: [{ id: 'm1', threadId: 't1', senderName: 'Sam', senderAddress: 'sam@example.com', subject: 'Q3 numbers?', date: 'Mon, 01 Jun 2026 09:00:00 +0100', snippet: 'Can you send the Q3 numbers?' }]
  }));
  googleConnector.getThreadContext = async () => { throw new Error('Gmail API 500'); };
  let brainCalled = false;
  fakeGenerateBrain = async () => { brainCalled = true; return { text: '[]' }; };

  const result = await app.executeAction('user-1', 'find_reply_needed', {});
  assert.equal(result.success, true);
  assert.equal(result.items.length, 0);
  assert.equal(brainCalled, false, 'nothing to judge once the only candidate thread failed to fetch');
});

test('find_reply_needed respects max_threads, capping how many candidate threads reach the LLM', async () => {
  const emails = Array.from({ length: 10 }, (_, i) => ({
    id: `m${i}`, threadId: `t${i}`, senderName: `Person${i}`, senderAddress: `p${i}@example.com`,
    subject: `Question ${i}`, date: `Mon, 0${(i % 9) + 1} Jun 2026 09:00:00 +0100`, snippet: 'Can you help with this?'
  }));
  installFakeConnector('search_emails', async () => ({ success: true, emails }));
  const fetched = [];
  googleConnector.getThreadContext = async (userId, threadId) => { fetched.push(threadId); return { text: 'content' }; };
  fakeGenerateBrain = async ({ contents }) => {
    const count = (contents[0].parts[0].text.match(/^THREAD \d+/gm) || []).length;
    return { text: JSON.stringify(Array.from({ length: count }, () => ({ needsResponse: false }))) };
  };

  const result = await app.executeAction('user-1', 'find_reply_needed', { max_threads: 3 });
  assert.equal(result.success, true);
  assert.equal(fetched.length, 3);
  assert.equal(result.threadsConsidered, 3);
});

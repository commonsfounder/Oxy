const assert = require('node:assert/strict');
const test = require('node:test');

const {
  matchesPaymentKeyword,
  buildDecisionPrompt,
  parseModelDecision,
  findElementByText
} = require('../../api/services/browser-task');

test('matchesPaymentKeyword catches common finalize/payment button text', () => {
  assert.equal(matchesPaymentKeyword('Place order'), true);
  assert.equal(matchesPaymentKeyword('Pay now'), true);
  assert.equal(matchesPaymentKeyword('Confirm Purchase'), true);
  assert.equal(matchesPaymentKeyword('Checkout & Pay'), true);
  assert.equal(matchesPaymentKeyword('Add to basket'), false);
  assert.equal(matchesPaymentKeyword(''), false);
  assert.equal(matchesPaymentKeyword(undefined), false);
});

test('buildDecisionPrompt includes the goal, history, and numbered elements', () => {
  const prompt = buildDecisionPrompt('order a pizza', ['Searched for pizza places'], [
    { id: 0, text: 'Domino\'s' },
    { id: 1, text: 'Add to basket' }
  ]);
  assert.match(prompt, /order a pizza/);
  assert.match(prompt, /Searched for pizza places/);
  assert.match(prompt, /#0 "Domino's"/);
  assert.match(prompt, /#1 "Add to basket"/);
});

test('buildDecisionPrompt handles empty history', () => {
  const prompt = buildDecisionPrompt('check stock', [], [{ id: 0, text: 'Search' }]);
  assert.match(prompt, /\(nothing yet\)/);
});

test('parseModelDecision parses a valid click decision', () => {
  const result = parseModelDecision('{"action":"click","elementId":3}');
  assert.deepEqual(result, { action: 'click', elementId: 3 });
});

test('parseModelDecision parses a valid ready_for_payment decision', () => {
  const result = parseModelDecision('{"action":"ready_for_payment","summary":"1x pizza","total":"£9.50"}');
  assert.equal(result.action, 'ready_for_payment');
  assert.equal(result.total, '£9.50');
});

test('parseModelDecision rejects unparseable JSON', () => {
  const result = parseModelDecision('not json at all');
  assert.equal(result.action, 'invalid');
  assert.ok(result.error);
});

test('parseModelDecision rejects an unrecognized action name', () => {
  const result = parseModelDecision('{"action":"explode"}');
  assert.equal(result.action, 'invalid');
});

test('findElementByText finds an exact match case-insensitively', () => {
  const elements = [{ id: 0, text: 'Add to basket' }, { id: 1, text: 'Place order' }];
  const found = findElementByText(elements, 'place order');
  assert.equal(found.id, 1);
});

test('findElementByText falls back to a substring match', () => {
  const elements = [{ id: 0, text: 'Place order now' }];
  const found = findElementByText(elements, 'place order');
  assert.equal(found.id, 0);
});

test('findElementByText returns null when nothing matches', () => {
  const elements = [{ id: 0, text: 'Add to basket' }];
  assert.equal(findElementByText(elements, 'place order'), null);
});

const {
  getSession,
  createSession,
  touchSession,
  closeSession
} = require('../../api/services/browser-task');

function fakeBrowser() {
  let closed = false;
  return {
    closed: () => closed,
    close: async () => { closed = true; }
  };
}

test('createSession stores a session retrievable by getSession', () => {
  const browser = fakeBrowser();
  createSession('user-a', { browser, context: {}, page: {}, goal: 'order pizza', history: [], pendingPaymentLabel: null });
  const found = getSession('user-a');
  assert.ok(found);
  assert.equal(found.goal, 'order pizza');
});

test('getSession returns null and closes the browser once idle past the timeout', () => {
  const browser = fakeBrowser();
  createSession('user-b', { browser, context: {}, page: {}, goal: 'order pizza', history: [], pendingPaymentLabel: null });
  const session = getSession('user-b');
  session.lastActivityAt = Date.now() - (21 * 60 * 1000); // older than the 20-minute idle timeout
  const result = getSession('user-b');
  assert.equal(result, null);
});

test('touchSession refreshes lastActivityAt so the session is not evicted', () => {
  const browser = fakeBrowser();
  createSession('user-c', { browser, context: {}, page: {}, goal: 'order pizza', history: [], pendingPaymentLabel: null });
  const session = getSession('user-c');
  session.lastActivityAt = Date.now() - (21 * 60 * 1000);
  touchSession('user-c');
  const result = getSession('user-c');
  assert.ok(result);
});

test('closeSession closes the browser and removes the session', async () => {
  const browser = fakeBrowser();
  createSession('user-d', { browser, context: {}, page: {}, goal: 'order pizza', history: [], pendingPaymentLabel: null });
  await closeSession('user-d');
  assert.equal(getSession('user-d'), null);
  assert.equal(browser.closed(), true);
});

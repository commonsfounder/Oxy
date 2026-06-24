const assert = require('node:assert/strict');
const test = require('node:test');

const {
  matchesPaymentKeyword,
  isTechnicalAsk,
  isOrderGoal,
  buildDecisionPrompt,
  parseModelDecision,
  findElementByText
} = require('../../api/services/browser-task');
const { validateActionWithContract } = require('../../api/action-contracts');

// Regression: the contract's static `required` list can't express "goal is required
// to START a task but optional to CONTINUE one" — that's conditional on live session
// state. goal moved to `optional`; the real, session-aware check lives in the
// run_browser_task case handler (api/index.js). If 'goal' ever lands back in
// `required` here, the generic validator below would reject the auto-continue
// sentinel's empty goal before that handler even runs — exactly the bug that broke
// the whole auto-continue feature in production.
test('validateActionWithContract does not require goal (the handler enforces it conditionally)', () => {
  const action = { type: 'run_browser_task', input: {} };
  const error = validateActionWithContract(action, '');
  assert.equal(error, null, 'an empty goal must reach the handler, not be rejected upstream');
});

test('matchesPaymentKeyword catches common finalize/payment button text', () => {
  assert.equal(matchesPaymentKeyword('Place order'), true);
  assert.equal(matchesPaymentKeyword('Pay now'), true);
  assert.equal(matchesPaymentKeyword('Confirm Purchase'), true);
  assert.equal(matchesPaymentKeyword('Checkout & Pay'), true);
  assert.equal(matchesPaymentKeyword('Add to basket'), false);
  assert.equal(matchesPaymentKeyword(''), false);
  assert.equal(matchesPaymentKeyword(undefined), false);
});

test('matchesPaymentKeyword catches real-world finalize buttons and rejects mid-flow ones', () => {
  // must match (finalize / charge)
  for (const t of ['Pay £9.50 now', 'Pay', 'Order now', 'Complete your order',
    'Complete purchase', 'Submit order', 'Confirm order', 'Confirm purchase',
    'Buy', 'Buy now', 'Slide to pay', 'Confirm and pay', 'Proceed to payment',
    'Place your order']) {
    assert.equal(matchesPaymentKeyword(t), true, `expected match: ${t}`);
  }
  // must NOT match (browse / mid-flow — pausing here would strand the user)
  for (const t of ['Add to basket', 'Add to cart', 'View menu', 'Search',
    'Proceed to checkout', 'Continue', 'Edit order', 'More options']) {
    assert.equal(matchesPaymentKeyword(t), false, `expected no match: ${t}`);
  }
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

test('buildDecisionPrompt tells the model it can see the page and offers a wait action', () => {
  const prompt = buildDecisionPrompt('order a pizza', [], [{ id: 0, text: 'Search' }]);
  assert.match(prompt, /screenshot/i);
  assert.match(prompt, /numbered badge/i);
  assert.match(prompt, /"action":"wait"/);
  assert.match(prompt, /NEVER ask the user for a URL/i);
});

test('isTechnicalAsk flags questions a real assistant must never ask', () => {
  for (const q of [
    'Please provide the search bar element ID',
    'What is the URL for the McDonald\'s order page?',
    'Should I navigate to a specific delivery platform?',
    'Give me the CSS selector for the search box'
  ]) {
    assert.equal(isTechnicalAsk(q), true, `expected technical: ${q}`);
  }
  // legitimate, user-facing questions must pass through
  for (const q of [
    'Which restaurant would you like to order from?',
    'What size pizza?',
    'I don\'t have a delivery address on record — where should it go?'
  ]) {
    assert.equal(isTechnicalAsk(q), false, `expected fine: ${q}`);
  }
});

test('isOrderGoal recognizes ordering intent so a premature "done" never closes the cart', () => {
  assert.equal(isOrderGoal('Order a McDonald\'s Big Mac to 1805 Coventry Road'), true);
  assert.equal(isOrderGoal('get me some jerk chicken for delivery'), true);
  assert.equal(isOrderGoal('mcdonald\'s'), false); // bare reply — handled by live session, not a fresh order goal
  assert.equal(isOrderGoal('what is the capital of France'), false);
});

test('parseModelDecision parses a valid wait decision', () => {
  assert.deepEqual(parseModelDecision('{"action":"wait"}'), { action: 'wait' });
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

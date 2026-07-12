const assert = require('node:assert/strict');
const test = require('node:test');

const {
  matchesPaymentKeyword,
  isTechnicalAsk,
  isCheckoutLoginWallUrl,
  findDeliveryCollectionChoice,
  parseDeliveryPreferenceFromText,
  isOrderGoal,
  buildDecisionPrompt,
  parseModelDecision,
  scoreSearchResultText,
  pickBestSearchResult,
  scoreProductNameVsGoal,
  pickFallbackCandidate,
  findElementByText,
  shouldStartFreshSession
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

test('parseModelDecision parses a valid back decision', () => {
  // "back" exists so "this product can't fulfil the goal (size out of stock) → return to
  // results" is actionable even when the site hides its header/back affordances (Nike).
  assert.deepEqual(parseModelDecision('{"action":"back"}'), { action: 'back' });
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

// Reasoning models often wrap the object in ```json fences or prepend prose despite the
// JSON mime type. The loop must recover the action instead of stalling on "invalid".
test('parseModelDecision strips ```json fences', () => {
  const result = parseModelDecision('```json\n{"action":"click","elementId":2}\n```');
  assert.deepEqual(result, { action: 'click', elementId: 2 });
});

test('parseModelDecision extracts the JSON object from leading prose', () => {
  const result = parseModelDecision('Here is the JSON requested:\n{"action":"fill","elementId":1,"value":"SW1A 1AA"}');
  assert.equal(result.action, 'fill');
  assert.equal(result.elementId, 1);
  assert.equal(result.value, 'SW1A 1AA');
});

test('parseModelDecision still fails cleanly when there is no JSON object at all', () => {
  const result = parseModelDecision('I think I should click the search box next.');
  assert.equal(result.action, 'invalid');
  assert.ok(result.error);
});

// The hallucinated-id recovery path: a correction is threaded into the next prompt so the
// model is told which ids are real instead of silently re-asking the identical question.
test('buildDecisionPrompt surfaces a correction and the valid id range', () => {
  const prompt = buildDecisionPrompt('order a pizza', [], [
    { id: 0, text: 'Search' },
    { id: 1, text: 'Add to basket' }
  ], 'elementId 17 is NOT on this page. Valid ids are 0 to 1.');
  assert.match(prompt, /CORRECTION/);
  assert.match(prompt, /elementId 17 is NOT on this page/);
  assert.match(prompt, /0 to 1/);
});

test('buildDecisionPrompt omits the correction block when there is no correction', () => {
  const prompt = buildDecisionPrompt('order a pizza', [], [{ id: 0, text: 'Search' }]);
  assert.doesNotMatch(prompt, /CORRECTION/);
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

// Regression: a live John Lewis run searched "iPhone 17 256GB" and tryOrderSearchPick
// blindly clicked the first product link on the results page, which happened to be
// "iPhone 17 Pro" — a different, pricier product the user never asked for.
test('scoreSearchResultText prefers the plain model over an unrequested Pro/Max/Plus variant', () => {
  const term = 'iPhone 17 256GB';
  const plain = scoreSearchResultText('Apple iPhone 17, 256GB, Lavender', term);
  const pro = scoreSearchResultText('Apple iPhone 17 Pro, 256GB, Deep Blue', term);
  const proMax = scoreSearchResultText('Apple iPhone 17 Pro Max, 256GB, Cosmic Orange', term);
  assert.ok(plain > pro, 'plain iPhone 17 should outscore the Pro the goal never asked for');
  assert.ok(plain > proMax, 'plain iPhone 17 should outscore the Pro Max the goal never asked for');
});

// Regression: a live John Lewis run for "add a plain white bath towel to my basket" picked
// "...Bath Mat" over "...Towels" — "towel" (singular, goal) never matched "towels" (plural,
// name), while "Bath Mat" tied on the shared descriptor "bath". Cost 3 wasted turns (~2 min)
// retrying the wrong product before the loop recovered onto the right one.
test('scoreSearchResultText matches a plural product name against a singular goal word', () => {
  const term = 'plain white bath towel';
  const towels = scoreSearchResultText('John Lewis Egyptian Cotton Towels', term);
  const mat = scoreSearchResultText('John Lewis Egyptian Cotton Bath Mat', term);
  assert.ok(towels > mat, 'the actual towel listing should outscore an unrelated bath mat');
});

test('scoreProductNameVsGoal matches a plural product name against a singular goal word', () => {
  const goal = 'add a plain white bath towel to my basket';
  const towels = scoreProductNameVsGoal('John Lewis Egyptian Cotton Towels', goal);
  assert.ok(towels > 0, 'the plural "Towels" name should score positively against singular "towel" in the goal');
});

test('scoreSearchResultText prefers a requested Pro variant over the plain model', () => {
  const term = 'iPhone 17 Pro 256GB';
  const plain = scoreSearchResultText('Apple iPhone 17, 256GB, Lavender', term);
  const pro = scoreSearchResultText('Apple iPhone 17 Pro, 256GB, Deep Blue', term);
  assert.ok(pro > plain, 'goal asked for Pro, so Pro should outscore the plain model');
});

test('scoreSearchResultText penalizes a completely different model number', () => {
  const term = 'iPhone 17 256GB';
  const seventeen = scoreSearchResultText('Apple iPhone 17, 256GB, Lavender', term);
  const sixteen = scoreSearchResultText('Apple iPhone 16, 128GB, Black', term);
  assert.ok(seventeen > sixteen, 'the requested model number must outscore an unrelated one');
});

test('pickBestSearchResult returns the highest-scoring candidate, not the first in DOM order', () => {
  const candidates = [
    { locatorIndex: 3, text: 'Apple iPhone 17 Pro, 256GB, Deep Blue' },
    { locatorIndex: 9, text: 'Apple iPhone 17, 256GB, Lavender' },
  ];
  const best = pickBestSearchResult(candidates, 'iPhone 17 256GB');
  assert.equal(best.locatorIndex, 9, 'the plain iPhone 17 should win even though it is second in the DOM');
});

test('pickBestSearchResult falls back to the first candidate on a total tie', () => {
  const candidates = [{ locatorIndex: 1, text: 'Widget' }, { locatorIndex: 2, text: 'Widget' }];
  const best = pickBestSearchResult(candidates, 'widget');
  assert.equal(best.locatorIndex, 1);
});

test('pickBestSearchResult returns null for an empty candidate list', () => {
  assert.equal(pickBestSearchResult([], 'iPhone 17'), null);
});

// Regression: after backing out of a wrong page, the vision model free-typed a search
// query and hallucinated "iPhone 16" instead of retrying the goal's actual "iPhone 17" —
// the prompt had no rule against substituting a different model/generation.
test('buildDecisionPrompt forbids substituting a different model, generation, or tier', () => {
  const prompt = buildDecisionPrompt('order me an iPhone 17 256GB from John Lewis', [], []);
  assert.match(prompt, /NEVER substitute a different model number, generation, or\ntier/);
  assert.match(prompt, /EXACT product wording from\nthe goal/);
});

// Regression: a live John Lewis run for "order me an iPhone 17 256GB from John Lewis" got
// zero "orderable" candidates back from resolveOrderOpenUrl's plain HTTP fetch (JL likely
// serves a stripped/bot-walled response to a non-browser request) and the old fallback
// blindly returned candidates[0] — the first link scraped off the page — with zero
// relevance check. That landed on a Nintendo Switch 2 console, which the recipe then
// added to basket. pickFallbackCandidate must never hand back a candidate that scored no
// better than chance against the goal.
test('pickFallbackCandidate prefers the best-scoring candidate over positional order', () => {
  const checked = [
    { productUrl: 'https://x/switch', name: 'Nintendo Switch 2, 256GB Console', score: 0 },
    { productUrl: 'https://x/iphone17', name: 'Apple iPhone 17, 256GB, Lavender', score: 4 },
  ];
  const picked = pickFallbackCandidate(checked, 'https://x/search?q=iphone+17+256gb');
  assert.equal(picked, 'https://x/iphone17');
});

test('pickFallbackCandidate falls back to the search URL when nothing scores positively', () => {
  const checked = [
    { productUrl: 'https://x/switch', name: 'Nintendo Switch 2, 256GB Console', score: 0 },
    { productUrl: 'https://x/random', name: 'Garden Hose, 25m', score: -1 },
  ];
  const searchUrl = 'https://x/search?q=iphone+17+256gb';
  assert.equal(pickFallbackCandidate(checked, searchUrl), searchUrl);
});

test('pickFallbackCandidate handles nulls from failed PDP fetches', () => {
  const checked = [null, { productUrl: 'https://x/iphone17', name: 'Apple iPhone 17, 256GB', score: 2 }, null];
  assert.equal(pickFallbackCandidate(checked, 'https://x/search'), 'https://x/iphone17');
});

test('scoreProductNameVsGoal rewards matching words and punishes an unrequested tier word', () => {
  const goal = 'order me an iPhone 17 256GB from John Lewis';
  const plain = scoreProductNameVsGoal('Apple iPhone 17, 256GB, Lavender', goal);
  const pro = scoreProductNameVsGoal('Apple iPhone 17 Pro, 256GB, Deep Blue', goal);
  const unrelated = scoreProductNameVsGoal('Nintendo Switch 2, 256GB Console', goal);
  assert.ok(plain > pro, 'the plain model should outscore an unrequested Pro variant');
  assert.ok(plain > unrelated, 'the actual product should outscore a completely unrelated one');
  assert.ok(unrelated <= 0, 'an unrelated product must not score positively just by sharing "256GB"');
});

// Regression: a live run's fastpath landed on "iPhone 17e, 256GB, Soft Pink" (£599) for a
// goal that said plain "iPhone 17 256GB" (the £799 model). "17e" never equals the token
// "17", so it dodged both the match bonus and the Pro/Max differentiator check, and slipped
// through with a positive score since nothing else out-ranked it in that run's candidates.
test('scoreProductNameVsGoal punishes a suffixed model tier ("17e") the goal never asked for', () => {
  const goal = 'order me an iPhone 17 256GB from John Lewis';
  const plain = scoreProductNameVsGoal('Apple iPhone 17, 256GB, Lavender', goal);
  const suffixed = scoreProductNameVsGoal('Apple iPhone 17e, 256GB, Soft Pink', goal);
  assert.ok(plain > suffixed, 'the plain model should outscore the unrequested "17e" tier');
  assert.ok(suffixed < 0, '"17e" must not score positively against a goal that said plain "17"');
});

test('scoreProductNameVsGoal does not punish "17e" when the goal actually asked for it', () => {
  const goal = 'order me an iPhone 17e 256GB from John Lewis';
  const suffixed = scoreProductNameVsGoal('Apple iPhone 17e, 256GB, Soft Pink', goal);
  assert.ok(suffixed > 0, 'goal explicitly asked for "17e", so it should score positively');
});

test('scoreSearchResultText requires a whole-word match, not a substring ("17e" must not count as "17")', () => {
  const term = 'iPhone 17 256GB';
  const plain = scoreSearchResultText('Apple iPhone 17, 256GB, Lavender', term);
  const suffixed = scoreSearchResultText('Apple iPhone 17e, 256GB, Soft Pink', term);
  assert.ok(plain > suffixed, 'the plain model should outscore the unrequested "17e" tier');
  assert.ok(suffixed < 0, '"17e" must not score positively — a plain .includes("17") check would wrongly match it');
});

// Regression: a live John Lewis run completed guest checkout and landed on Auth0's own
// redirect — checkout.johnlewis.com/callback/login/guest?email=... — which the old check
// misread as a login wall purely because "login" appears in that callback path. That's
// backwards: a /callback/ URL is guest auth completing, not blocking.
test('isCheckoutLoginWallUrl does not fire on an Auth0 guest-checkout callback', () => {
  assert.equal(isCheckoutLoginWallUrl('https://checkout.johnlewis.com/callback/login/guest?email=a%40b.com'), false);
});

test('isCheckoutLoginWallUrl still fires on a real sign-in page', () => {
  assert.equal(isCheckoutLoginWallUrl('https://checkout.johnlewis.com/login'), true);
  assert.equal(isCheckoutLoginWallUrl('https://www.example.com/account/login?redirect=/checkout'), true);
  assert.equal(isCheckoutLoginWallUrl('https://www.example.com/signin'), true);
});

test('isCheckoutLoginWallUrl returns false for an unrelated URL', () => {
  assert.equal(isCheckoutLoginWallUrl('https://www.johnlewis.com/basket'), false);
});

// Regression: a live John Lewis run had a full home address on file, but the checkout page
// defaulted to "Collection" (a random Royal Mail shop) and the loop never considered
// switching to "Delivery" — it just silently accepted the retailer's default.
test('findDeliveryCollectionChoice detects both options on a checkout page', () => {
  const elements = [
    { id: 0, text: 'Collection', locatorIndex: 0 },
    { id: 1, text: 'Delivery', locatorIndex: 1 },
    { id: 2, text: 'Continue to payment', locatorIndex: 2 },
  ];
  const choice = findDeliveryCollectionChoice(elements);
  assert.ok(choice);
  assert.equal(choice.collection.text, 'Collection');
  assert.equal(choice.delivery.text, 'Delivery');
});

test('findDeliveryCollectionChoice recognizes Click & Collect phrasing', () => {
  const elements = [
    { id: 0, text: 'Click & Collect', locatorIndex: 0 },
    { id: 1, text: 'Delivery', locatorIndex: 1 },
  ];
  assert.ok(findDeliveryCollectionChoice(elements));
});

test('findDeliveryCollectionChoice returns null when only one side is present', () => {
  const elements = [{ id: 0, text: 'Delivery', locatorIndex: 0 }, { id: 1, text: 'Add to basket', locatorIndex: 1 }];
  assert.equal(findDeliveryCollectionChoice(elements), null);
});

// Regression: two live runs never asked at all — John Lewis's toggle cards read
// "Collection\nFree" / "Delivery\nFree", which collapses to "Collection Free" / "Delivery
// Free" once the element extractor normalizes whitespace. The original ^delivery$/
// ^collection$ anchors required an exact match and silently missed every real occurrence.
test('findDeliveryCollectionChoice matches a toggle card with trailing price text ("Delivery Free")', () => {
  const elements = [
    { id: 0, text: 'Collection Free', locatorIndex: 0 },
    { id: 1, text: 'Delivery Free', locatorIndex: 1 },
    { id: 2, text: 'Continue to payment', locatorIndex: 2 },
  ];
  const choice = findDeliveryCollectionChoice(elements);
  assert.ok(choice, 'must match even with trailing "Free" price text');
  assert.equal(choice.collection.text, 'Collection Free');
  assert.equal(choice.delivery.text, 'Delivery Free');
});

test('findDeliveryCollectionChoice does not match an unrelated sentence mentioning delivery', () => {
  const elements = [
    { id: 0, text: 'Delivery information can be found on our help page', locatorIndex: 0 },
    { id: 1, text: 'Collection', locatorIndex: 1 },
  ];
  assert.equal(findDeliveryCollectionChoice(elements), null, 'a long sentence is not a toggle label');
});

test('parseDeliveryPreferenceFromText reads a clear delivery reply', () => {
  assert.equal(parseDeliveryPreferenceFromText('deliver it to my address please'), 'delivery');
  assert.equal(parseDeliveryPreferenceFromText('ship it'), 'delivery');
});

test('parseDeliveryPreferenceFromText reads a clear collection reply', () => {
  assert.equal(parseDeliveryPreferenceFromText('collection is fine'), 'collection');
  assert.equal(parseDeliveryPreferenceFromText("I'll pick it up from the store"), 'collection');
  assert.equal(parseDeliveryPreferenceFromText('click and collect'), 'collection');
});

test('parseDeliveryPreferenceFromText returns null for an unrelated or ambiguous reply', () => {
  assert.equal(parseDeliveryPreferenceFromText('sure, sounds good'), null);
  assert.equal(parseDeliveryPreferenceFromText(''), null);
});

test('closeSession closes the browser and removes the session', async () => {
  const browser = fakeBrowser();
  createSession('user-d', { browser, context: {}, page: {}, goal: 'order pizza', history: [], pendingPaymentLabel: null });
  await closeSession('user-d');
  assert.equal(getSession('user-d'), null);
  assert.equal(browser.closed(), true);
});

// Regression: same-site session bleed. A live order session for a site, left alive after a
// killed/finished run, must NOT be continued by a brand-new order for the SAME site — that
// inherits the old cart. Only an actual continuation (auto-continue, a reply, or converting a
// lookup to "order it") may reuse the session. See browser-task-reliability memory (2026-07-12).
test('shouldStartFreshSession: a new same-site order goal starts fresh (no cart bleed)', () => {
  const session = { site: 'allbirds.com', goal: 'order wool runners from allbirds', isOrder: true };
  assert.equal(
    shouldStartFreshSession(session, { url: 'https://www.allbirds.com', goal: 'order socks from allbirds' }),
    true
  );
});

test('shouldStartFreshSession: empty goal (auto-continue) reuses the session', () => {
  const session = { site: 'allbirds.com', goal: 'order socks from allbirds', isOrder: true };
  assert.equal(shouldStartFreshSession(session, { url: 'https://www.allbirds.com', goal: '' }), false);
});

test('shouldStartFreshSession: converting a lookup to "order it" reuses the session', () => {
  const session = { site: 'allbirds.com', goal: 'how much are allbirds socks', isOrder: false };
  assert.equal(shouldStartFreshSession(session, { url: 'https://www.allbirds.com', goal: 'order it' }), false);
});

test('shouldStartFreshSession: re-issuing the identical order goal reuses (resume, not bleed)', () => {
  const session = { site: 'allbirds.com', goal: 'order socks from allbirds', isOrder: true };
  assert.equal(
    shouldStartFreshSession(session, { url: 'https://www.allbirds.com', goal: 'order socks from allbirds' }),
    false
  );
});

test('shouldStartFreshSession: no live session means nothing to reset', () => {
  assert.equal(shouldStartFreshSession(null, { url: 'https://www.allbirds.com', goal: 'order socks' }), false);
});

test('shouldStartFreshSession: a url pointing at a different site starts fresh', () => {
  const session = { site: 'allbirds.com', goal: 'order socks from allbirds', isOrder: true };
  assert.equal(
    shouldStartFreshSession(session, { url: 'https://www.johnlewis.com', goal: 'order a lamp' }),
    true
  );
});


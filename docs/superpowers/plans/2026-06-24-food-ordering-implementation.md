# Agentic Browser Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `run_browser_task`'s fixed-steps execution with a generic perception-action loop that can complete real checkouts (e.g. food ordering) by driving one continuous, resumable browser session per user, gated by explicit confirmation before any payment click.

**Architecture:** `api/services/browser-task.js` owns all Playwright mechanics, the live-session store, and the per-step Gemini decision call. `api/index.js`'s `run_browser_task` case becomes a thin adapter that turns the loop's outcome into a chat reply, reusing the existing `setPendingAction`/confirm-cancel mechanism for the payment gate. No new payment infrastructure — checkout uses whatever payment method is already saved on the live session's logged-in account.

**Tech Stack:** Playwright (`playwright-extra` + `puppeteer-extra-plugin-stealth`, already installed), `@google/generative-ai` via `runtime.createGeminiServiceClient()` (already used elsewhere), Supabase (`browser_sessions` table, already migrated), `node:test` for unit tests.

## Global Constraints

- Per-turn loop cap: 40 steps or 4 minutes, whichever comes first (from spec).
- Session idle timeout: 20 minutes since last activity, then the browser is closed (from spec).
- One live session per user; a second order attempt while one is open continues/asks about the existing one (from spec, v1 scope).
- No AI-owned payment instrument — checkout uses the already-logged-in account's saved payment method, gated by explicit user confirmation each time (from spec).
- `run_browser_task`'s `steps` input param is removed entirely — the loop decides every step live (from spec).

---

## File Structure

- **Modify `api/services/browser-task.js`** — delete the old fixed-steps `runBrowserTask`; add pure decision helpers, the live-session store, DOM element extraction, the main loop (`runOrderingTurn`), and `confirmPayment`/the cancel no-op. Keeps existing `loadStorageState`/`saveStorageState`/`siteKeyFromUrl`/`launchBrowser` as-is.
- **Modify `api/action-contracts.js`** — update `run_browser_task`'s guidance text for the new resume-by-replying behavior; no `executionMode` change (stays default `'direct'` — only the payment moment goes through manual review, not the whole action).
- **Modify `api/index.js`** — rewrite the `run_browser_task` case; delete `runBrowserTaskAndNotify` and `summarizeBrowserResult` (dead code once the loop produces its own summaries).
- **Create `test/smoke/browser-ordering-loop.test.js`** — unit tests for the pure helpers and the session-store eviction logic (no real browser).

---

### Task 1: Pure decision helpers

**Files:**
- Modify: `api/services/browser-task.js`
- Test: `test/smoke/browser-ordering-loop.test.js`

**Interfaces:**
- Produces: `matchesPaymentKeyword(text: string): boolean`, `buildDecisionPrompt(goal: string, history: string[], elements: {id: number, text: string}[]): string`, `parseModelDecision(rawText: string): {action: 'click'|'fill'|'ask'|'done'|'ready_for_payment'|'invalid', elementId?: number, value?: string, question?: string, summary?: string, total?: string, error?: string}`, `findElementByText(elements: {id: number, text: string}[], text: string): {id: number, text: string} | null`

- [ ] **Step 1: Write the failing tests**

Create `test/smoke/browser-ordering-loop.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/smoke/browser-ordering-loop.test.js`
Expected: FAIL — `matchesPaymentKeyword is not a function` (or similar, since these exports don't exist yet).

- [ ] **Step 3: Implement the helpers**

In `api/services/browser-task.js`, remove the old `runBrowserTask` function and its `steps`-loop body (everything between the `// Runs one browser task...` comment and its closing `}`), keeping `loadStorageState`, `saveStorageState`, `siteKeyFromUrl`, and `launchBrowser` untouched above it. Add this in their place:

```js
const PAYMENT_KEYWORD_PATTERN = /\b(place( your)? order|pay now|confirm purchase|complete order|checkout\s*(and|&)\s*pay|buy now|submit payment|confirm( and)? pay)\b/i;

function matchesPaymentKeyword(text) {
  return PAYMENT_KEYWORD_PATTERN.test(String(text || ''));
}

function buildDecisionPrompt(goal, history, elements) {
  const historyText = history.length
    ? history.map((entry, i) => `${i + 1}. ${entry}`).join('\n')
    : '(nothing yet)';
  const elementsText = elements.map(el => `#${el.id} "${el.text}"`).join('\n');
  return `You are controlling a real web browser to help with this goal: "${goal}"

What's happened so far:
${historyText}

Visible clickable elements on the current page:
${elementsText}

Reply with ONLY one JSON object, one of these shapes:
{"action":"click","elementId":<number>}
{"action":"fill","elementId":<number>,"value":"<text>"}
{"action":"ask","question":"<short question for the user>"}
{"action":"done","summary":"<short summary answering the goal>"}
{"action":"ready_for_payment","summary":"<what's in the cart>","total":"<price as shown on the page>"}

Use "ask" only for genuine ambiguity you cannot resolve from the goal and history (e.g. multiple matching restaurants, a required size/option choice). Use "ready_for_payment" once the cart is built and the next step would be paying — never choose "click" on anything that finalizes a purchase yourself.`;
}

function parseModelDecision(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawText || '').trim());
  } catch {
    return { action: 'invalid', error: 'Could not parse model response as JSON.' };
  }
  const validActions = new Set(['click', 'fill', 'ask', 'done', 'ready_for_payment']);
  if (!parsed || typeof parsed !== 'object' || !validActions.has(parsed.action)) {
    return { action: 'invalid', error: 'Model returned an unrecognized action.' };
  }
  return parsed;
}

function findElementByText(elements, text) {
  const needle = String(text || '').trim().toLowerCase();
  if (!needle) return null;
  return elements.find(el => el.text.trim().toLowerCase() === needle)
    || elements.find(el => el.text.trim().toLowerCase().includes(needle))
    || null;
}
```

Update the `module.exports` at the bottom of the file to include the new functions (full set after this task):

```js
module.exports = {
  matchesPaymentKeyword,
  buildDecisionPrompt,
  parseModelDecision,
  findElementByText
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/smoke/browser-ordering-loop.test.js`
Expected: PASS — all 11 tests green.

- [ ] **Step 5: Commit**

```bash
git add api/services/browser-task.js test/smoke/browser-ordering-loop.test.js
git commit -m "Add pure decision helpers for the browser ordering loop"
```

---

### Task 2: Live session store

**Files:**
- Modify: `api/services/browser-task.js`
- Test: `test/smoke/browser-ordering-loop.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `getSession(userId: string): Session | null`, `touchSession(userId: string): void`, `closeSession(userId: string): Promise<void>`, `createSession(userId: string, session: Omit<Session, 'lastActivityAt'>): Session` where `Session = { browser, context, page, goal: string, history: string[], pendingPaymentLabel: string | null, lastActivityAt: number }`. These are used by Task 4/5 and are exported for the test's fake-session injection only (not real production callers outside this file).

- [ ] **Step 1: Write the failing tests**

Append to `test/smoke/browser-ordering-loop.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/smoke/browser-ordering-loop.test.js`
Expected: FAIL — `createSession is not a function`.

- [ ] **Step 3: Implement the session store**

Add to `api/services/browser-task.js`, above the pure helpers added in Task 1:

```js
const SESSION_IDLE_MS = 20 * 60 * 1000;
const liveSessions = new Map();

function createSession(userId, session) {
  const record = { ...session, lastActivityAt: Date.now() };
  liveSessions.set(userId, record);
  return record;
}

function getSession(userId) {
  const session = liveSessions.get(userId);
  if (!session) return null;
  if (Date.now() - session.lastActivityAt > SESSION_IDLE_MS) {
    liveSessions.delete(userId);
    session.browser.close().catch(() => {});
    return null;
  }
  return session;
}

function touchSession(userId) {
  const session = liveSessions.get(userId);
  if (session) session.lastActivityAt = Date.now();
}

async function closeSession(userId) {
  const session = liveSessions.get(userId);
  if (!session) return;
  liveSessions.delete(userId);
  await session.browser.close().catch(() => {});
}
```

Update `module.exports` to add `createSession, getSession, touchSession, closeSession`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/smoke/browser-ordering-loop.test.js`
Expected: PASS — all 15 tests green.

- [ ] **Step 5: Commit**

```bash
git add api/services/browser-task.js test/smoke/browser-ordering-loop.test.js
git commit -m "Add live browser-session store with idle eviction"
```

---

### Task 3: Clickable-element extraction

**Files:**
- Modify: `api/services/browser-task.js`

**Interfaces:**
- Consumes: a Playwright `Page` (from `launchBrowser`/`browser.newContext().newPage()`, already in the file).
- Produces: `extractClickableElements(page: Page): Promise<{id: number, text: string, locatorIndex: number}[]>`. Task 4 uses the returned array for `buildDecisionPrompt` and re-resolves `locatorIndex` against the same `page.locator(...)` query to click/fill.

This task has no unit test — it requires a real rendered page, which is exactly what the spec's manual testing plan (item 1, "check if Domino's has garlic bread") exercises. Verify it by hand in Step 2 below rather than `node --test`.

- [ ] **Step 1: Implement element extraction**

Add to `api/services/browser-task.js`:

```js
const CLICKABLE_SELECTOR = 'button, a, input, [role="button"]';
const MAX_ELEMENTS = 60;

async function extractClickableElements(page) {
  const locator = page.locator(CLICKABLE_SELECTOR);
  const count = await locator.count();
  const elements = [];
  for (let i = 0; i < count && elements.length < MAX_ELEMENTS; i++) {
    const el = locator.nth(i);
    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;
    const text = (await el.innerText().catch(() => ''))
      || (await el.getAttribute('aria-label').catch(() => ''))
      || (await el.getAttribute('placeholder').catch(() => ''))
      || (await el.getAttribute('value').catch(() => ''))
      || '';
    const trimmed = text.trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!trimmed) continue;
    elements.push({ id: elements.length, text: trimmed, locatorIndex: i });
  }
  return elements;
}
```

Update `module.exports` to add `extractClickableElements`.

- [ ] **Step 2: Verify by hand**

```bash
node -e "
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const { extractClickableElements } = require('./api/services/browser-task');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  console.log(await extractClickableElements(page));
  await browser.close();
})();
"
```

Expected: an array containing at least the "More information..." link on example.com, each entry shaped like `{ id, text, locatorIndex }`.

- [ ] **Step 3: Commit**

```bash
git add api/services/browser-task.js
git commit -m "Add generic clickable-element extraction for the ordering loop"
```

---

### Task 4: The main loop — `runOrderingTurn`

**Files:**
- Modify: `api/services/browser-task.js`

**Interfaces:**
- Consumes: `createSession`/`getSession`/`touchSession` (Task 2), `extractClickableElements` (Task 3), `buildDecisionPrompt`/`parseModelDecision`/`matchesPaymentKeyword` (Task 1), `loadStorageState`/`launchBrowser` (pre-existing), `runtime.createGeminiServiceClient`.
- Produces: `runOrderingTurn(userId: string, { url?: string, goal: string, onProgress?: (label: string) => void }): Promise<Outcome>` where `Outcome` is one of `{ type: 'done', text: string }`, `{ type: 'ask', question: string }`, `{ type: 'awaiting_more', summary: string }`, `{ type: 'ready_for_payment', summary: string, total: string }`, `{ type: 'error', error: string }`. This is what the `run_browser_task` case in `api/index.js` (Task 6) calls directly.

No unit test here — this is the Playwright + Gemini integration point the spec's manual testing plan (items 2–4) targets. Step 2 below is the hands-on verification.

- [ ] **Step 1: Implement the loop**

Add to the top of `api/services/browser-task.js`, alongside the other requires:

```js
const { createGeminiServiceClient } = require('../../runtime');

const FAST_MODEL = process.env.OXY_FAST_MODEL || process.env.GEMINI_FAST_MODEL || 'gemini-3.1-flash-lite';
const MAX_STEPS = 40;
const MAX_DURATION_MS = 4 * 60 * 1000;

let geminiClient = null;
function getGemini() {
  if (!geminiClient) geminiClient = createGeminiServiceClient();
  return geminiClient;
}
```

Add the loop itself, below `extractClickableElements`:

```js
async function decideNextAction(goal, history, elements) {
  const model = getGemini().getGenerativeModel({ model: FAST_MODEL });
  const response = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: buildDecisionPrompt(goal, history, elements) }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 300, responseMimeType: 'application/json' }
  });
  return parseModelDecision(response.response.text());
}

async function openNewSession(userId, url, goal) {
  const site = siteKeyFromUrl(url);
  const storageState = await loadStorageState(userId, site);
  const browser = await launchBrowser();
  const context = await browser.newContext(storageState ? { storageState } : {});
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return createSession(userId, { browser, context, page, goal, history: [], pendingPaymentLabel: null });
}

async function runOrderingTurn(userId, { url, goal, onProgress = () => {} }) {
  let session = getSession(userId);
  if (!session) {
    if (!url) return { type: 'error', error: 'That session expired (idle too long) and there\'s no url to restart it — ask the user which site/restaurant again.' };
    onProgress('Opening browser…');
    try {
      session = await openNewSession(userId, url, goal);
    } catch (error) {
      return { type: 'error', error: error.message };
    }
  } else {
    touchSession(userId);
    session.goal = goal; // latest message becomes the active instruction, history carries prior context
  }

  const startedAt = Date.now();
  let steps = 0;

  try {
    while (steps < MAX_STEPS && Date.now() - startedAt < MAX_DURATION_MS) {
      steps += 1;
      onProgress('Looking at the page…');
      const elements = await extractClickableElements(session.page);
      const decision = await decideNextAction(session.goal, session.history, elements);

      if (decision.action === 'invalid') {
        session.history.push(`Step ${steps}: could not decide an action (${decision.error})`);
        if (steps >= 3 && session.history.slice(-3).every(h => h.includes('could not decide'))) {
          return { type: 'ask', question: 'I\'m stuck on this page — what should I do next?' };
        }
        continue;
      }

      if (decision.action === 'done') {
        await closeSession(userId);
        return { type: 'done', text: decision.summary || 'Done.' };
      }

      if (decision.action === 'ask') {
        return { type: 'ask', question: decision.question };
      }

      if (decision.action === 'ready_for_payment') {
        // Store the real pay button's text (the cart-summary text never matches a
        // clickable element), so confirmPayment can re-find and click it later.
        const payEl = elements.find(el => matchesPaymentKeyword(el.text));
        session.pendingPaymentLabel = payEl?.text || null;
        return { type: 'ready_for_payment', summary: decision.summary, total: decision.total || '' };
      }

      // click or fill
      const target = elements.find(el => el.id === decision.elementId);
      if (!target) {
        session.history.push(`Step ${steps}: tried to act on element #${decision.elementId}, which no longer exists`);
        continue;
      }

      if (matchesPaymentKeyword(target.text)) {
        session.pendingPaymentLabel = target.text;
        return { type: 'ready_for_payment', summary: `Ready to ${target.text}`, total: '' };
      }

      const locator = session.page.locator(CLICKABLE_SELECTOR).nth(target.locatorIndex);
      if (decision.action === 'click') {
        onProgress(`Clicking "${target.text}"…`);
        await locator.click({ timeout: 10000 });
        session.history.push(`Step ${steps}: clicked "${target.text}"`);
      } else if (decision.action === 'fill') {
        onProgress(`Typing into "${target.text}"…`);
        await locator.fill(String(decision.value || ''), { timeout: 10000 });
        session.history.push(`Step ${steps}: filled "${target.text}" with "${decision.value}"`);
      }
      touchSession(userId);
    }
  } catch (error) {
    return { type: 'error', error: error.message };
  }

  return { type: 'awaiting_more', summary: `Still working on it — ${session.history.length} step(s) so far. Want me to keep going?` };
}
```

Update `module.exports` to add `runOrderingTurn`.

- [ ] **Step 2: Verify by hand**

With real `SUPABASE_URL`/`SUPABASE_KEY`/`GEMINI_API_KEY` set (see `.env.example`), run:

```bash
node -e "
const { runOrderingTurn } = require('./api/services/browser-task');
(async () => {
  const result = await runOrderingTurn('test-user', {
    url: 'https://example.com',
    goal: 'What does this page say?',
    onProgress: label => console.log('progress:', label)
  });
  console.log(result);
})();
"
```

Expected: progress lines logged, then a final `{ type: 'done', text: '...' }` answering from the page content — confirms the simple single-iteration case (spec testing item 1) works before trying a real multi-step site.

Then manually try a real add-to-cart flow on one real delivery/restaurant site per spec testing item 2, confirming it stops at `ready_for_payment` rather than clicking the actual pay button.

- [ ] **Step 3: Commit**

```bash
git add api/services/browser-task.js
git commit -m "Add the adaptive perception-action ordering loop"
```

---

### Task 5: Payment confirm/cancel

**Files:**
- Modify: `api/services/browser-task.js`

**Interfaces:**
- Consumes: `getSession`, `closeSession`, `extractClickableElements`, `findElementByText` (all prior tasks).
- Produces: `confirmPayment(userId: string): Promise<{ type: 'done', text: string } | { type: 'error', error: string }>`, `cancelPayment(userId: string): void`. Used by the `run_browser_task` case (Task 6) when resuming a pending-confirmation.

No unit test — depends on a live session reaching `ready_for_payment`, covered by the spec's manual testing item 5.

- [ ] **Step 1: Implement confirm/cancel**

Add to `api/services/browser-task.js`:

```js
async function confirmPayment(userId) {
  const session = getSession(userId);
  if (!session || !session.pendingPaymentLabel) {
    return { type: 'error', error: 'No order is waiting for payment confirmation — it may have expired.' };
  }
  try {
    const elements = await extractClickableElements(session.page);
    const target = findElementByText(elements, session.pendingPaymentLabel);
    if (!target) {
      return { type: 'error', error: `Couldn't find the "${session.pendingPaymentLabel}" button anymore — the page may have changed.` };
    }
    await session.page.locator(CLICKABLE_SELECTOR).nth(target.locatorIndex).click({ timeout: 10000 });
    const text = `Done — placed the order (${session.pendingPaymentLabel}).`;
    await closeSession(userId);
    return { type: 'done', text };
  } catch (error) {
    return { type: 'error', error: error.message };
  }
}

function cancelPayment(userId) {
  touchSession(userId);
}
```

Update `module.exports` to add `confirmPayment, cancelPayment`.

- [ ] **Step 2: Verify by hand**

Continue from Task 4's manual real-site test: once a turn returns `ready_for_payment`, in the same Node REPL/script call `confirmPayment('test-user')` and confirm it clicks the actual pay button and returns `{ type: 'done', ... }`. Separately, redo the flow and call `cancelPayment('test-user')` instead, then `getSession('test-user')` to confirm the session is still open and nothing was clicked.

- [ ] **Step 3: Commit**

```bash
git add api/services/browser-task.js
git commit -m "Add payment confirm/cancel for the ordering loop"
```

---

### Task 6: Wire into the chat action dispatch

**Files:**
- Modify: `api/action-contracts.js`
- Modify: `api/index.js`

**Interfaces:**
- Consumes: `runOrderingTurn`, `confirmPayment`, `cancelPayment`, `getSession` from `api/services/browser-task.js` (all prior tasks).
- Produces: the `run_browser_task` action's final behavior — nothing downstream of this depends on its internals.

- [ ] **Step 1: Update the action contract guidance**

In `api/action-contracts.js`, replace the `run_browser_task` entry's `inputExample` and `guidance` (leave `risk`, `required`, `optional`, `successSummary`, `failureSummary`, `confirmation` as they are):

```js
  run_browser_task: {
    risk: 'low',
    required: ['url', 'goal'],
    optional: ['title'],
    inputExample: { url: 'https://example.com/search (only needed to start a new task)', goal: 'Find listings under $1000 and summarize them, or order 1 large pepperoni pizza, or the user\'s reply to a question you previously asked', title: 'short label for the briefing' },
    guidance: 'Use when the user wants you to browse a real website and do/check something for them — e.g. "check Marketplace for X", "order me a pizza", "log into Z and check my balance". For anything food/shopping-related and vague ("order me something"), have a normal conversation first — ask what they\'re in the mood for, which restaurant, what items — before calling this action. This can run across several turns: if you previously asked the user a question via this action, or it told you it was still working, call it again with their reply as the goal and omit url — it resumes the same in-progress session rather than starting over. This may pause to ask you to confirm before any payment is finalized; never imply an order is placed until that confirmation step completes. Do not use for anything available via a connector (email, calendar, music, maps) — those are faster and more reliable.',
    successSummary: 'Browser task progressed',
    failureSummary: 'Browser task failed',
    confirmation: 'none'
  },
```

- [ ] **Step 2: Rewrite the `run_browser_task` case in `api/index.js`**

First, update the require near the top of the file (it currently imports `runBrowserTask`):

```js
const { runOrderingTurn, confirmPayment, cancelPayment, getSession } = require('./services/browser-task');
```

Delete the `runBrowserTaskAndNotify` and `summarizeBrowserResult` functions entirely (the loop now produces its own summaries via the `done`/`ready_for_payment` outcomes — no second Gemini call needed).

Replace the existing `case 'run_browser_task': { ... }` block with:

```js
    case 'run_browser_task': {
      const goal = String(params?.goal || '').trim();
      if (!goal) return { success: false, error: 'run_browser_task needs a goal.' };
      const url = String(params?.url || '').trim() || null;
      const title = String(params?.title || '').trim() || (url ? `Browser task: ${new URL(url).hostname}` : 'Browser task');
      const onProgress = label => context.sendStatus?.('action_progress', label, { action: 'run_browser_task' });

      if (context.bypassReview) {
        const outcome = getSession(userId)
          ? await confirmPayment(userId)
          : { type: 'error', error: 'No order is waiting for payment confirmation — it may have expired.' };
        if (outcome.type === 'error') return { success: false, error: outcome.error };
        return { success: true, text: outcome.text, cardText: title, actionSummary: 'Order placed' };
      }

      const outcome = await runOrderingTurn(userId, { url, goal, onProgress });

      switch (outcome.type) {
        case 'error':
          return { success: false, error: outcome.error };
        case 'done':
          return { success: true, text: outcome.text, cardText: title, actionSummary: 'Browser task finished' };
        case 'ask':
          return { success: true, text: outcome.question, cardText: title, actionSummary: 'Needs your input' };
        case 'awaiting_more':
          return { success: true, text: outcome.summary, cardText: title, actionSummary: 'Browser task paused' };
        case 'ready_for_payment': {
          const reviewAction = { type: 'run_browser_task', input: params };
          await setPendingAction(userId, reviewAction, context);
          const total = outcome.total ? ` Total: ${outcome.total}.` : '';
          return {
            success: true,
            pending: true,
            text: `Ready to order: ${outcome.summary}.${total} Say "confirm" to place it or "cancel" to stop.`,
            cardText: title,
            actionSummary: 'Awaiting payment confirmation',
            confirmation: 'review_required'
          };
        }
        default:
          return { success: false, error: `Unrecognized ordering-loop outcome: ${outcome.type}` };
      }
    }
```

Note: `cancelPayment` is intentionally unused here — the generic `isPendingCancelMessage` path in `api/index.js` already calls `clearPendingAction(userId)` and never re-invokes the action on cancel, which is exactly the spec's "session stays open, nothing clicked" behavior with zero extra code. It's still exported from `browser-task.js` for the manual test in Task 5 and as the documented cancel entry point.

- [ ] **Step 3: Syntax check**

```bash
node --check api/index.js && node --check api/action-contracts.js && node --check api/services/browser-task.js && echo OK
```

Expected: `OK`

- [ ] **Step 4: Run the full unit-test suite**

```bash
npm test
```

Expected: all tests pass, including `test/smoke/browser-ordering-loop.test.js` and the existing `test/smoke/action-contracts.test.js`/`pending-review.test.js` (confirms the contract edit didn't break anything they assert on).

- [ ] **Step 5: Manual end-to-end verification**

Per the spec's testing plan items 1–5, using the curl recipe already established for this app (`npm run dev`, register/login, `POST /chat?stream=true`):
1. "Check if Domino's has garlic bread" → single-turn `done`.
2. A real add-to-cart flow ending in the `confirm`/`cancel` prompt.
3. Send a follow-up message after a short pause → confirms it resumes the same session.
4. Confirm → confirms the exact payment element gets clicked once, session closes.
5. Redo and cancel → confirms nothing is clicked and the session is still adjustable.

- [ ] **Step 6: Commit**

```bash
git add api/action-contracts.js api/index.js
git commit -m "Wire the adaptive ordering loop into the run_browser_task action"
```

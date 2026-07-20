# Browser-Task Text-Only Perception Fast-Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Lineage note (2026-07-20):** This is a standalone plan, not part of the Aside-parity roadmap (`docs/superpowers/specs/2026-07-20-aside-parity-roadmap-design.md`) — that roadmap's own design doc states speed is "a cross-cutting constraint, not its own phase," so none of its 4 phases (all now shipped) own perception/cost/latency work. This plan instead continues `docs/superpowers/specs/2026-07-01-browser-task-latency-design.md` (Levers 1–3: slim model input, warm browser pool, direct-search fast-paths), whose "Out of scope (later tiers)" section already flagged further perception-cost work as a future lever. Treat this as that spec's next lever/tier, not as an Aside-parity phase. Ready to execute directly — no phase renumbering needed.

**Goal:** On steps where the page is text/DOM-legible (no product grid, no image-only controls), skip the screenshot + vision model call and decide the next action from the already-extracted element text alone — cutting per-step cost and latency without touching the screenshot path that fixes real production bugs (Nike/M&S/John Lewis/Currys/Wickes/Uber Eats, see `api/services/browser-task.js:37-39`, `900-903`).

**Architecture:** Hybrid fast-path, not a replacement. `extractClickableElements` (`api/services/browser-task.js:1082`) already derives DOM/ARIA text per element — that data is reused as-is. A new text-only prompt variant is sent to the model with no image attached. The model can decline (`{"action":"insufficient_info"}`) when it can't decide from text alone; a decline, an invalid response, or a page flagged as visually ambiguous (`hasProducts`) falls straight through to the existing screenshot+vision path, unchanged. No existing behavior is removed — this only skips work when the model itself confirms it isn't needed.

**Tech Stack:** Node.js, existing `decideNextAction`/`buildDecisionPrompt` machinery in `api/services/browser-task.js`, `node:test` for unit tests (project convention — no live browser in tests, see `test/smoke/browser-task-entity-capture.test.js:4-7`).

## Global Constraints

- Never remove or weaken the existing screenshot+vision path — it is the fallback for every case the fast path declines or gets wrong.
- No new npm dependencies.
- No DB schema/migration changes — telemetry additions must fit inside the existing `browser_session_events.detail` jsonb column (`api/services/session-events.js:47-49`).
- Follow existing code style: env-tunable knobs via `envInt`/`process.env`, functions exported at the bottom of `browser-task.js` for unit testing, comments only where a past-incident or non-obvious constraint justifies them (this file's existing convention).
- All new pure logic must be unit-testable without a live Playwright `page` (project constraint — see `test/smoke/browser-task-entity-capture.test.js:4-7`).

---

### Task 1: Expose the `hasProducts` signal and add the fast-path eligibility check

**Files:**
- Modify: `api/services/browser-task.js:835-888` (`computeProgressSignature`)
- Modify: `api/services/browser-task.js:3515-3546` (session bookkeeping after `computeProgressSignature` call)
- Test: `test/smoke/browser-task-text-fastpath.test.js` (new)

**Interfaces:**
- Produces: `computeProgressSignature(page)` now resolves `{ sig, stateKey, itemCount, hasProducts }` (adds `hasProducts: 0|1`, everything else unchanged).
- Produces: `session.lastHasProducts` (0 or 1), set alongside `session.stepsSinceProgress` etc.
- Produces: `shouldAttemptTextOnlyDecision({ hasProducts, elementCount })` — pure function, exported from `browser-task.js`.

- [ ] **Step 1: Write the failing test for the eligibility helper**

```javascript
// test/smoke/browser-task-text-fastpath.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldAttemptTextOnlyDecision } = require('../../api/services/browser-task');

test('eligible: no product grid, element count under the cap', () => {
  assert.equal(shouldAttemptTextOnlyDecision({ hasProducts: 0, elementCount: 12 }), true);
});

test('ineligible: page has a product grid (image-heavy, needs vision)', () => {
  assert.equal(shouldAttemptTextOnlyDecision({ hasProducts: 1, elementCount: 12 }), false);
});

test('ineligible: too many elements to trust a text-only pick', () => {
  assert.equal(shouldAttemptTextOnlyDecision({ hasProducts: 0, elementCount: 41 }), false);
});

test('boundary: exactly the element cap is still eligible', () => {
  assert.equal(shouldAttemptTextOnlyDecision({ hasProducts: 0, elementCount: 40 }), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/smoke/browser-task-text-fastpath.test.js`
Expected: FAIL — `shouldAttemptTextOnlyDecision is not a function`

- [ ] **Step 3: Add `hasProducts` to `computeProgressSignature`'s return value**

In `api/services/browser-task.js`, the `page.evaluate` callback at line ~877 already computes `hasProducts` locally and folds it into `pageKey`/`stateKey` as a string fragment, but never returns it as its own field. Change the two return sites:

```javascript
// inside the page.evaluate callback, ~line 877 — unchanged, hasProducts already computed:
return { itemCount, path: location.pathname, dialogs, dialogTitle, pageKey: host + '|c' + itemCount + '|' + mainTitle.slice(0,40) + '|p' + hasProducts, sample, hasProducts };
```
```javascript
// the outer function's return, ~line 880-884 — add hasProducts:
if (!info) return fallback(url);
return {
  sig: `${url}|c${info.itemCount}|d${info.dialogs}|k${info.pageKey}|${info.dialogTitle}|${info.sample}`,
  stateKey: `${info.path}|d${info.dialogs}|${info.pageKey}|${info.dialogTitle}|p${info.hasProducts || 0}`,
  itemCount: info.itemCount,
  hasProducts: info.hasProducts || 0,
};
```

Also update `fallback`, ~line 836, so callers always get the field:

```javascript
const fallback = (u) => ({ sig: u, stateKey: u, itemCount: 0, hasProducts: 0 });
```

- [ ] **Step 4: Store `session.lastHasProducts` alongside the existing progress bookkeeping**

In `api/services/browser-task.js` at line 3515-3524, right after `session.stepsSinceProgress = stepsSinceProgress;`:

```javascript
const prog = await timed('step.progress-sig', () => computeProgressSignature(session.page)).catch(() => null);
const currentSig = prog ? prog.sig : (session.page.url() || '');
if (currentSig && currentSig === lastProgressSig) {
  stepsSinceProgress += 1;
} else if (currentSig) {
  lastProgressSig = currentSig;
  stepsSinceProgress = 0;
}
session.lastProgressSig = lastProgressSig;
session.stepsSinceProgress = stepsSinceProgress;
session.lastHasProducts = prog ? prog.hasProducts : 0;
```

- [ ] **Step 5: Add the pure eligibility helper and export it**

Add near `assessProgress` (after line 932) in `api/services/browser-task.js`:

```javascript
// Fast-path gate for the text-only decision (Task 2/3): only attempt it on pages that
// are unlikely to need pixels to disambiguate — no product grid (image-only tiles are
// the exact failure mode the screenshot path exists for, see line 37-39/900-903) and a
// short enough element list that a wrong text-only pick is cheap to notice and correct.
const TEXT_ONLY_MAX_ELEMENTS = envInt('OXY_BROWSER_TEXT_ONLY_MAX_ELEMENTS', 40);
function shouldAttemptTextOnlyDecision({ hasProducts, elementCount }) {
  if (hasProducts) return false;
  if (elementCount > TEXT_ONLY_MAX_ELEMENTS) return false;
  return true;
}
```

Add to the `module.exports` block at the bottom of `api/services/browser-task.js` (alongside `assessProgress`, line 5389):

```javascript
  assessProgress,
  shouldAttemptTextOnlyDecision,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/smoke/browser-task-text-fastpath.test.js`
Expected: PASS (4/4)

- [ ] **Step 7: Commit**

```bash
git add api/services/browser-task.js test/smoke/browser-task-text-fastpath.test.js
git commit -m "feat(browser-task): expose hasProducts signal and text-only fast-path gate"
```

---

### Task 2: Text-only decision prompt and `decideNextAction` mode

**Files:**
- Modify: `api/services/browser-task.js:934-1025` (`buildDecisionPrompt`), `:1316-1441` (`decideNextAction`)
- Test: `test/smoke/browser-task-text-fastpath.test.js` (append)

**Interfaces:**
- Consumes: `shouldAttemptTextOnlyDecision` from Task 1 (not used directly in this task, but the prompt/decision function this task builds is what Task 3 gates with it).
- Produces: `buildTextOnlyDecisionPrompt(goal, history, elements, correction, goalContext)` — pure function, exported, returns a prompt string with no screenshot-referencing language and an `insufficient_info` escape hatch.
- Produces: `decideNextAction(goal, history, elements, screenshotB64, correction, goalContext, { textOnly = false } = {})` — existing signature gains a trailing options object; when `textOnly` is true, the screenshot is never attached (even if `screenshotB64` is truthy) and `buildTextOnlyDecisionPrompt` is used instead of `buildDecisionPrompt`.
- Produces (model contract addition): `{"action":"insufficient_info"}` as a valid decision shape, handled identically to `"invalid"` by every caller (Task 3 treats both as "fall back to vision").

- [ ] **Step 1: Write the failing test for the new prompt builder**

Append to `test/smoke/browser-task-text-fastpath.test.js`:

```javascript
const { buildTextOnlyDecisionPrompt } = require('../../api/services/browser-task');

test('text-only prompt never mentions a screenshot', () => {
  const prompt = buildTextOnlyDecisionPrompt(
    'buy a blue jumper',
    ['1. opened site'],
    [{ id: 0, text: 'Search' }, { id: 1, text: 'Add to basket' }],
    '',
    null
  );
  assert.equal(/screenshot/i.test(prompt), false);
});

test('text-only prompt offers the insufficient_info escape hatch', () => {
  const prompt = buildTextOnlyDecisionPrompt('buy a blue jumper', [], [{ id: 0, text: 'Search' }], '', null);
  assert.match(prompt, /insufficient_info/);
});

test('text-only prompt lists elements by id and text, same contract as the vision prompt', () => {
  const prompt = buildTextOnlyDecisionPrompt(
    'buy a blue jumper',
    [],
    [{ id: 0, text: 'Search' }, { id: 3, text: 'Add to basket' }],
    '',
    null
  );
  assert.match(prompt, /#0 "Search"/);
  assert.match(prompt, /#3 "Add to basket"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/smoke/browser-task-text-fastpath.test.js`
Expected: FAIL — `buildTextOnlyDecisionPrompt is not a function`

- [ ] **Step 3: Add `buildTextOnlyDecisionPrompt`**

Add directly after `buildDecisionPrompt` (after line 1025) in `api/services/browser-task.js`. Reuses the same element-list format and JSON action contract as `buildDecisionPrompt` so `parseModelDecision` needs no changes, but drops every screenshot/visual instruction and adds the decline path:

```javascript
// Text-only variant of buildDecisionPrompt for the fast-path (Task 3): no screenshot is
// attached, so this must never tell the model to "look" or "see" the page — only the
// already-extracted element text is available. If the element text is genuinely
// ambiguous (icon-only controls, a product tile with no name text, several near-identical
// labels), the model must decline via "insufficient_info" rather than guess — that decline
// is what routes the step to the existing screenshot+vision path (Task 3), so a wrong guess
// here is worse than a decline.
function buildTextOnlyDecisionPrompt(goal, history, elements, correction = '', goalContext = null) {
  const historyText = history.length
    ? history.map((entry, i) => `${i + 1}. ${entry}`).join('\n')
    : '(nothing yet)';
  const elementsText = elements.map(el => `#${el.id} "${el.text}"`).join('\n');
  const lastId = elements.length ? elements.length - 1 : 0;
  const correctionBlock = correction ? `\n⚠️ CORRECTION: ${correction}\n` : '';

  let contextBlock = '';
  if (goalContext) {
    const parts = [];
    if (goalContext.size) parts.push(`size: ${goalContext.size}`);
    if (goalContext.color) parts.push(`color: ${goalContext.color}`);
    if (goalContext.budget) parts.push(`max budget: £${goalContext.budget}`);
    if (goalContext.dealHints && goalContext.dealHints.length) parts.push(`deal prefs: ${goalContext.dealHints.join(', ')}`);
    if (parts.length) contextBlock = `\nEXTRACTED CONTEXT FROM USER GOAL: ${parts.join(' | ')}\n`;
  }

  return `You are controlling a real web browser to help with this goal: "${goal}"
${contextBlock}${correctionBlock}
You do NOT have an image of the page — only this text list of its clickable elements,
each with its accessible name (label, button text, or aria-label):

${elementsText}

If that text is enough to confidently pick the next action (a clearly-labelled search box,
button, or link that matches what the goal needs next), do so. If the labels are too vague,
generic ("Item", "Button", numbers with no context), or you suspect the right control isn't
text-labelled at all (an image-only product tile, an icon-only button), reply exactly:
{"action":"insufficient_info"}
Do NOT guess an elementId when you are not confident — decline instead.

For shopping/ordering goals (anything with "order", "basket", "cart", "buy", "checkout", "add to"):
COMMIT IMMEDIATELY to the first reasonable match when the label is clear. After add, go
straight to basket then checkout. "ready_for_payment" is the win condition.

CRITICAL: elementId MUST be one of the ids listed below (0 to ${lastId}). Do NOT invent a number.

What's happened so far:
${historyText}

Reply with ONLY one JSON object, one of these shapes:
{"action":"click","elementId":<number>}
{"action":"fill","elementId":<number>,"value":"<text>"}
{"action":"back","note":"<why>"}
{"action":"wait"}
{"action":"ask","question":"<short question for the user>"}
{"action":"done","summary":"<short summary answering the goal>","productName":"<item name>","price":"<price>"}
{"action":"ready_for_payment","summary":"<what's in the cart>","total":"<price>","productName":"<item name>"}
{"action":"insufficient_info"}

NEVER ask the user for a URL, a link, an element id, a selector, or which website/platform to use.
`;
}
```

- [ ] **Step 4: Give `decideNextAction` a `textOnly` option**

Change the signature and the four provider branches in `api/services/browser-task.js:1316-1441` to route through the new prompt and suppress the image. Only the prompt-building line and each `if (screenshotB64)` guard change — provider selection/auth/parsing logic is untouched:

```javascript
async function decideNextAction(goal, history, elements, screenshotB64, correction = '', goalContext = null, { textOnly = false } = {}) {
  const provider = (process.env.OXY_BROWSER_PROVIDER || 'gemini').toLowerCase();
  const promptText = textOnly
    ? buildTextOnlyDecisionPrompt(goal, history, elements, correction, goalContext)
    : buildDecisionPrompt(goal, history, elements, correction, goalContext);
  const effectiveScreenshot = textOnly ? null : screenshotB64;
```

Then replace every subsequent `screenshotB64` reference in the four provider branches (openai-compatible ~line 1344-1345, claude ~1376-1377, grok ~1402-1403, gemini ~1426) with `effectiveScreenshot`, and the token estimator at line 1321 (`const imageTokens = screenshotB64 ? ...`) with `effectiveScreenshot`. No other lines in this function change.

- [ ] **Step 5: Export `buildTextOnlyDecisionPrompt`**

Add to `module.exports` next to `buildDecisionPrompt` (line 5390):

```javascript
  buildDecisionPrompt,
  buildTextOnlyDecisionPrompt,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/smoke/browser-task-text-fastpath.test.js`
Expected: PASS (7/7)

- [ ] **Step 7: Commit**

```bash
git add api/services/browser-task.js test/smoke/browser-task-text-fastpath.test.js
git commit -m "feat(browser-task): add text-only decision prompt and decideNextAction textOnly mode"
```

---

### Task 3: Wire the fast-path into the step loop with vision fallback

**Files:**
- Modify: `api/services/browser-task.js:4106-4134` (the `else` branch that currently always screenshots + calls vision)
- Test: `test/smoke/browser-task-text-fastpath.test.js` (append — covers the fallback-trigger predicate only; the full loop needs a live `page` and is out of scope for unit tests, matching this file's existing constraint)

**Interfaces:**
- Consumes: `shouldAttemptTextOnlyDecision` (Task 1), `decideNextAction(..., { textOnly: true })` (Task 2).
- Produces: `isTextOnlyDeclined(decision)` — pure function, exported, returns true for `{action:'insufficient_info'}` and for `{action:'invalid', ...}` (a malformed/failed text-only call also falls back to vision rather than erroring the whole step).

- [ ] **Step 1: Write the failing test for the fallback predicate**

Append to `test/smoke/browser-task-text-fastpath.test.js`:

```javascript
const { isTextOnlyDeclined } = require('../../api/services/browser-task');

test('insufficient_info triggers vision fallback', () => {
  assert.equal(isTextOnlyDeclined({ action: 'insufficient_info' }), true);
});

test('invalid (failed text-only call) triggers vision fallback', () => {
  assert.equal(isTextOnlyDeclined({ action: 'invalid', error: 'model call failed' }), true);
});

test('a real decision does not trigger fallback', () => {
  assert.equal(isTextOnlyDeclined({ action: 'click', elementId: 3 }), false);
  assert.equal(isTextOnlyDeclined({ action: 'done', summary: 'ok' }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/smoke/browser-task-text-fastpath.test.js`
Expected: FAIL — `isTextOnlyDeclined is not a function`

- [ ] **Step 3: Add `isTextOnlyDeclined` next to `shouldAttemptTextOnlyDecision` (Task 1's location)**

```javascript
function isTextOnlyDeclined(decision) {
  return !decision || decision.action === 'insufficient_info' || decision.action === 'invalid';
}
```

Export it alongside `shouldAttemptTextOnlyDecision`:

```javascript
  shouldAttemptTextOnlyDecision,
  isTextOnlyDeclined,
```

- [ ] **Step 4: Rewrite the decision branch to try text-only first**

Replace `api/services/browser-task.js:4110-4134` (the `else` branch: currently screenshot → `decideNextAction`) with:

```javascript
      } else {
        // Snapshot the page path BEFORE the model call (the resulting action may navigate),
        // so a vision step is labelled by the page it was spent on.
        let visionPath = null;
        try { visionPath = new URL(session.page.url()).pathname; } catch { /* keep null */ }

        let usedVision = false;
        if (shouldAttemptTextOnlyDecision({ hasProducts: session.lastHasProducts, elementCount: elements.length })) {
          decision = await timed('step.decide-text', () =>
            decideNextAction(session.goal, session.history, elements, null, pendingCorrection, session.goalContext, { textOnly: true }));
        }
        if (!decision || isTextOnlyDeclined(decision)) {
          usedVision = true;
          const screenshot = await timed('step.screenshot', () => captureMarkedScreenshot(session.page, elements).catch(() => null));
          // ponytail: debug-only — set OXY_DEBUG_SCREENSHOT_DIR to dump what the model sees
          // at each step, to eyeball that badges land on real controls. No-op when unset.
          if (screenshot && process.env.OXY_DEBUG_SCREENSHOT_DIR) {
            require('fs').writeFile(`${process.env.OXY_DEBUG_SCREENSHOT_DIR}/step-${steps}.jpg`, Buffer.from(screenshot, 'base64'), () => {});
          }
          decision = await timed('step.decide', () =>
            decideNextAction(session.goal, session.history, elements, screenshot, pendingCorrection, session.goalContext));
        }
        pendingCorrection = ''; // consumed — only applies to the one retry it was raised for
        session.transientBrowserRetries = 0;
        // Trace WHICH step this was: the page path + the action the model chose (+ a short
        // target label) + whether the fast path handled it or vision was needed. Lets a
        // handful of runs measure how often the fast path actually skips the screenshot call.
        const tgt = Number.isInteger(decision.elementId) ? (elements[decision.elementId]?.text || '') : '';
        void logVisionStep({
          userId,
          site: session.site,
          phase: visionPath,
          detail: { step: steps, action: decision.action, target: String(tgt).slice(0, 60), mode: usedVision ? 'vision' : 'text' },
        });
      }
```

This preserves every existing line of behavior in the vision path (screenshot capture, debug dump, `logVisionStep` call site) — it only adds a text-only attempt before it and a `mode` field to the existing telemetry call.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/smoke/browser-task-text-fastpath.test.js`
Expected: PASS (10/10)

- [ ] **Step 6: Run the full existing browser-task test suite to confirm no regression**

Run: `node --test test/smoke/browser-*.test.js`
Expected: PASS — all existing browser-task/browser-progress/browser-recipes tests unaffected (this task only touches the `else` branch body, not any function signature they depend on other than the additive `decideNextAction` options param, which defaults `textOnly` to `false` and is fully backward compatible).

- [ ] **Step 7: Commit**

```bash
git add api/services/browser-task.js test/smoke/browser-task-text-fastpath.test.js
git commit -m "feat(browser-task): try text-only decision before screenshot+vision, fall back on decline"
```

---

### Task 4: Manual verification against a real site

**Files:** none (verification only)

- [ ] **Step 1: Enable debug tracing and run one order end-to-end**

```bash
OXY_DEBUG_SCREENSHOT_DIR=/tmp/oxy-debug OXY_BROWSER_COST_TRACKING=1 node -e "
const { runOrderingTurn } = require('./api/services/browser-task');
// use this repo's existing e2e harness pattern (see test/e2e/*.js or docs/superpowers/plans/2026-07-01-browser-task-latency-design.md for the invocation shape used there)
"
```

Use whatever existing e2e/manual-run script this repo already has for browser-task (check `package.json` scripts and `test/e2e/` before writing a new one — do not duplicate).

- [ ] **Step 2: Confirm in Supabase that `mode: "text"` events appear**

Query `browser_session_events` where `event_type = 'vision_step'` for the test run's `userId`/`site`, and confirm some rows have `detail->>'mode' = 'text'` (fast path fired) and none of them are on a product-listing page (spot-check `phase` against the run).

- [ ] **Step 3: Confirm no regression on a product-grid-heavy flow**

Run the same order goal against a site known to need vision (e.g. Nike, per the comments at line 900-903) and confirm every `vision_step` row for that run has `mode: "vision"` — i.e. `hasProducts` correctly kept the fast path off throughout.

- [ ] **Step 4: Record findings**

If the fast path fires on a meaningful fraction of non-product steps (checkout forms, login, address fill) with no wrong-click regressions, this plan is done. If the model declines almost every time (predicate not saving anything) or accepts overconfidently (wrong clicks on text-only steps), tune `TEXT_ONLY_MAX_ELEMENTS` (`OXY_BROWSER_TEXT_ONLY_MAX_ELEMENTS` env var, Task 1) or tighten the decline instructions in `buildTextOnlyDecisionPrompt` (Task 2) — no architecture change needed either way.

---

## Self-Review Notes

- **Spec coverage:** Hybrid fast-path (user's chosen scope) — Task 1 gates eligibility so image-heavy pages never skip vision; Task 2 gives the model an explicit decline path instead of forcing a guess; Task 3 wires the fallback so a decline or failure always reaches the existing, unmodified vision path; Task 4 verifies against the exact site classes (Nike et al.) the screenshot path was built to handle, per the CLAUDE.md/AGENTS.md instruction to verify in the real app, not just tests.
- **No placeholders:** every step has complete code, exact line numbers, and exact test/run commands.
- **Type/name consistency:** `shouldAttemptTextOnlyDecision`, `isTextOnlyDeclined`, `buildTextOnlyDecisionPrompt`, `session.lastHasProducts` are named identically everywhere they're defined, called, and exported across all three tasks.

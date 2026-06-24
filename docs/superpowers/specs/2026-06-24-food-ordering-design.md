# Agentic browser ordering — design

Date: 2026-06-24
Status: approved, not yet implemented

## Problem

`run_browser_task` (existing) can navigate to a page, run a fixed pre-decided list of
click/fill steps, and read the result once. That's enough to "check if X is in stock"
but not enough to order food: ordering requires deciding what to click *after seeing
what the previous click did* (search → pick restaurant → pick items → cart → checkout),
generically across whatever site the user names (Uber Eats, Deliveroo, Just Eat, a
restaurant's own site) rather than hardcoded per-site selectors.

Two assumptions from the first pass turned out to be wrong and reshaped this design:

- **Deep-linking does not hand off a built cart.** Opening the same site logged into
  the same account, in a different browser/tab, does not show you the cart the agent
  built — carts are tied to the specific browser session, not just the account. So
  "build the cart, then send the user a link to finish" does not work, at all, for
  food ordering or similar checkout flows (the user confirmed this from experience,
  including with Amazon: a link just gets you to *a* page, not your in-progress cart).
- **A hard step/time cap that aborts loses real progress for no reason.** If the user
  wants to step away and pick an order back up later, killing the loop and discarding
  the cart is the wrong failure mode. Caps should checkpoint, not destroy.

Both of those push the design toward: one continuous, resumable browser session that
the assistant itself drives end-to-end, including the final payment click, gated by
explicit per-order confirmation — rather than building and handing off.

## Scope

**In scope (this spec):**
- Generic, adaptive, multi-step browser control loop (perception → decide → act),
  replacing the fixed-steps behavior inside `run_browser_task`.
- A resumable live session per user so an order can be paused and picked back up
  across multiple chat turns.
- Assistant completes checkout itself — including the final "Pay"/"Place order" click —
  using whatever payment method is already saved on that site/account, gated behind
  the user explicitly confirming each order before that click fires.

**Out of scope (separate future project, explicitly deferred):**
- An AI-owned payment instrument (virtual card, its own funding source, spend limits).
  Not needed for v1: the assistant uses the *user's* already-logged-in account and its
  already-saved card, the same way a human assistant using your laptop would. A
  separate AI-owned-budget system is a real future idea but independent of whether
  ordering works at all.
- Concurrent multi-cart sessions (ordering from two places at once). One live session
  per user in v1; starting a second order while one is open continues/asks about the
  existing one instead of opening a second.
- Cross-process/multi-instance session affinity. The live session lives in one Node
  process's memory; this is fine at current single-instance scale and is called out
  below as a known limitation, not solved here.

## Architecture

### Live session store

```
liveBrowserSessions: Map<userId, {
  browser, context, page,      // the actual open Playwright objects — not serialized
  goal: string,                 // the user's ordering goal, accumulated across turns
  history: Array<{step, result}>, // what's been clicked/filled so far, fed back to the model each iteration
  site: string,
  lastActivityAt: number
}>
```

This lives in `api/services/browser-task.js` (extended) as module-level state, alongside
the existing `loadStorageState`/`saveStorageState` Supabase-backed cookie persistence
(unchanged — still used to start a *new* session pre-logged-in).

An idle sweep (checked lazily on each access, no separate timer) closes and evicts any
session whose `lastActivityAt` is older than **20 minutes**, calling `browser.close()` to
free the process. Resuming after eviction is best-effort: cookies are restored from
`browser_sessions` and the page re-navigates to last known URL, but the cart may not
have survived — this is communicated to the user, not silently assumed to work.

### The loop

One call = one batch, run synchronously inside the live chat turn (same as the existing
`run_browser_task` live path), capped at **40 steps or 4 minutes**, whichever comes first.
Each iteration:

1. **Perceive**: extract every visible clickable element (button/link/input) from the
   DOM into a numbered list with its visible text — no screenshots/vision, this is a
   cheap text extraction so it works generically across sites without per-site
   selectors.
2. **Decide**: send `{ goal, history, elements }` to Gemini (FAST_MODEL,
   `responseMimeType: 'application/json'`, same pattern used elsewhere in `api/index.js`)
   asking for exactly one of:
   - `{ action: "click", elementId }`
   - `{ action: "fill", elementId, value }`
   - `{ action: "ask", question }` — genuine ambiguity (e.g. three matching restaurants,
     a menu item needs a size) the model can't resolve from context alone
   - `{ action: "done", summary }` — goal answered without ordering anything (the old
     "check a page" behavior is just this case firing on iteration 1)
   - `{ action: "ready_for_payment", summary, total }` — cart is built, nothing left
     but to pay
3. **Guard** (deterministic, not a prompt instruction): before executing any `click`,
   check the chosen element's text against a fixed list of finalize/payment keywords
   (`place order`, `pay now`, `confirm purchase`, `complete order`, `checkout & pay`,
   buy now, submit payment — case-insensitive substring match). A match forces
   `ready_for_payment` regardless of what the model asked for. This is the actual
   backstop against an accidental real charge; the model is never trusted alone on
   this.
4. **Act**: execute the click/fill (or stop, for `ask`/`done`/`ready_for_payment`).
5. Append to `history`, loop.

Live progress streams via the existing `context.sendStatus` SSE mechanism
(`action_progress` events — already wired, zero client changes) — one event per
iteration, e.g. "Looking at the page…", "Clicking 'Add to basket'…".

### Turn outcomes

A batch ends in one of four ways, each handled differently by the `run_browser_task`
case in `api/index.js`:

| Loop result | What the user sees | Session state |
|---|---|---|
| `done` | Normal answer, same as today's simple check | Session can close (nothing pending) |
| `ask` | The clarifying question, as a normal reply | Stays open, next message resumes the loop with the answer appended to `history` |
| Step/time cap hit, no terminal state yet | Progress summary + "want me to keep going?" | Stays open, next message resumes |
| `ready_for_payment` | Order summary + total, via the **existing `review_required` / pending-action flow** (`setPendingAction`, "say confirm to continue or cancel to stop") — same UX as `make_call`/`send_email` today | Stays open, waiting for confirm/cancel |
| Selector/navigation error | Normal action failure (`success: false`) | Stays open, user can ask it to retry |

### Payment confirmation

On the user's **confirm**: the pending-action replay re-invokes `run_browser_task` with
`bypassReview: true`. Because the session is still live, this does **not** re-run the
loop from scratch — it directly clicks the exact element identified as the payment
button in step 3 above, using whatever the loop already built. One click, no
re-navigation, no risk of double-submitting.

On **cancel**: nothing is clicked. Session stays open (idle timeout still applies) in
case the user wants to adjust the order rather than restart.

## Action contract change

`run_browser_task`'s `steps` param is removed (no more pre-decided step lists — the
loop decides steps live). `url` and `goal` stay; `goal` is also what accumulates
across turns for a resumed session. Guidance text updated to tell the model: ask what
the user's in the mood for / which restaurant before calling this with anything food-
related and vague, same as it already won't guess a vague `play_music` query.

## Error handling

- Site blocks the bot / selector never appears: surfaces as a normal failed action;
  session stays open for a retry rather than tearing down.
- Gemini returns an unparseable/invalid action: treated as one failed step, retried
  up to 2 times before falling back to `ask` ("I'm stuck here, what should I do?").
- Server restart mid-order: session is gone (in-memory only) — next message about that
  order starts fresh. Acceptable at current scale; flagged as a known limitation, not
  solved here.

## Testing

No framework — this is exploratory browser behavior, not unit-testable logic. Manual
verification plan:
1. Single-turn case (no ambiguity, no payment): "check if Domino's has garlic bread" —
   confirms loop still does the old simple-check behavior as iteration-1 `done`.
2. Multi-step add-to-cart on one real site, ending at `ready_for_payment`, confirm the
   guardrail catches the actual "Place order" button text on that site.
3. Pause/resume: start an order, send no message for a bit (under 20 min), send a
   follow-up ("add fries too") — confirm it resumes the same session instead of
   restarting.
4. Idle-timeout path: start an order, wait past 20 minutes (or lower the TTL
   temporarily for the test), resume — confirm it behaves per the documented
   best-effort path rather than crashing.
5. Confirm/cancel: reach `ready_for_payment`, send "cancel" — confirm nothing is
   clicked and the session is still adjustable; then redo and "confirm" — confirm the
   exact payment element gets clicked once.

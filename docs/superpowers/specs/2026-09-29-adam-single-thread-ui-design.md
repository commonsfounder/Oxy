# Adam single-thread UI — design

Date: 2026-09-29. Status: build in progress (see "Build status" at the end). Supersedes the four-tab iOS layout (Adam / Home / Activity / You) and the dark, blue-heavy card look.

## Problem

The current app looks the same everywhere (near-black, boxes, blue), Activity is a wall of "Done" rows titled with raw messages, Home is mostly empty, and nothing tells you what matters most. The goal: polished, intuitive, calm, and a continuous loop of delight (ask → Adam works → approve or see result → next step).

## Who it is for

One person: someone who keeps a household running (bookings, deliveries, messages, reminders, often for other people) and who finds technology stressful. They want it done, and want to know it was done. They are not developers, small-business owners, or people who want a "chief of staff".

Consequences for every screen:
- No jargon anywhere. Test for each label: would someone who has never heard of AI agents understand it instantly?
- Never-allowed words on screen: task, workflow, routine, agent, connector, capability, run, execute, integration, runtime, prompt. Use ordinary ones: "waiting", "needs a yes", "stopped for now", "your apps".
- Titles are short summaries of what happened ("Messaged Arina"), never the user's raw message.
- Approvals read "Yes, do it" / "Not yet". Anything that spends money or messages a person always asks first, and that is presented as reassurance, not friction.
- Errors and dead ends are said in human words with a next step ("Couldn't reach the salon. Try another?"). Nothing ever just says "failed".
- Text is comfortably large by default, tap targets are generous, voice is as easy as typing.
- Every action says clearly what happened afterwards, and where possible offers undo.
- Copy stays terse and factual (DESIGN.md): plain does not mean chatty or cute.

## Shape of the app

- One screen: a single conversation thread. No tab bar, no thread list, no sidebar.
- Bottom: a persistent ask bar (text or voice).
- Top: "Adam" with a one-line status, and the user's avatar. The avatar opens everything that is management rather than doing: devices/home, connected services, settings, full history.
- Activity and Home tabs are removed. Their content appears in the thread (results, watches, approvals) or behind the avatar (devices, history).
- Empty state: designed, factual, no invented content (per DESIGN.md).

## Thread content

- User messages: right-aligned, quiet neutral bubble.
- Adam text: plain, no bubble, few words.
- Approvals, choices, drafts, progress and results: **cards** inline in the thread.
- Watches ("will message Arina at 16:04") are small chips in the flow at the moment they were requested, and turn into a result line when they fire.
- Results are one quiet line ("✓ Messaged Arina"), not a card, unless they carry something to act on.
- After a result, Adam may offer one natural next step as a chip ("Track delivery").

## Visual language

- Light, thin-outline cards (1px hairline, no heavy shadow, no bold-everywhere). Regular/medium weights for essential text (DESIGN.md forbids light weights).
- Very few words per card. Detail (limit, card, full text) is on tap.
- Radius and type follow DESIGN.md; system font; icons from bundled assets only (no SF Symbols).

## Colour and background: role-based and adaptive

Colour is defined as roles, never fixed values: background, card fill, outline, primary text, quiet text, **main action** (highest-contrast surface against the current background), quiet action, **working** (Adam is doing something), **needs you** (amber), **done** (green), **failure** (red).

- Automatic light and dark.
- User-chosen thread background (a tone or wallpaper, as in Telegram/iMessage). All roles are recomputed from it, including the main action colour, and text must meet WCAG AA against it; if a wallpaper cannot satisfy this, a scrim is added.
- Default light: near-white background, black main action, blue used only for "working" (progress, live watches). Default dark inverts (white main action).
- Not in scope: Adam changing the look by itself (time of day, task mood).

## Task-shaped cards: a fixed set with peaks

Adam picks a card shape from a fixed set and fills in fields; it does not invent layouts.

- **Floor** (always clean, consistent): approval, choice list, draft, progress, basket, itinerary, map, result, generic fallback for unknown tasks.
- **Peaks** (hand-made, animated, with haptics) for moments a person feels: payment approved (button fills, receipt unfolds), train/booking confirmed (ticket slides in, dashed edge tears off), message sent, long task finished / watch fired. Peaks are rare on purpose. New peaks are added one at a time, payment first.
- Reduce Motion replaces peaks with a simple fade and one haptic.

## Works outside the app

Every card has a plain version: a message plus buttons (Approve / Not now, numbered choices). This is what iMessage and Telegram show (Telegram already has inline buttons). Rich versions render only in the app. The thread must never depend on a rich card to be usable.

## Build order

1. Thread screen, ask bar, avatar menu, tabs removed, history moved behind avatar.
2. Colour roles and adaptive background (light/dark, then user background).
3. Floor card shapes bound to real data (approvals, watches, results, tasks).
4. Peak #1: payment approved. Then booking, message sent, task finished.
5. Plain-text card versions for Telegram/iMessage, reusing the same card data.

## Not doing

- Model-generated free-form layouts.
- Multiple threads or a chat list.
- Auto-changing themes.
- Any invented rooms, devices or readings.

## Open items for the plan

- Exact list and field schema of floor shapes, taken from existing approval/task/watch objects.
- Where history lives and how far back the thread loads.
- Whether iMessage becomes a real channel (out of scope here; the plain card versions just keep it possible).

## Build status (2026-09-29)

Built, committed on `main`, simulator-checked in light and dark; not pushed or deployed:
- Single thread, tab bar removed, avatar-less menu button opens "Everything Adam did", "Home", "You" (`MainTabView.swift`).
- Colour roles and calmer thread look (`AppTheme.swift`); user-chosen background (Automatic, Warm, Sea, Night) under You > Look, forcing the matching light/dark palette.
- Thread cards from the real home board (`ThreadBoardCards.swift`): finished, working, needs-a-yes; approval acknowledgement with a drawn tick; finish moment shown once per completed item.
- Plain-words pass on menu, Activity, You, apps, settings, timeline; Telegram approval buttons now say "Yes, do it" / "Not yet".

Not built yet:
- Peaks beyond payment/finish: train or booking ticket reveal, message-sent flight.
- Plain-text card versions for iMessage (Telegram already gets buttons); iMessage as a real channel.
- Full plain-words sweep of screens not reachable from the menu, and backend-generated copy.
- Not tested against a live approval or a live completion; card show-once logic and persistence need a run on a device.
- The old "new conversation" button is hidden in the thread header; conversation history still exists behind "Everything Adam did".

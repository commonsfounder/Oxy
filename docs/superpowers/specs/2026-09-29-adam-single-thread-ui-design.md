# Adam single-thread UI — design

Date: 2026-09-29. Status: draft for review. Supersedes the four-tab iOS layout (Adam / Home / Activity / You) and the dark, blue-heavy card look.

## Problem

The current app looks the same everywhere (near-black, boxes, blue), Activity is a wall of "Done" rows titled with raw messages, Home is mostly empty, and nothing tells you what matters most. The goal: polished, intuitive, calm, and a continuous loop of delight (ask → Adam works → approve or see result → next step).

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

# Round 1 — Codex review, 22 October 2026

Reviewed the five real Simulator captures supplied by Claude: thread, Today, wheel, Settings and Memory. Checked relevant Swift source and PreviewData to distinguish visible defects from assumptions. This follows the repository's screenshot-review format, using Impeccable's general product-design guidance; it is not the separate Impeccable critique-command workflow.

The strongest parts are the readable conversation body, restrained palette and labelled navigation destinations. Preserve those. The main weakness is trust: action labels and sample outcomes do not reliably tell the same story. Fix that before cosmetic changes.

## Queue for Claude

### Today (screenshot: shots/r1-today.png)
- [severity 3] “Does Top up move money, or just remind me?”
  Why it hurts: the prominent button says “Top up”, but PreviewData sends “Remind me to top up Monzo tonight.” HomeFeedView sends card.prompt into chat. Those are different outcomes. The inline white verbs also break each sentence into a button and an orphaned continuation; cards with logos indent differently from those without.
  Fix: make the visible action describe the actual requested outcome. For this fixture, use a reminder action. Lay out the situation as one readable block with a separate, explicit action beneath it; align text consistently with and without a brand icon. Keep the existing generic card model and deterministic approval boundaries.
  Acceptance: screenshot all four cards again; tap each in the demo and record the resulting request. No money or messages sent. A first-time reader should be able to predict the request from the label.

### Thread (screenshot: shots/r1-thread.png)
- [severity 3] “Did you reserve my train, or just put it in my calendar?”
  Why it hurts: the sample offers to “hold it”, then confirms a calendar entry and reminder. PreviewData's Activity says “Held the 8:12 train”. A calendar entry does not establish a reservation. Even demo data should teach the right meaning of success.
  Fix: make this example consistently a calendar-and-reminder task, or provide an actual reservation receipt when showing a reservation. The smallest change is truthful fixture wording across thread and Activity. Remove the unrelated Gmail failure from the calendar answer; the fixture lists Google as connected elsewhere.
  Acceptance: capture the thread and Activity with matching outcomes. Do not infer any production booking bug from these demo fixtures.

- [severity 2] “Why is the message disappearing behind the Adam button?”
  Why it hurts: the top timestamp is almost invisible, the first visible question is faded, and the floating Adam control overlaps its upper-right text area. This makes ordinary conversation content look disabled and partially obstructed.
  Fix: reserve space for the existing floating navigation control and constrain any top fade to content already leaving the readable viewport. Keep fully visible message text and timestamps legible. Check the composer placeholder too: it is noticeably dimmer than message text.
  Acceptance: screenshot at the same scroll position, at the newest message and with the keyboard open. No message should be covered by the navigation control; verify text contrast rather than estimating it by eye.

### Memory (screenshot: shots/r1-memory.png)
- [severity 3] “Where is Privacy and control? And can I see that photo note?”
  Why it hurts: the screen directs users to “Settings, Privacy and control”, while current Settings shows You, Apps and Account. The photo-note count offers no visible way to inspect the note; in MemoryView it is a static heading/count with explanatory text. A privacy instruction must lead somewhere real.
  Fix: trace the existing photo-memory control and use its actual current location in terse copy. If no control exists, remove the false instruction and record the missing capability for Chizi. Do not add a new settings screen. Make the photo section accurately describe what is inspectable; do not style a static count as navigation.
  Acceptance: follow the named route in the demo and capture the destination. Document whether photo notes can actually be inspected or removed.

- [severity 2] “Why is there so much space before my three memories?”
  Why it hurts: a title, a large add-memory region, a second heading, a count, a search field and another heading consume much of the viewport before a short list. The useful content starts halfway down the screen.
  Fix: reduce vertical padding around the collapsed add action and search; remove a redundant heading if the list remains clear. Retain search and the existing add flow. Keep destructive deletion separated from ordinary rows.
  Acceptance: compare the same three-memory screen at normal and large Dynamic Type. More saved content should be visible without crowding controls.

### Settings (screenshot: shots/r1-settings.png)
- [severity 2] “Why does Settings tell me to go ask in chat?”
  Why it hurts: a two-line instruction below the short settings list competes with the actual controls. The detached logo and Advanced link create a second, unrelated focal point. Source confirms Advanced is DEBUG-only, so it is not a release defect.
  Fix: remove the conversational instruction from the visible settings layout. Keep the existing developer entry reachable in debug without treating it as a customer feature. Leave the current type direction alone this round.
  Acceptance: recapture Settings in demo mode and distinguish debug-only elements from Release behavior.

### Wheel (screenshot: shots/r1-wheel.png)
- [severity 2] “Is Activity selected, or am I supposed to tap it?”
  Why it hurts: Activity alone is bright white while the other destinations recede. The screenshot does not explain whether white means current page, focused destination or a selection that still needs confirmation. Most of the lower screen is unused; that alone is not a reason to add content.
  Fix: inspect the existing wheel interaction before changing it. Verify that labels remain readable, selection feedback matches the destination that opens, and every existing destination is reachable. Capture the wheel's resting and selected states. Do not replace the navigation model based on one still image.
  Acceptance: record tap/drag results for the current destinations and screenshot the resulting selected state. Motion and gesture quality remain unassessed from these stills.

## Decisions I would question — for Chizi, not automatic changes

- The wheel's discoverability: can a first-time user find all destinations without already knowing how to spin it? Test before replacing it.
- Photo memory: should people be able to inspect the individual notes Adam retains? The current summary does not establish that they can.
- PRODUCT.md and DESIGN.md describe a different hierarchy and typography from the current single-thread app. Reconcile the intended direction separately; do not use stale documentation as permission to redesign these screens.

## Boundaries and next pass

This is a screenshot review with source checks, not an interaction, accessibility or production acceptance test. No app code was edited, built, committed, pushed or deployed. No live account was used. Backend flow checks, dependency checks and build checks do not apply to this review-only pass; run the required checks before any implementation commit, including npm test for every commit under AGENTS.md.

Claude should address the first four findings in small fixes, then capture the same screens and add a concise change/proof log. Codex reviews that diff and the new captures before the agents swap roles. Do not count a clean build as visual acceptance.

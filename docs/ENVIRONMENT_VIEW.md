# Watching Adam work

The current runtime has a headless Chromium browser, controlled text workspaces and isolated project directories. It does not provision a desktop VM for each task. This feature exposes the real browser screen and recorded task activity without inventing a desktop or changing the agent loop.

Each active task carries a live window directly in the thread, including tasks awaiting approval. Tap the window once to open its full-screen workspace at readable scale. Pinch/pan inspect the image; **Fit** gives an optional overview. The last observed browser action stays docked below the screen, while **Activity** opens recorded steps and outputs. **Workspace** in the wheel is a fallback entry, also full-screen. Ordinary API/connector work can have activity and outputs without a browser screen.

Screen capture and activity refresh independently, so a slow history request cannot freeze the screen. Live images preserve zoom and position across updates. Captures stop being labelled live after six seconds without a fresh read, and show **Last capture** while waiting; unavailable/disconnected responses clear the image. Entered values and selected field values never appear in action labels.

`GET /agent/environment` returns the authenticated user's current browser. `GET /agent/tasks/:id/environment` also checks task ownership and requires that browser to be bound to the selected task. `browser_open` carries the durable task id into the session. The observer cannot click, type, approve, start or resume a session, and viewing does not extend its idle timeout.

Captures are bounded JPEGs from the actual page, coalesced across concurrent viewers, with password controls masked. URL queries/fragments and raw errors are not exposed. Captured time is shown; unavailable/disconnected states clear the image instead of relabelling an old frame as live. Responses are authenticated and `no-store`, with no public viewing token or CDP/VNC address.

The browser session is currently process-local. A release using multiple Fly instances needs session-owner routing before it can promise viewing from any instance. A full desktop VM/terminal stream remains separate provider work; this is a live browser observer and recorded workspace activity.

Verification:

- `node --test test/smoke/environment-view.test.js test/smoke/environment-view-routes.test.js` checks ownership, task matching, capture coalescing, expiry/replacement, failure and HTTP authentication.
- `node test/dev/environment-view-eval.js /private/tmp/adam-environment-view` starts a real browser and authenticates against the real HTTP observer route, verifies changed screen pixels after a browser action, then confirms a closed session clears the frame. It uses a clearly labelled local test page and performs no external task.
- `OXY_OBSERVER_PREVIEW=1` on that runner keeps the browser and local server open for simulator inspection. This test-only preview adapter supplies local test authentication. Its printed URL can be supplied via the `-oxy_custom_backend_url` launch argument; `OXY_DEBUG_OPEN=environment` opens the viewer. End the runner with Ctrl-C.

Local proof on 7 October 2026: the simulator showed the actual browser capture, then automatically changed from **After the action** to **Visible update**, with a later captured timestamp. Tapping the inline window opened the full-screen workspace; **Fit** changed the scale and **Activity** opened the activity pane. Captures are in `.impeccable/review/environment/`. The rebuilt iOS app reported `SUCCEEDED`; the smoke suite reported 1944 passed, zero failed and two skipped out of 1946 tests. Undefined-variable checking reported zero errors and one existing unused-directive warning. The real-browser evaluator also verifies action labels omit input values.

The first iOS build found an error-name collision, corrected before the successful rebuild. Simulator review found that waiting for an active scene before the initial fetch could leave a spinner; the initial read now runs on presentation, with subsequent polling paused in the background. The user rejected the initial hidden menu/small sheet/Expand sequence as bad UX; that flow was replaced. Native panning/pinch behavior remains unverified: the attempted automated swipe produced no visible movement. No commit, push, deployment or physical-phone installation is implied by these local checks.

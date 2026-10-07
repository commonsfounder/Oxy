# Browser sandbox (E2B)

Each user can have their own persistent machine for browsing: a real, headed Chromium with an
on-disk profile, running in an E2B sandbox. Adam drives it over CDP, so the browser primitives
(`browser-environment.js`) are unchanged. An idle sandbox is paused with its memory, so tabs,
logins and the profile are still there next time.

Off by default. With it off, the browser is the local headless Chromium as before.

## Turn it on

1. Make an E2B account and API key.
2. Build the image (once, and again after editing `sandbox/e2b/`):
   `E2B_API_KEY=... node sandbox/e2b/build.js`
3. Set Fly secrets: `E2B_API_KEY`, and `OXY_BROWSER_BACKEND=e2b`.
4. Deploy. Check `fly logs` for `[browser-session] sandbox browser unavailable` — if it appears,
   tasks are falling back to the local browser. `OXY_BROWSER_BACKEND_STRICT=1` fails instead.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `OXY_BROWSER_BACKEND` | `local` | `e2b` to use sandboxes |
| `E2B_API_KEY` | — | required for `e2b` |
| `OXY_E2B_TEMPLATE` | `oxy-browser` | template name |
| `OXY_E2B_TIMEOUT_MS` | 900000 | safety net: an abandoned sandbox pauses after this |
| `OXY_E2B_PAUSE_DELAY_MS` | 90000 | pause this long after the last session closes |
| `OXY_E2B_BOOT_TIMEOUT_MS` | 30000 | wait for Chromium after a cold start |
| `OXY_BROWSER_BACKEND_STRICT` | off | `1` = never fall back to the local browser |

## How it fits

- `browser-sandbox.js` finds, creates or resumes the user's sandbox (looked up by an opaque
  hashed tag in the sandbox metadata, so E2B never sees the user id), makes sure Chromium is
  up, and connects Playwright over CDP. No database table is involved.
- `browser-session.js` `acquireBrowser(userId)` picks sandbox or local; closing a session
  releases the sandbox, which pauses after the delay.
- `open()` uses the profile's own context in a sandbox, so logins persist on the machine.
  Cookies the user imported from their own browser are still loaded into it. localStorage in an
  imported session is not.
- Account deletion kills the user's sandboxes first (`user-data-lifecycle.js`
  `externalCleanup`); if that fails the deletion fails and can be retried.
- Sandbox URLs are private (`allowPublicTraffic: false`); only this server holds the token.

## Hand-over (live view)

`POST /agent/browser/live` (signed in) returns a 10-minute link to a noVNC page of the user's
browser. `GET /agent/browser/live/<link>/…` and the VNC socket are proxied by this server
(`browser-live-view.js`, `server.js` upgrade handler). The agent is not paused while someone is
using the live view — nothing coordinates the two yet.

## Not verified

Everything is tested against a real local Chromium with a fake of the E2B SDK. It has not been
run against real E2B: the template build, `maskRequestHost`, resume-with-memory, and the
noVNC/websockify setup in `sandbox/e2b/start.sh` all need a first run with a key. Whether a
datacenter-IP sandbox gets past the bot walls (Argos, Nike) is also untested; if not, the
sandbox's egress needs a residential proxy.

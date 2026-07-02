# Connect-a-site login flow — design

**Status:** spec / open decisions
**Date:** 2026-07-01
**Depends on:** the re-auth detector (`looksLikeLoginWall` / `detectLoginWall` in
`api/services/browser-task.js`, the `reauth` outcome) — already shipped. This doc covers the
*capture* side: how a user actually signs in once so `browser_sessions.storage_state` gets
populated (and refreshed when it expires).

## Problem

Ordering runs inside the user's own logged-in merchant session: `openNewSession` loads
`storage_state` (Playwright cookies + localStorage) per `(user, site)` and the checkout uses
the card on file in that account. This is great once a session exists — but there's no way to
*create* one. Today `storage_state` is only ever written as a side-effect of a live order
(`persistStorage`), which assumes the user was already logged in. First order on a site, or
any order after the cookie expires, hits a login wall. The re-auth work makes the agent
*detect* that and ask the user to reconnect — but "reconnect" currently points at nothing.

The hard constraint: **the ordering browser is headless and server-side (Cloud Run). The user
is on a phone.** They cannot type credentials into a browser they can't see. We must give the
user a surface to log in, then capture the resulting session into `browser_sessions`.

Non-goal: storing the user's merchant password. We only ever capture the *session state* the
login produces — the same cookies the ordering loop already reads and writes.

## Options considered

### A. Streamed remote browser (Browserbase live-view) — RECOMMENDED
Launch a **headed** browser session on a managed remote browser (Browserbase), open the
merchant login URL, and stream its live view into an in-app webview. The user types their
credentials directly into the real page; on success we call `context.storageState()` and
upsert it into `browser_sessions`, then tear the session down.

- **Pros:** captures byte-identical `storage_state` to what the ordering loop consumes
  (cookies *and* localStorage, all frames) — zero format translation. Handles 2FA, captchas,
  SSO ("Continue with Google"), and consent walls for free, because it's a real browser. Reuses
  the `BROWSER_REMOTE_ENDPOINT` / managed-browser infra already on the roadmap (the handoff doc
  needs it anyway for bot-walled delivery sites). One mechanism serves both connect *and* order.
- **Cons:** needs the managed-browser account + live-view embedding; per-session cost; a live
  socket for the duration of the login.
- **Security:** credentials are typed into the merchant's own page over the merchant's TLS; we
  never see or store them. We store only the post-login session state, encrypted at rest
  (see "Storage & security").

### B. Native WKWebView cookie capture
The mobile app opens the merchant login URL in a native webview; after the user logs in, the
app reads cookies from the platform cookie store and POSTs them to the server, which assembles
a Playwright `storage_state`.

- **Pros:** self-contained, no managed-browser dependency, no streaming socket.
- **Cons:** fragile. WKWebView won't hand back `httpOnly` cookies cleanly, misses
  `localStorage`/IndexedDB that some SPAs rely on for auth, and the cookie→`storageState`
  mapping (domain/path/sameSite/expiry) is finicky and per-site. A session that "looks"
  captured but is missing one httpOnly token fails silently at order time — exactly the flail
  we're trying to kill. Also diverges from how orders actually run, so a connect can succeed
  yet an order still land logged-out.

### C. Deferred desktop hand-off
Email/deeplink the user a one-time login URL to complete on desktop. Rejected: worst UX,
same capture problem unsolved, breaks the in-app promise.

**Decision: A**, with the managed-browser endpoint gated behind the same env var
(`BROWSER_REMOTE_ENDPOINT`) already planned. Fall back to a clear "not yet available" message
where that endpoint is unset, rather than shipping B's silent-failure mode.

## Flow (option A)

1. **Trigger.** Two entry points, one code path:
   - Proactive: a "Connected shops" screen (sits next to the existing Connectors tab) with an
     "Add a shop" button → pick/enter a site.
   - Reactive: the `reauth` outcome's message ("I need you to sign in to X again") renders a
     **Reconnect** button that deep-links straight into this flow for `session.site`.
2. **Open connect session.** `POST /browser-sessions/connect { site }` → server launches a
   headed remote browser at the site's login URL (from a small `LOGIN_URLS` map, falling back
   to the site root), returns a `{ connectId, liveViewUrl }`. Held in a short-TTL connect-session
   store, separate from the ordering `liveSessions` map.
3. **User logs in** inside the streamed view (handles 2FA/SSO/consent natively).
4. **Capture.** Client calls `POST /browser-sessions/connect/:connectId/finish`. Server verifies
   the session is actually authenticated — reuse `detectLoginWall` **inverted**: we're logged in
   only once we're *past* the wall (no login URL, no password-field+login-copy). If still on the
   wall, return "doesn't look signed in yet — finish logging in and tap Done." On success:
   `storage_state = await context.storageState()`, `upsert browser_sessions (user_id, site,
   storage_state)`, close the remote session, clear the connect store.
5. **Resume.** If this was reactive (an order was mid-flight), the existing `awaitingInput`
   routing means the user's next "keep going" re-enters `runOrderingTurn`, which re-opens with
   the fresh `storage_state` and continues from persisted context. No new resume plumbing.

## Storage & security

- `browser_sessions.storage_state` is a live credential (session cookies). It must be
  **encrypted at rest** — today it's plaintext JSONB. Add app-level encryption (the retention
  work already establishes a key path; reuse it) or Supabase column encryption. RLS is on;
  ensure no service-role read path leaks it to the client. The client never receives
  `storage_state` — only the server reads it into a browser context.
- **Expiry is expected, not exceptional.** The re-auth detector is the backstop; connect just
  refreshes. Consider stamping `storage_state_captured_at` so we can proactively prompt a
  reconnect before a big scheduled order rather than failing at run time.
- **Revoke = delete the row.** "Disconnect shop" is a single `DELETE ... WHERE user_id, site`.
  Surface it in the Connected-shops screen; it's also what the retention sweep should purge.

## Schema delta

`browser_sessions` already keys on `(user_id, site)` and holds `storage_state` +
`last_url`/`goal`/`history` (resume). Add:

```sql
ALTER TABLE browser_sessions ADD COLUMN IF NOT EXISTS storage_state_captured_at TIMESTAMPTZ;
-- (encryption change tracked separately; do not land plaintext expansion.)
```

No new table — connect writes the same row the ordering loop reads.

## Open decisions for the user

- **Managed-browser vendor:** Browserbase (has a first-class live-view embed) vs Bright Data vs
  self-hosted headed Chromium behind a CDP screencast. Live-view quality + mobile embedding is
  the deciding factor. This is the same decision the bot-walled-delivery item is waiting on —
  resolve once, unblock both.
- **Encryption mechanism** for `storage_state` before we start capturing more sessions
  deliberately (right now it accumulates as an order side-effect; a connect flow makes it a
  deliberate credential store, which raises the bar).
- **Which sites to offer first** in "Add a shop" — pair this with the `SEARCH_SITES` seed list
  so the shops we can search are the shops we can connect.
- **Session-expiry pre-warning:** prompt a reconnect N days before a *scheduled* order, using
  `storage_state_captured_at`? Or stay purely reactive via the re-auth detector?

## Test plan

- Unit: the inverted-wall "are we signed in yet?" check (extend `browser-reauth.test.js`).
- Unit: connect-store TTL/eviction, `finish` rejects an unauthenticated session.
- E2E (needs the remote endpoint + a test account): connect John Lewis → confirm a subsequent
  `openNewSession` lands logged in (no `reauth`), via `test/dev/browser-task-e2e.js`.

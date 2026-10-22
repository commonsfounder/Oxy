# API fuzz findings (live: milgrain-live-2026.fly.dev, commit 67e1159a)

Tested 2026-10-22 as `demo-test-user` only. About 450 requests, under 10 a second.
Not tested: /chat, anything that sends email/SMS/push, payments, or other users' data beyond status codes.

What held up: every session route returns 401 with no token or a garbage token. Tampered, expired, "alg none", wrong-signature and truncated tokens all give 401. Every route that takes a user id in the path or body returns 403 for another user (`user123`, `nobody-test-1`, `../`, encoded slashes, null bytes, 5000-char ids). That covers /history/*, /memory/*, /connectors/:id, /briefings, /briefing, /action-log, /preferences, /user/:id export and delete, /devices/register, /native/*, /emails/action-plan, /proactive/:id/run and /millie/provision. Workspace path traversal is blocked. The reset-password page escapes the token. Display routes with no pairing token return 401. `/auth/dev/demo-login` is 404 in production. The Telegram webhook secret is enforced. No cross-user read or write was found.

Side effects I caused and cleaned up: I registered a throwaway account `ab` by accident and deleted it through DELETE /user/ab. I created and deleted 3 routines, and deleted my test memories. Several recipe, task-pairing and workspace rows remain on demo-test-user. DELETE /connectors/apps/<anything> removed all 4 of demo's connected apps (see 3.1).

---

## Severity 3

### 3.1 Disconnecting one app removes every connected app (maybe every user's)
- Request: `DELETE /connectors/apps/nonexistent-zz` as demo-test-user.
- Response: **200 `{"removed":4}`**. A toolkit that does not exist removed four accounts. A second call returned `{"removed":0}`.
- Why: `api/services/composio.js` `disconnect()` sends `params: { user_ids: [userId], toolkit_slugs: [...] }`. Axios turns arrays into `user_ids[]=...&toolkit_slugs[]=...`. Composio ignores that format, so the toolkit filter did nothing. If the `user_ids` filter is ignored the same way, `disconnect` and `listConnections` act across all users. I could not prove that: there is no Composio key locally, and I did not print GET /connectors/apps before the delete. Treat it as a possible cross-user delete until checked.
- Fix: in `createComposio().send`, pass `paramsSerializer: { indexes: null }` or join arrays with commas (`user_ids: userId`, `toolkit_slugs: slug`). After `listConnections`/`disconnect`, assert each returned item's user id matches `userId` before deleting. Check how many accounts Composio holds for other users now.

### 3.2 Inbound SMS webhook has no signature check
- Request: `POST /webhooks/millie-sms` with form body, no auth.
- Response: **200 `<Response></Response>`**. The route is registered before the auth middleware.
- Why: `api/index.js` ~L538 never verifies a Twilio signature, and nothing in `connectors/phone-provider.js` does either. Anyone who knows or guesses an Adam phone number can post a forged text. It lands in that user's conversation as a participant reply, creates a notification through `surfaceInboundExternalReply`, and can feed prompt-injection text to the agent. The email webhook correctly fails closed.
- Fix: verify the provider signature (Twilio `X-Twilio-Signature` HMAC of URL plus sorted params) before the 200, and fail closed when no secret is configured, as `/webhooks/millie-email` does.

### 3.3 Every IP rate limit can be bypassed with a forged X-Forwarded-For
- Requests: `POST /auth/login` repeated until 429, then the same request with `X-Forwarded-For: 10.9.8.1`, `.2`, `.3`, `.4`.
- Response: 429 without the header; 401 (a normal attempt) for each forged address.
- Why: `requestIp()` (api/index.js ~L821) takes the first X-Forwarded-For entry, which is client-controlled. That defeats `loginRateLimiter` (10/min), `registerRateLimiter` (5/min), `forgotPasswordRateLimiter` (3/hour), `/display/pair`, `/display/enroll`, and everything else keyed by IP. It allows unlimited password guessing, account spam and email-bomb attempts. I stopped after 4 forged tries.
- Fix: `app.set('trust proxy', 1)` and key on `req.ip`; or on Fly use the `Fly-Client-IP` header. Never read the first XFF value.

### 3.4 A DELETE with no readable body wipes all memory and the saved card
- Request: `DELETE /memory/demo-test-user` with no body (or any non-JSON content type).
- Response: **200 "I cleared what I had in memory, including any saved checkout details and payment card."** Memory was empty afterwards.
- Why: `api/index.js` ~L4835 passes `req.body || { scope: 'all' }`. Express 5 leaves `req.body` undefined when the body is empty or not JSON, so the destructive scope becomes the default. A client bug, a proxy that strips bodies, or a wrong Content-Type destroys the user's data. Also `{"scope":["all"]}` is accepted by `String()` coercion.
- Fix: require `scope === 'all'` to be sent explicitly as a string; return 400 when no valid scope is given.

---

## Severity 2

### 3.5 (2) Error bodies leak database internals, and malformed ids give 500 instead of 400
All of these are 500 with the raw database message, for example `invalid input syntax for type uuid: "abc"`. They should be 400 or 404 with a fixed message.
- `DELETE /memory/demo-test-user/items/abc` and `PUT` (same id route)
- `POST /briefings/abc/read` with body `{userId}`
- `GET /history/demo-test-user/around?messageId=abc`
- `GET /agent/tasks/zzz`
- `DELETE /agent/scheduled-tasks/zzz`
- `DELETE /vault/credentials/zzz`
- `POST /agent/recipes/zzz/execute`
- `DELETE /routines/zzzz` returns the whole Postgres error object: `{"error":{"code":"22P02","details":null,"hint":null,"message":...}}`
- `GET /agent/tasks/zzz/runtime` is 500, and `/environment`, `/runtime/diff` and `/reviews` return 503 for what is a bad id.
- `DELETE /agent/displays/zz` is 500.
- Fix: validate ids with a UUID regex in one helper used by those handlers. In `catch` blocks return a fixed message (about 60 handlers do `res.status(500).json({ error: err.message })`). Add a final Express error middleware.

### 3.6 (2) `POST /agent/tasks/:id/run` has no try/catch
- `POST /agent/tasks/zzz/run` returns **500 HTML** ("Internal Server Error"). `delegatedRunLifecycle.get` throws on a non-UUID id, and the handler has no error handling. Fix: wrap in try/catch and validate the id (api/index.js ~L9276).

### 3.7 (2) Missing request body crashes handlers with 500 and a JS error message
Send `Content-Type: text/plain`, or an empty body with JSON content type, to these routes:
- `POST /memory`, `PUT /memory/:userId/items/:id`, `POST /action-log`, `POST /connectors`, `POST /auth/telegram/start`, `/verify`, `/2fa`: 500 `Cannot destructure property 'userId' of 'req.body' as it is undefined.`
- `POST /images/generate` and `POST /chat-with-image` with no multipart body: 500 with the same kind of message.
- Fix: use `req.body || {}` everywhere (as many routes already do), or add middleware that sets `req.body = req.body ?? {}`. They should answer 400.

### 3.8 (2) Upload errors are 500 instead of 4xx
- `POST /memory/photos/describe`, `/process-audio`, `/pendant/transcribe` with a wrong field name (`file=` instead of `image=`/`audio=`): 500 HTML. A 27 MB upload to `/memory/photos/describe` also gave 500 after 5.4 s (multer `LIMIT_FILE_SIZE`).
- Fix: add an error handler for `MulterError` that returns 400 (unexpected field) or 413 (too large).

### 3.9 (2) Any request with an Origin header that is not allowed returns 500
- `GET /health` with `Origin: https://evil.example`, `Origin: null`, `Origin: http://localhost:3000`, or an `:443` form of our own host: 500 HTML. `OPTIONS` preflights too.
- Why: the cors `origin()` callback calls `cb(new Error('Not allowed by CORS'))` (api/index.js ~L400). This shows up as server errors in logs and alerting, and it breaks `Origin: null` callers.
- Fix: `cb(null, false)` (no CORS headers, request still served) or an explicit 403.

### 3.10 (2) Deeply nested JSON gives 500 with "Maximum call stack size exceeded"
- `POST /action-log` with `{"userId":"demo-test-user","action":<4000 levels of nesting>}`: 500 `Maximum call stack size exceeded`. It comes from `JSON.stringify(action)` in the handler. Other routes accepted 4000-deep objects and stored them (/native/context, /agent/recipes, /checkout-profile, /chat-settings).
- Fix: cap nesting depth and size in a body-parsing step, or `reviver`-free depth check; return 400.

### 3.11 (2) Wrong-type input accepted and stored
- `POST /routines` with `{"name":{},"prompt":{}}` returned 201 and stored `"{}"`. `interval_minutes:"1e3"` and `[60]` are accepted (Number() coercion).
- `interval_minutes: 9e15` gives 500 `Invalid time value`.
- `POST /checkout-profile` with `{"name":{}}` returns 200 `saved:true` with name set.
- `POST /agent/recipes` with `{"name":{}, "steps":"x"}` is stored (goal `"{}"`).
- `POST /devices/register` accepts any `timezone` (an object, `"Not/AZone"`, a 100 KB string).
- `POST /native/context` accepts strings for location/health/etc.
- `POST /emails/action-plan` accepts an object for `messageId`.
- `POST /connectors/apps/connect` with `{"toolkit":123}` reaches the upstream catalogue and returns the upstream "Request failed with status code 404".
- Fix: type-check (`typeof x === 'string'`, length caps, `Intl.DateTimeFormat` for timezone, upper bound on `interval_minutes`).

### 3.12 (2) Wrong status codes (failure returned as 200 or success-looking)
- `DELETE /memory/demo-test-user` with an unknown scope: 200 `{"success":false,...}`. Should be 400.
- `POST /agent/continuity/import` with an empty/unparsed body returns 200 and creates an empty "completed" import record. It should be 400. Nothing stops repeated empty imports.
- `DELETE /connectors/apps/<unknown>` returns 200 `{"removed":0}` (should be 404; see 3.1 for the worse case).
- `DELETE /vault/browser-session/%00` returns 200 `{"removed":false,"site":"\u0000"}`.
- `POST /connectors/stripe/setup-intent` and `/confirm` return 500 "Stripe is not configured on the server" in prod. That is a config state and should be 503.
- `POST /webhooks/stripe` returns 500 for the same reason.
- `GET /agent/tasks?status[]=a` ignores the filter and returns all tasks (an array bypasses the string check).
- `GET /vault/browser-session/<5000-char>/check` returns the HTML 404 page, not JSON.

### 3.13 (2) Logout and password change do not revoke tokens without a `tokenVersion`
- The auth middleware only checks `token_version` when the token carries one, and it passes when the user row is missing or the lookup throws. Tokens minted without a version (for example `createSessionToken(userId)` as `demo-login` does) can never be revoked by `/auth/logout-all` or `/auth/change-password`. `/auth/logout` does nothing server-side. Tokens live 7 days.
- Fix: require `tokenVersion` on every session token, fail closed on lookup error, reject tokens whose user row does not exist. Session secret falls back to `OXY_API_KEY` (auth.js `getSessionSecret`), so one leaked API key would let anyone forge tokens for any user. Use a dedicated secret only.

### 3.14 (2) User-id registration rules are weak and enumerate accounts
- `POST /auth/register` accepts a 2-character user id (`ab` was created). `POST /auth/register` returns 409 "That user ID is already taken" for `user123` and `demo-test-user`, which confirms which names exist. Login does not distinguish, so only register leaks.
- `/auth/login` skips the password hash when the account does not exist, so a timing difference also reveals valid user ids.
- Fix: set a sensible minimum length and a reserved-name list; run `verifyPassword` against a dummy hash when the account is missing.

---

## Severity 1

- **3.15 Duplicate writes accepted.** 8 parallel identical `POST /memory` calls created 8 identical memories. `POST /agent/displays/pairing` x8 created 8 pairing challenges with no cap. `POST /agent/continuity/import` empty body creates a record each time.
- **3.16 Search request triggers an upstream WAF page.** `GET /history/demo-test-user/search?q='or 1=1--` returns 500 and the error text is a full Cloudflare HTML page (the query reached Supabase's edge, which blocked it). Fix: escape or limit the characters in `q`, and return a plain 400/502 with fixed text.
- **3.17 Reflected forwarded headers.** `/auth/google/start` and `/auth/google/redirect-uri` build the redirect URI from `X-Forwarded-Proto`: `X-Forwarded-Proto: evil` gives `evil://milgrain-live-2026.fly.dev/auth/google/callback`. Use `APP_URL` as the callback does.
- **3.18 Framework fingerprint and HTML errors.** `X-Powered-By: Express` is sent (add `app.disable('x-powered-by')`). Body-parser, multer and routing errors return an HTML page, not JSON (413 "Payload Too Large", 400 "Bad Request", 404 "Cannot GET /x"). The app expects JSON.
- **3.19 /health and /version are public** and show git commit, deploy id, branch, region, provider and model names, which connectors are configured, and heap usage. Not a leak of secrets, but more than a public probe needs.
- **3.20 Workspace paths.** `PUT /agent/workspace/files` accepts `%2e%2e/x` as a literal file name (not a traversal, but odd). `GET /agent/workspace/files?path=../..` ignores the path and returns the workspace row.
- **3.21 Query arrays and non-numbers are silently ignored** on `limit`, `since`, `before` (history, activity, audit, documents). No error, defaults apply.
- **3.22 Case and slash variants.** `/History/<id>` (any case) and trailing slashes route normally (Express default). Public-path bypass attempts (`/health/../history/x`, `;` tricks, case) all returned 401, so no auth bypass.
- **3.23 Header limits.** A 100 KB bearer token never reached the app (the proxy dropped the connection, "fetch failed"). `X-Session-Token` is accepted as an alternate header and `Bearer` with several spaces is accepted; lowercase `bearer` is rejected. Harmless but inconsistent.

---

## Hangs
No request took over 10 s. The slowest were `GET /user/demo-test-user/export` (about 2.6 s) and the 27 MB upload (5.4 s before its 500).

## Suggested fix order
1. 3.1 (check Composio now), 3.2, 3.3, 3.4.
2. One shared error-handling layer: UUID validation helper, `req.body ??= {}`, multer and CORS error mapping, final error middleware that never returns `err.message` (clears 3.5 to 3.10 together).
3. Type validation on the routes in 3.11, then 3.13 and 3.14.

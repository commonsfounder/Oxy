# Development Demo Auth Checklist

This path is for local UI/UX testing only. The backend endpoint is disabled unless:

- `NODE_ENV` is not `production`
- `OXY_ENABLE_DEV_AUTH=true`

The iOS login button is visible in `DEBUG` builds, or in local builds where `oxy_enable_local_dev_auth` is set in `UserDefaults`.
Production deploy configs must not set `OXY_ENABLE_DEV_AUTH`. When disabled, `POST /auth/dev/demo-login` returns `404` so the route does not become an alternate production login surface.

For non-interactive simulator automation, set `oxy_auto_demo_login=true` in the app's simulator `UserDefaults`. This is gated by the same debug/local visibility check as the button and uses the same `/auth/dev/demo-login` request path.

To also exercise message send without GUI click/type access, set `oxy_auto_demo_message` to a short string before launch. The Chat screen sends it once through the normal `sendMessage` path, then removes the value so reopen behavior is not polluted by repeated sends.

## Manual Check

1. Start a local/dev backend with `OXY_ENABLE_DEV_AUTH=true`.
2. Fresh install the app on the simulator.
3. Open the app.
4. Tap `Continue as Test User`.
5. Confirm the app reaches the Chat tab.
6. Send a basic message.
7. Quit and reopen the app.
8. Confirm the demo session restores or expires cleanly according to normal session handling.

## Expected Logging

Login failure logs may include:

- environment/build mode
- backend base URL
- auth provider, such as `custom_session` or `custom_session_dev`
- high-level reason
- failure bucket: `network_request_failed`, `credentials_rejected`, or `callback_or_session_storage_failed`

Never log passwords, session tokens, refresh tokens, or personal data.

Do not enter, log, or store real passwords, session tokens, refresh tokens, or personal checkout details while using this path.

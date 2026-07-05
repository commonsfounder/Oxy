# Milgrain Superagent Command Center

Last updated: 2026-07-05

## North Star

Milgrain is a premium, wearable-first personal assistant: press, speak, remember,
act. The app must feel like a trusted companion that safely gets real work done,
not a chatbot wrapper or a gadget demo.

The money plan is app/TestFlight first, prove retention and demand, then move
into hardware/Kickstarter once the software loop is credible.

## What Not To Rebuild

- Chat/voice/action spine: current SSE chat, transcript submission, action cards,
  pending review, and receipt flow are real.
- Safety primitives: action contracts, review-gated high-risk actions, calendar
  intent routing, money guardrails, token encryption, and retention sweeps.
- Browser shopping work: the universal recipes and benchmark harnesses are a
  specialized subsystem; improve with measured E2E runs, not rewrites.

## Launch-Critical Workstreams

1. Paid launch path: StoreKit 2 purchase/restore, App Store JWS validation,
   subscription rows, server-side entitlement gates, webhook sync.
2. App Store trust bundle: deletion/export proof, permission strings, AI safety
   disclosure/moderation, privacy labels, legal/support URLs.
3. Production security defaults: fail closed for secrets, migrate old plaintext
   connector tokens, Secret Manager deployment, rotation plan.
4. CI and release hygiene: backend smoke plus iOS build gate, clean migration
   provenance, no generated dev artifacts in release commits.
5. Voice quality and economics: latency SLOs, real-device benchmarks, model/TTS
   cost telemetry, per-tier quotas, bad-network recovery.
6. Launch UX reliability: connector expectations, permission recovery, pending
   review clarity, supported vs best-effort labeling.

## Current Verified State

- Backend smoke tests pass: `npm test` reports 368/368.
- iOS simulator build passes with:
  `xcodebuild -project OxyApp/OxyApp.xcodeproj -scheme OxyApp -configuration Debug -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build`.
- CI now includes a macOS iOS build job in addition to backend smoke tests.
- `/proactive/sweep` now fails closed in production when
  `PROACTIVE_SWEEP_SECRET` is missing.
- Token encryption already fails closed in production without
  `OXY_TOKEN_ENCRYPTION_KEY`; this is now smoke-tested.

## Immediate Next Decisions

- Entitlement strategy: should the backend hard-block high-cost routes for users
  without an active/trial subscription immediately, or ship a softer TestFlight
  mode where the server records entitlement state but only warns/logs?
- Brand migration: user-facing copy scrubbed to Milgrain (2026-07-05) — Info.plist
  strings, CFBundleDisplayName, Siri/Shortcuts titles, in-chat permission errors,
  pendant BLE name/firmware, privacy/terms/support pages, emails, wallet pass,
  connector defaults. Still open: whether to also rename the Xcode project/target,
  bundle ID (`ai.oxy.app`), Cloud Run service name, and repo — deferred because it
  breaks TestFlight/App Store Connect continuity and needs a deliberate cutover.
- Migration provenance: decide whether root-level `supabase-migration-*.sql`
  files replace the deleted `supabase/migrations/*` files before any release
  commit or push.

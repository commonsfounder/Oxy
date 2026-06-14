# Oxy — repo guide for Claude

Oxy is a wearable/voice-first AI personal assistant: a user speaks → the model returns a spoken reply
plus optional `<action>` blocks → actions run through connectors. App-first today (iOS + cloud);
pendant hardware on the roadmap.

## Stack & layout
- **Backend:** Node.js + Express 5 (`server.js` → `api/index.js`). Deployed to **Google Cloud Run**,
  **auto-deploys from GitHub `main`**. Data + auth in **Supabase (Postgres)**.
- **AI:** Google Gemini (`@google/genai`, `@google/generative-ai`) — chat, live voice, STT, TTS, image.
  Model defaults (`api/index.js`, overridable by env): `PRIMARY_CHAT_MODEL`/`STREAMING_CHAT_MODEL` =
  `gemini-3-flash-preview` (reasoning + voice), `FAST_MODEL` = `gemini-3.1-flash-lite` (cheap helpers).
- **Surfaces:** `OxyApp/` (SwiftUI iOS), a React PWA, and `firmware/` + `OxyPendantFirmware/` (BLE pendant).
  **iOS is built locally in Xcode from the working tree — it does NOT deploy via `main`.** Only the
  backend auto-deploys. So iOS edits need a user rebuild to take effect.
- **Key dirs:** `connectors/` (service integrations), `api/services/` (action runner, connector-health,
  context-brain, pending-review, token-crypto, etc.), `docs/` (runbooks), `launch/` (GTM), `test/smoke/`.

## Commands
- `npm run smoke` — smoke tests (run before any change lands).
- `npm run brain:evals` — model/brain behaviour evals.
- `npm run release:check` — syntax + full smoke; **run before pushing.**
- `npm run dev` — local server (needs env below).

## Required env (`runtime.js`)
`SUPABASE_URL` · `SUPABASE_KEY` · `GEMINI_API_KEY` · `OXY_SESSION_SECRET`.
Optional: Google OAuth, Telegram, Maps/Places (`GOOGLE_MAPS_API_KEY`), APNs, Spotify, `OXY_TOKEN_ENCRYPTION_KEY`,
GitHub OAuth (`GITHUB_CLIENT_ID`/`SECRET`), Microsoft OAuth (`MS_CLIENT_ID`/`SECRET`/`MS_TENANT`),
Notion OAuth (`NOTION_CLIENT_ID`/`SECRET`), YouTube search (`YOUTUBE_API_KEY`, falls back to a search link if unset).
GitHub connector: `GITHUB_CLIENT_ID` · `GITHUB_CLIENT_SECRET`. Microsoft/Outlook connector:
`MS_CLIENT_ID` · `MS_CLIENT_SECRET` (optional `MS_TENANT`, default `common`).
Spotify connector (playback control, needs Premium): `SPOTIFY_CLIENT_ID` · `SPOTIFY_CLIENT_SECRET`
(token endpoint uses HTTP Basic auth, not body params). Linear connector: `LINEAR_CLIENT_ID` ·
`LINEAR_CLIENT_SECRET`. OAuth redirect URIs: `https://<host>/auth/github/callback`,
`https://<host>/auth/microsoft/callback`, `https://<host>/auth/spotify/callback`,
`https://<host>/auth/linear/callback`.
There is **no local `.env`** — env comes from the shell / Cloud Run.

## How actions & connectors work (the core model)
1. The model emits `<action>{ "actions": [ ... ] }</action>` alongside its spoken text.
2. `api/action-contracts.js` (`ACTION_CONTRACTS`) defines every action: `risk`, `required` fields,
   `aliases`, `guidance` (model-facing), `confirmation`, `executionMode`. `actionPromptBlock()` is
   **generated** from this map — you can't paste prose into it; add structured entries.
3. `api/services/action-runner.js` runs actions. If `executionMode: 'review'` and not `bypassReview`,
   the action becomes a **pending-review card** and does NOT execute until the user approves (then it
   re-runs with `bypassReview: true`). This is how high-risk/real-money actions are gated.
4. `connectors/index.js` maps each action name → a connector module's `execute(userId, action, params)`.
   `params` already includes `context.location` ({latitude, longitude}) via the action runner.

## Adding a connector (do ALL of these — they're coupled)
1. `connectors/<name>.js` — export `SUPPORTED_ACTIONS` + `async execute(userId, action, params)`.
2. `connectors/index.js` — `require` it and add it to the `MODULES` map (registry + `IMPLEMENTED_CONNECTORS`
   are derived from it automatically).
3. `api/action-contracts.js` — add an `ACTION_CONTRACTS` entry per action (risk, required, inputExample,
   guidance). High-risk → `confirmation: 'review_required'`, `executionMode: 'review'`.
4. `api/services/connector-health.js` — add each action to `ACTION_CONNECTOR`; add a `humanConnectorName` case.
5. `api/index.js` — add to `ACTION_STATUS_LABELS` and to the `buildAvailableActions` connector→actions map.
6. `api/services/pending-review.js` — add review title/detail cases **only if** the action is review-gated.
Then run `npm run smoke` (the contract test sweeps every entry).

## iOS design system & product direction
- **Positioning:** Oxy is a **premium design-object** in a **feminine-luxe jewelry register**
  (Hermès / Calm / Oura), aimed at design-literate, female-leaning early adopters (~$400+ buyer). The
  aesthetic *is* the marketing. Bias toward emotional warmth + visible competence + legibility over
  feature density. (This superseded the earlier monochrome "Celine/Saint Laurent silent-luxury" framing.)
- **Aesthetic = "soft metal luxe":** a warm-pearl **light canvas by default** (daytime-first for
  wearability), soft metallic finishes, **large airy editorial type**, full-ink answers/values, hairline
  dividers, high negative space, **soft rounded cards** ("precious notes"). Monospace ONLY for raw
  telemetry (battery/latency/IDs/commit). The liquid-glass tab bar + circular header controls keep their
  curve; icons are **fleshed-out glass chips** (`NamelessGlassIcon`), not tiny bare glyphs. **No
  sparkle/particle FX** — restraint via the glass sheen + metal gradient + glow.
- **Theme = two axes (finish × appearance), `OxyApp/.../Extensions/NamelessTheme.swift`.** Every view
  reads the appearance-aware `nml*` `Color` tokens (`nmlInk`, `nmlMuted`, `nmlTitanium` = accent,
  `nmlHairline`/`nmlCardBorder`, `nmlGlow`, `nmlSurface`, **`nmlBackground`** = canvas, **`nmlOnMetal`** =
  text on metal, `nmlFill(_:)` = appearance-aware raised fill). Use **`.nmlMetal`** (a `LinearGradient`)
  for the jewelry shine — user chat bubble, primary button, monogram, finish swatches. Pure black is **no
  longer invariant** — never hardcode `Color.black`/`.white.opacity` as a canvas/fill; use the tokens so
  both appearances flip.
- **Customization engine = 4 finishes** (`OxyTheme`): **Sterling Silver (id `titanium`, default)**, Warm
  Gold, Rose Gold, Pearl (Raw Obsidian was removed). A finish = the metal (accent/glow/border-warmth);
  each carries a dark + light neutral set. **Appearance** = Soft/light (default) or Dark, stored in
  `@AppStorage("oxy_appTheme")` ("soft"|"dark"; `OxyTheme.isLight` treats absent/non-"dark" as light;
  `OxyApp.swift` maps it to `preferredColorScheme`). Finish persists to `@AppStorage("oxy_theme_profile")`;
  `MainTabView` re-keys `.id(accentColor+appTheme+themeProfile)` so either axis repaints the tree. No
  9-accent picker — don't reintroduce one.
- **More-tab IA = one home per domain** (`MainTabView.MoreView` → fullScreenCover): **Profile** = account
  (identity + export/sign-out/delete), **Pendant** = pairing + live status + hardware, **Connectors**,
  **Memory** (single entry point), **Settings** = cross-cutting prefs only (Appearance/Voice/Assistant/
  Action Defaults/About). Do NOT re-duplicate a domain into Settings.
- **Persona/voice** lives in `OXCY_SYSTEM_PROMPT` (`api/index.js`): dry, terse friend; lowercase casual
  one-liners; anti-sycophancy; banned chatbot phrases ("As an AI", "Here is", "Let me know if"…); mirrors
  the user. Governs spoken/chat replies only — drafted emails/messages and action JSON keep their own rules.
- **Grounding is conditional, NOT always-on.** `api/services/search-intent.js` (`getSearchReason`) gates
  whether the `googleSearch` tool is attached. Always-on grounding was tried and **froze fast actions
  like "play music"** — reverted. The regex is broadened to catch follow-ups ("well check", "did you hear
  about X", "what did you get") while skipping "check my email/calendar".
- **Grounded answers surface sources:** the chat-stream extracts Gemini grounding metadata
  (`groundingSourcesFrom`), emits a `sources` SSE event, and the client renders + persists source chips
  (`serializeConversationContent`/`normalizeConversationRow`, iOS `MessageSource`).
- **Roadmap to the $400 object (3 levers):** ① *make competence visible* — **DONE** (confirmation cards,
  source chips). ② *legibility & restraint pass* — **DONE**, folded into the feminine-luxe pivot (full
  ink on answers/values, lifted muted greys, larger/airier type, glass icons, jewelry finishes + light
  mode, soft cards). ③ *onboarding as unboxing* — **NEXT** (first-run / pendant-pairing as a designed
  reveal; the aspirational not-connected pendant hero is a first step).
- **iOS does NOT auto-deploy** — only the backend rides `main`. iOS edits need a user Xcode rebuild. Verify
  iOS changes with a simulator build: `xcodebuild -project OxyApp/OxyApp.xcodeproj -scheme OxyApp -destination
  'platform=iOS Simulator,name=iPhone 17 Pro' build`. SourceKit cross-file "cannot find X" diagnostics are
  false positives in isolation — trust the build.

## Conventions & gotchas
- **Match surrounding code** (style, naming, comment density). Backend is CommonJS (`require`).
- **`main` auto-deploys to prod and there is NO CI gate** — run `release:check` and branch before pushing;
  only push `main` when intended.
- Commit trailer: `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Process timezone is `Europe/London` (date math depends on it).
- **Proactive briefings & scheduled tasks** pull real context via `gatherProactiveContext` (calendar +
  Gmail Primary) and write spoken copy via `generateGroundedBriefing` (Google Search grounding). Briefings
  live in the `briefings` table (Today tab) and are filtered out of chat history. `scheduled_tasks` table +
  `api/services/scheduled-tasks.js` back reminders/recurring tasks.
- **Memory:** `saveMemory` rejects junk, replaces single-valued facts (school/home/work/station/bank/…),
  and dedupes. User-added memories are additive (`manual`); the Memory tab lists/deletes individual items.
- **Push (APNs) is blocked** until there's a paid Apple Developer account — `/push/status` shows config
  state; briefings still land in-app without it.
- **iOS 27 + older Xcode debugger gotcha:** Run-from-Xcode SIGABRTs with `-[OS_dispatch_mach_msg
  _setContext:]` are the debug instrumentation (Main Thread Checker), NOT app code. Update Xcode or
  uncheck the scheme's Diagnostics; the app runs fine launched standalone.
- **Connector reliability matters:** prefer official APIs or deep-link handoffs. An Uber Eats *scraper*
  (`@striderlabs/mcp-ubereats`) was built then **reverted** — it returns no results against Uber's live
  site. Don't reintroduce scraper-based connectors without proving reliability first.
- More context: `docs/SHIP_READINESS_SOFTWARE_GAPS.md` (what's missing for launch),
  `docs/OXY_HARDENING_RUNBOOK.md` (release QA), `OXY_COMPREHENSIVE_OVERVIEW_MAY_2026.md` (full overview).

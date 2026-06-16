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
- **Positioning:** Oxy is a **premium design-object** (Celine/Saint Laurent register), aimed at the
  design-literate, ~$400 buyer — not a cheap gadget. The aesthetic *is* the marketing. Bias every UI
  call toward restraint + visible competence over feature density.
- **Aesthetic = "silent luxury":** pure black `#000000`, hairline `~#222` dividers, high negative space,
  flat lists (no boxed card groupings), Title Case labels. Sharp 90° corners everywhere **except** the
  signatures: circular header controls + a soft radius on chat bubbles. (The liquid-glass bottom tab bar
  was **removed** with the move to two surfaces — see the IA note below; don't reintroduce it.)
  **Not "techbro":** the buyer skews design-literate/feminine-leaning, and black minimalism is the
  *inclusive*-luxury register (The Row, Celine, Aesop) — the fix for "too masculine" is **de-gadgeting**
  (kill spec-sheet signifiers), NOT lightening/softening into a feminine cliché (that pivot was tried in
  `edcc0dd` and **reverted** in `7f85cd4` — it added light-mode/cream and nuked the black canvas).
- **Type system:** `Font.nmlDisplay` = **Fraunces** (editorial serif, the soul — titles/hero only);
  `Font.nmlBody` = **Inter** (running text + labels); `Font.nmlMono` = monospace, reserved **strictly**
  for raw telemetry (battery/latency/version/IDs) — never labels/chips/buttons/timestamps. Fonts ship in
  `Resources/Fonts/` (OFL) via `UIAppFonts`. No `[ bracketed ]` button labels (CLI cosplay — removed).
- **Theme tokens live in `OxyApp/.../Extensions/NamelessTheme.swift`.** Every view reads the `nml*`
  `Color` tokens (`nmlInk`, `nmlMuted`, `nmlTitanium` = accent, `nmlHairline`/`nmlCardBorder` = border,
  `nmlGlow`, `nmlSurface`). These are **computed from the active finish** — change them here, the whole
  app re-skins. Don't hardcode colors in views.
- **Customization engine = 3 finishes** (`OxyTheme` in the same file): Onyx, **Moonstone (default)**,
  Champagne — gemstone names, not spec-sheet metal. (Their `id`s stay `obsidian`/`titanium`/`gold` so
  saved selections survive; only the display `name` is evocative.) Pure black is invariant; only
  accent/detail/border shift, and the default neutrals carry a touch of warmth (not cold steel grey). Selection persists to
  `@AppStorage("oxy_theme_profile")`; `MainTabView` re-keys its `.id(...)` on it so a change repaints the
  tree. There is no longer a 9-accent picker — don't reintroduce one.
- **App IA = two surfaces, no tab bar** (`MainTabView`): a paged `TabView` of **Today** (home, default)
  and **Chat** — order = page order, so swiping left off Today opens Chat; two hairline dots hint the swipe.
  Everything else folds behind the **profile icon** on Today (ChatGPT/Claude-style), which presents
  `MoreView` as a `fullScreenCover`. Don't reintroduce a bottom tab bar.
- **Today = structured dashboard, not a prose feed.** `Views/Today/TodayView.swift` renders the
  `GET /today/:userId` payload — weather (client-side WeatherKit) + commute/traffic + calendar + inbox +
  news, every item a real tappable link out to the **native app** (Gmail/Calendar/Maps). The endpoint
  (`api/index.js`) reuses the connectors' structured `events`/`emails`, Reddit's public JSON for news, and
  Maps Directions (live traffic) with the work address pulled from memory. (The old LLM-prose briefings
  feed `ProactiveView` still exists but is no longer wired into the tabs.)
- **More-tab IA = one home per domain** (`MainTabView.MoreView` → fullScreenCover, reached via the profile
  icon): **Profile** = account (identity + export/sign-out/delete), **Pendant** = pairing + live status +
  hardware, **Connectors**, **Memory** (single entry point), **Settings** = cross-cutting prefs only
  (Appearance/Voice/Assistant/Action Defaults/About). Do NOT re-duplicate a domain into Settings.
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
  source chips). ② *legibility & restraint pass* — **NEXT** (full ink on answers/values, quieter chrome,
  declutter, more whitespace; the muted greys read slightly squinty). ③ *onboarding as unboxing* (first-run
  / pendant-pairing as a designed reveal).
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

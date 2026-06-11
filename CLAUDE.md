# Oxy — repo guide for Claude

Oxy is a wearable/voice-first AI personal assistant: a user speaks → the model returns a spoken reply
plus optional `<action>` blocks → actions run through connectors. App-first today (iOS + cloud);
pendant hardware on the roadmap.

## Stack & layout
- **Backend:** Node.js + Express 5 (`server.js` → `api/index.js`). Deployed to **Google Cloud Run**,
  **auto-deploys from GitHub `main`**. Data + auth in **Supabase (Postgres)**.
- **AI:** Google Gemini (`@google/genai`, `@google/generative-ai`) — chat, live voice, STT, TTS, image.
- **Surfaces:** `OxyApp/` (SwiftUI iOS), a React PWA, and `firmware/` + `OxyPendantFirmware/` (BLE pendant).
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
2. `connectors/index.js` — `require` it and register its actions; add the id to `IMPLEMENTED_CONNECTORS`.
3. `api/action-contracts.js` — add an `ACTION_CONTRACTS` entry per action (risk, required, inputExample,
   guidance). High-risk → `confirmation: 'review_required'`, `executionMode: 'review'`.
4. `api/services/connector-health.js` — add each action to `ACTION_CONNECTOR`; add a `humanConnectorName` case.
5. `api/index.js` — add to `ACTION_STATUS_LABELS` and to the `buildAvailableActions` connector→actions map.
6. `api/services/pending-review.js` — add review title/detail cases **only if** the action is review-gated.
Then run `npm run smoke` (the contract test sweeps every entry).

## Conventions & gotchas
- **Match surrounding code** (style, naming, comment density). Backend is CommonJS (`require`).
- **`main` auto-deploys to prod and there is NO CI gate** — run `release:check` and branch before pushing;
  only push `main` when intended.
- Commit trailer: `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Process timezone is `Europe/London` (date math depends on it).
- **Connector reliability matters:** prefer official APIs or deep-link handoffs. An Uber Eats *scraper*
  (`@striderlabs/mcp-ubereats`) was built then **reverted** — it returns no results against Uber's live
  site. Don't reintroduce scraper-based connectors without proving reliability first.
- More context: `docs/SHIP_READINESS_SOFTWARE_GAPS.md` (what's missing for launch),
  `docs/OXY_HARDENING_RUNBOOK.md` (release QA), `OXY_COMPREHENSIVE_OVERVIEW_MAY_2026.md` (full overview).

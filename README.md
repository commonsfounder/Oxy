# Oxy

**Note on naming:** the shipped product is called **Milgrain** — "Oxy" only survives as this repo's name and as internal identifiers (Xcode project/target, bundle ID `ai.oxy.app`, `oxy.app` email domain, code symbols like `OxySettings`). All user-facing UI, Shortcuts, and copy say Milgrain, not Oxy. The AI assistant itself is intentionally nameless — it doesn't refer to itself as "Milgrain" or "Oxy" in conversation.

Milgrain is a general-purpose agent runtime with a conversational front end — text or voice. You give it an outcome; it works out how to reach that outcome by composing general capabilities (browser, connectors, memory, communication, files, its own settings, long-running work, verification) inside deterministic safety boundaries.

The architecture hardcodes **capabilities and safety boundaries, never human tasks**. Email, calendar, rides, travel, shopping, forms, account admin and subscriptions are all applications of the same runtime rather than separate features — adding a new kind of task should not mean adding a new subsystem. See [AGENTS.md](AGENTS.md) for the architecture rules and `test/smoke/general-agency.test.js` for the capability tests that hold them in place.

## What It Does

- **Conversational AI** — Chat via text or voice, with persistent memory of personal facts and preferences that shapes future replies.
- **Connector system** — 22 pluggable service integrations (see table below): real API actions (send email, check calendar, control smart home, check crypto/stocks, etc.) and handoff/deep-link connectors (Uber, Lyft, Trainline, Spotify, Amazon).
- **Browser as an environment** — Playwright-backed primitives (`browser_open`, `browser_observe`, `browser_act`, `browser_close`) that let the agent see a real page and choose one step at a time. The same primitives serve cancelling a subscription, filling in an application, changing an account setting, a council portal, and buying something. Payment is a separate general transaction capability with deterministic approval and verification.
- **Proactive briefings & routines** — Scheduled/interval-based routines and unprompted, context-aware briefings pulled from real calendar/email/search grounding.
- **Task & entity memory** — Persistent agent tasks with step-level tracing, plus recall of prior entities/tasks so the agent can refer back to "that hotel" or "the order from yesterday."
- **Credential vault** — Securely stores and reuses login/delivery/payment identity for checkout and connector flows.
- **Real payments** — Stripe-backed card flow with review gates and hard per-transaction/per-day spend caps.
- **Native iOS app** — SwiftUI client (`OxyApp/`) with Chat, Home, Connectors, Memory, Routines, Vault, Payments, and Onboarding surfaces.
- **Apple Shortcuts bridge** — A generated `.shortcut` file lets the assistant trigger native iOS actions (iMessage, Reminders, HomeKit) from its responses.

## Architecture

```
┌───────────────────────────────────────────┐
│              OxyApp (iOS, SwiftUI)         │
│  Chat · Home · Connectors · Memory ·       │
│  Routines · Vault · Payments · Onboarding  │
└───────────────────┬───────────────────────┘
                    │ HTTPS / SSE
┌───────────────────▼───────────────────────┐
│           API Server (Express 5)           │
│  api/index.js — chat, audio, memory, auth  │
│  agent-orchestrator — the reasoning loop   │
│  action-execution  — the one exec boundary │
│    (validate → review gate → invoke → log) │
│  browser-session / browser-environment     │
│    — the browser as a general environment  │
│  playbooks — optional domain guidance      │
└───────┬──────────────┬────────────────────┘
        │              │
┌───────▼──────┐ ┌─────▼──────────────────────────────────┐
│  Supabase    │ │            Connector System              │
│  (Postgres,  │ │  connectors/ — google, microsoft, uber,  │
│  RLS)        │ │  telegram, trainline, maps, spotify,     │
│              │ │  notion, github, monzo, stripe, plaid,   │
│  22 migra-   │ │  weather, amazon, slack, lyft, strava,   │
│  tions       │ │  oura, eventbrite, flights, hotels,      │
│              │ │  stocks                                  │
└──────────────┘ └───────────────────────────────────────────┘
                         │
                 ┌───────▼──────────────┐
                 │   External APIs       │
                 │  Gemini (LLM/TTS/STT) │
                 │  Playwright (browser  │
                 │    automation)        │
                 │  Google, Microsoft,   │
                 │  Stripe, Plaid, etc.  │
                 └───────────────────────┘
```

### iOS Client

The primary client is a native SwiftUI app at `OxyApp/OxyApp.xcodeproj` (scheme `OxyApp`). Key view areas: `Views/Chat`, `Views/Home`, `Views/Connectors`, `Views/Memory`, `Views/Routines`, `Views/Vault`, `Views/Payments`, `Views/Onboarding`, `Views/Auth`, `Views/Settings`.

### Backend

An Express 5 server (`server.js` → `api/index.js`) deployed as a standard Node.js process on Fly.io.

**Core flow for a chat message (`POST /chat`):**
1. User sends text or audio (`POST /process-audio` transcribes via Gemini first).
2. Conversation history, memories, preferences, connected-app context, task/entity recall, and routine state are loaded from Supabase.
3. Gemini generates a response (with Google Search grounding).
4. If the response includes an `<action>` block, actions dispatch to the connector system, or to the browser-automation agent for checkout-style tasks.
5. Data-fetching results (emails, calendar, train times, order state) are fed back to Gemini for natural summarisation.
6. TTS audio is generated and streamed back alongside text via SSE.
7. Memory facts are extracted and saved in the background; task/step traces are recorded for agent runs.

### Connector System

Connectors live in `connectors/` and each exports `SUPPORTED_ACTIONS` + `execute(userId, action, params)`. The registry and per-connector categorisation live in `connectors/index.js`.

| Category | Connectors |
|----------|-----------|
| Real API (server-side actions) | `google`, `microsoft`, `telegram`, `maps`, `notion`, `github`, `monzo`, `stripe`, `plaid`, `weather`, `slack`, `strava`, `oura`, `eventbrite`, `flights`, `hotels`, `stocks` |
| Handoff / deep-link | `uber`, `trainline`, `spotify`, `lyft`, `amazon` |

### Browser-Automation Agent

`api/services/browser-task.js` is the main ordering/checkout loop, backed by:
- `browser-recipes.js` / `browser-learned-recipes.js` — deterministic + learned step registries per site
- `browser-fastpaths.js` — cached fast paths for known flows
- `browser-platform-commerce.js` / `browser-platform-woocommerce.js` — platform-API tiers used before falling back to raw browser control
- `checkout-profile.js` / `vault-credentials.js` — stored delivery identity and credential vault
- `concierge-spend-guard.js` / `money-guard.js` — hard spend caps and review gates on real payments

Runs on Playwright (`playwright`, `playwright-extra`, `puppeteer-extra-plugin-stealth`).

### Database (Supabase)

Schema lives across `supabase/migrations/` (22 files as of this writing — base schema, auth, RLS, browser sessions/resume/session-events, routines, task entities/steps, travel, vault credentials, retention, subscriptions, and more). Row-level security is enabled; see `supabase-migration-rls.sql`.

## Getting Started

### Prerequisites

- Node.js 18+
- A Supabase project (free tier works)
- API keys for the services you want to use
- Xcode (for the iOS client)

### Backend setup

1. **Clone the repo**
   ```bash
   git clone https://github.com/commonsfounder/Oxy.git
   cd Oxy
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```
See `.env.example` for the full list — at minimum: `SUPABASE_URL`, `SUPABASE_KEY`, `OPENAI_API_KEY`, `OXY_BRAIN_PROVIDER`, and `OXY_SESSION_SECRET`. Set matching provider and model values. Optional blocks enable individual connectors (Google, Microsoft, Telegram, Stripe, Plaid, Monzo, etc.) — each connector degrades gracefully if its keys are absent.

4. **Run the database migrations**

   Apply the SQL files in `supabase/migrations/` against your Supabase project in order (via the SQL editor or CLI). `supabase-migration-rls.sql` must be applied for row-level security.

5. **Start the server**
   ```bash
   npm start        # production
   npm run dev       # development (nodemon)
   ```
   The API listens on `http://localhost:3000` (or `$PORT`).

6. **Create your first user**

   Register via `POST /auth/register` (or the iOS app's onboarding flow) — the app uses per-user accounts and signed sessions.

### iOS client setup

Open `OxyApp/OxyApp.xcodeproj` in Xcode, select the `OxyApp` scheme, and build. Point it at your local or deployed backend URL in the app's settings/config.

### Deploying to Fly.io

Fly.io is the production target. Authenticate once, then deploy the committed checkout:

```bash
fly auth login
node scripts/deploy-fly.js
fly status --app milgrain-live-2026
fly logs --app milgrain-live-2026
```

The deploy script stamps the image with `OXY_COMMIT_SHA`, `OXY_GIT_BRANCH`, and `OXY_BUILD_TIME`; verify the result with:

```bash
curl -s https://milgrain-live-2026.fly.dev/version
curl -s https://milgrain-live-2026.fly.dev/health
```

`proactive-job.js` and `retention-job.js` remain standalone entrypoints. Schedule them through the Fly-compatible scheduler/worker arrangement used by the production app; they are not separate platform jobs.

### Smoke-test

- `GET /health`, `GET /version`
- register/login, `POST /chat`
- a Google connector OAuth round-trip
- a live browser-automation order (`test/dev/jl-order-e2e.js`)

## Testing

```bash
npm test              # smoke tests (test/smoke/*.test.js)
npm run brain:evals   # context-brain evals
npm run latency       # latency benchmark
npm run release:check # syntax check + smoke tests, run before every deploy
```

## Project Structure

```
Oxy/
├── server.js                # Express entry point (Fly.io listener)
├── api/
│   ├── index.js              # Main API — chat, audio, memory, connectors, auth
│   ├── proxy.js               # Action dispatch helper
│   ├── intent-router.js       # Intent routing
│   ├── action-contracts.js    # Action schema/contracts
│   ├── geocoding.js           # Google Maps geocoding helper
│   └── services/              # ~40 domain services (browser automation, agent
│                               #   orchestration, routines, vault, payments,
│                               #   entity/task recall, retention, ...)
├── connectors/                 # 22 connector modules + index.js registry
├── OxyApp/                     # Native SwiftUI iOS client
│   └── OxyApp.xcodeproj        # scheme: OxyApp
├── supabase/migrations/        # 22 SQL migration files (schema, RLS, etc.)
├── test/                       # smoke tests, dev e2e runners, benchmarks
├── scripts/                    # one-off/maintenance scripts
├── mcp-server.js               # Standalone MCP tool server (separate process)
├── create-shortcut.js          # Apple Shortcuts generator
├── Milgrain.shortcut           # Pre-built Apple Shortcut file
├── proactive-job.js            # Scheduled proactive briefing/routine runner
├── retention-job.js            # Data retention enforcement job
├── AGENTS.md                   # Shared playbook for all coding agents in this repo
├── PRODUCT.md                  # Product register: users, purpose, brand, principles
└── docs/                       # Architecture plans, specs, runbooks, handoffs
```

## Notes

- `mcp-server.js` runs as a separate process/service when enabled — keep it separate from the main Fly.io app rather than bundling it into the API.
- See `AGENTS.md` for the shared engineering playbook (deploy discipline, git workflow, editing rules) followed by every agent working in this repo.
- See `docs/` for deeper architecture plans (travel concierge, browser-task session handoffs, UI direction, ship-readiness gaps).

## License

This project is proprietary. All rights reserved.

# Oxy

Oxy is an AI-powered personal assistant that you talk to like a friend. It connects to the real services you use every day — Gmail, Google Calendar, Telegram, Spotify, Uber, Trainline, and more — and takes action on your behalf through natural conversation. Voice or text, Oxy listens, understands, remembers, and does things for you.

## What It Does

- **Conversational AI** — Chat via text or voice. Oxy responds naturally, remembers personal context across conversations, and adapts its tone to your preferences over time.
- **Voice I/O** — Record audio from your browser, get it transcribed (Gemini), processed by the AI, and hear a spoken reply (Gemini TTS) — all in a single round-trip via Server-Sent Events.
- **Real Actions** — Oxy doesn't just talk. When you say "text Sarah I'm running late" or "book an Uber to the station", it actually does it through connected services.
- **Memory** — Oxy automatically extracts and stores personal facts from conversations ("Works at KPMG", "Has a dog named Biscuit") and uses them to personalise future replies.
- **Connectors** — A pluggable connector system lets Oxy interface with external services. Each connector handles auth, token refresh, and API calls independently.
- **Apple Shortcuts Bridge** — An included `.shortcut` file and generator script let Oxy trigger native iOS actions (iMessage, Reminders, HomeKit) from the AI's responses.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Frontend (PWA)                       │
│  React 18 · Babel (in-browser) · Single index.html      │
│  Voice recording · SSE streaming · Service Worker        │
└───────────────────┬─────────────────────────────────────┘
                    │  HTTPS
┌───────────────────▼─────────────────────────────────────┐
│                   API Server (Express 5)                 │
│  api/index.js — chat, audio, memory, connectors, auth   │
│  api/proxy.js — action dispatch (Vercel serverless)     │
└───────┬──────────────┬──────────────────────────────────┘
        │              │
┌───────▼──────┐ ┌─────▼──────────────────────────────────┐
│  Supabase    │ │          Connector System               │
│  (Postgres)  │ │  connectors/google.js   — Gmail + Cal  │
│              │ │  connectors/telegram.js — Messaging     │
│  Tables:     │ │  connectors/uber.js     — Ride booking  │
│  memories    │ │  connectors/trainline.js— Train search  │
│  conversations│ │  connectors/index.js   — Registry      │
│  action_log  │ └─────────────────────────────────────────┘
│  connectors  │
│  preferences │         ┌──────────────────────┐
└──────────────┘         │   External APIs      │
                         │  Gemini (LLM + TTS)  │
                         │  Gemini (STT)         │
                         │  Google (Gmail, Cal)  │
                         │  Telegram User API    │
                         │  Spotify Web API      │
                         │  Twilio (SMS/calls)   │
                         │  TransportAPI (trains) │
                         │  Google Maps Geocoding │
                         │  Home Assistant        │
                         └──────────────────────┘
```

### Frontend

The entire UI lives in a single `index.html` file — React 18 loaded from CDN, compiled in-browser by Babel. No build step required. It's a Progressive Web App with a service worker (`sw.js`) for offline caching and push notifications.

**Pages:**
| Page | Description |
|------|-------------|
| Chat | Main conversation view with text input and voice recording (hold-to-talk) |
| Connectors | Toggle connected services on/off, OAuth flows for Google & Telegram |
| Memory | View and manage what Oxy remembers about you |
| Action History | Log of every action Oxy has executed |
| Settings | Voice toggle, autonomy level, data management |

### Backend

An Express 5 server deployed on Vercel (serverless) or as a standalone Node.js process.

**Core flow for a message:**
1. User sends text or audio
2. Audio is transcribed via Gemini
3. Conversation history, memories, preferences, and connected-app context are loaded from Supabase
4. Gemini generates a response (with Google Search grounding enabled)
5. If the response contains an `<action>` block, actions are dispatched to the connector system
6. For data-fetching actions (train times, emails, calendar), results are fed back to Gemini for natural summarisation
7. TTS audio is generated via Gemini and streamed back alongside the text response
8. Memory facts are extracted and saved in the background

### Connector System

Connectors are modular service integrations in `connectors/`. Each exports:
- `SUPPORTED_ACTIONS` — array of action type strings it handles
- `execute(userId, action, params)` — performs the action and returns `{ success, text, ... }`

**Currently implemented:**

| Connector | Actions | Auth |
|-----------|---------|------|
| **Google** | `send_email`, `get_emails`, `search_emails`, `create_calendar_event`, `get_calendar_events` | OAuth 2.0 (per-user tokens stored in Supabase) |
| **Telegram** | `send_telegram`, `get_telegram_contacts` | Telegram User API with phone verification + optional 2FA |
| **Uber** | `book_uber` | Deep links (no auth required) |
| **Trainline** | `search_trains` | TransportAPI keys + Trainline booking URLs |

**Planned (UI-visible but not yet implemented):** iMessage, WhatsApp, Spotify, Apple Reminders, Deliveroo, Monzo, HomeKit, Google Maps, Notion, Betfair.

### MCP Server

`mcp-server.js` is a standalone Express server (port 3100) exposing Oxy's tools via a simple `POST /tools` JSON-RPC interface. This enables external AI agents to call Oxy's capabilities (messaging, reminders, music, calendar, smart home).

### Database (Supabase)

| Table | Purpose |
|-------|---------|
| `conversations` | Chat history (role, content, timestamps per user) |
| `memories` | Extracted personal facts about each user |
| `action_log` | Audit trail of every action executed |
| `connectors` | Per-user connector state and OAuth tokens |
| `preferences` | Learned user preferences (response length, tone, format) |

Schema is in `supabase-migration.sql`.

## Getting Started

### Prerequisites

- Node.js 18+
- A Supabase project (free tier works)
- API keys for the services you want to use

### Setup

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
   Fill in the values — at minimum you need:
   - `SUPABASE_URL` and `SUPABASE_KEY` — for the database
   - `GEMINI_API_KEY` — for the AI (conversation + TTS + speech-to-text)
   - `OXY_SESSION_SECRET` — signs per-user login sessions

   Optional (enable more connectors):
   - `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` — Gmail + Calendar
   - `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` — Telegram messaging
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` — SMS/calls
   - `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN` — Music
   - `TRANSPORT_API_APP_ID`, `TRANSPORT_API_APP_KEY` — Live train times
   - `GOOGLE_MAPS_API_KEY` — Geocoding for Uber
   - `HOME_ASSISTANT_URL`, `HOME_ASSISTANT_TOKEN` — Smart home

4. **Run the database migration**

   Execute the SQL in `supabase-migration.sql` against your Supabase project (via the SQL editor in the Supabase dashboard).

5. **Start the server**
   ```bash
   npm start        # production
   npm run dev      # development (with nodemon)
   ```

   The app is available at `http://localhost:3000` (or whichever port Express binds to).

6. **Create your first user**

   Open the app and register with a user ID and password. Oxy now uses per-user accounts and signed sessions instead of a shared API secret.

### Deploying to Vercel

The project includes a `vercel.json` configuration for serverless deployment:

```bash
vercel deploy
```

Set all environment variables in the Vercel dashboard under Project Settings → Environment Variables.

### Deploying to Cloud Run

Cloud Run is the best fit if you want to get Oxy off Vercel and prepare for a later Gemini Live / realtime voice backend. This repo now runs as a standard Node service and includes:

- `server.js` listening on `0.0.0.0:$PORT`
- `Dockerfile` for Cloud Run source or container deploys
- `.dockerignore` to keep deploys lean
- `cloudrun.env.example.yaml` for runtime env vars

1. **Install and auth `gcloud`**
   ```bash
   gcloud auth login
   gcloud config set project YOUR_PROJECT_ID
   ```

2. **Enable the required services**
   ```bash
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
   ```

3. **Create your Cloud Run env file**
   ```bash
   cp cloudrun.env.example.yaml cloudrun.env.yaml
   ```
   Fill in the real values. For production, Secret Manager is better than plain env files, but this is the fastest path to a working deploy.

4. **Deploy from source**
   ```bash
   gcloud run deploy oxy \
     --source . \
     --region europe-west2 \
     --allow-unauthenticated \
     --env-vars-file cloudrun.env.yaml
   ```

   Cloud Run will use the checked-in `Dockerfile` automatically.

5. **Set `APP_URL` after the first deploy**

   Once the service is up, get its public URL:
   ```bash
   gcloud run services describe oxy \
     --region europe-west2 \
     --format="value(status.url)"
   ```

   Then update the service so OAuth and browser postMessage checks use the real Cloud Run URL:
   ```bash
   gcloud run services update oxy \
     --region europe-west2 \
     --update-env-vars APP_URL=https://YOUR-SERVICE-URL.a.run.app
   ```

6. **Smoke-test**

   Check:
   - `GET /health`
   - register/login
   - chat
   - voice
   - Google connector OAuth callback

Notes:
- `vercel.json` can stay in the repo while you migrate; Cloud Run ignores it.
- `mcp-server.js` is a separate process. If you still want the MCP server in Cloud Run, deploy it as a second service instead of trying to run both processes in one container.

## Project Structure

```
Oxy/
├── index.html              # Full frontend (React PWA, CSS, all pages)
├── server.js               # Express entry point
├── sw.js                   # Service worker (offline + push notifications)
├── manifest.json           # PWA manifest
├── package.json            # Dependencies and scripts
├── vercel.json             # Vercel deployment config
├── .env.example            # Environment variable template
├── supabase-migration.sql  # Database schema
├── mcp-server.js           # Standalone MCP tool server
├── create-shortcut.js      # Apple Shortcuts generator
├── Oxy.shortcut            # Pre-built Apple Shortcut file
├── api/
│   ├── index.js            # Main API (chat, audio, memory, connectors, auth)
│   ├── proxy.js            # Action dispatch proxy (Vercel serverless)
│   └── geocoding.js        # Google Maps geocoding helper
├── connectors/
│   ├── index.js            # Connector registry and dispatcher
│   ├── google.js           # Gmail + Google Calendar connector
│   ├── telegram.js         # Telegram User API connector
│   ├── uber.js             # Uber deep-link connector
│   └── trainline.js        # UK train search connector
└── icons/                  # PWA icons (192px, 512px, SVG)
```

## How It Works — End to End

1. **You speak or type** → The frontend captures audio via `MediaRecorder` or takes text input
2. **Audio is transcribed** → Sent to `/process-audio`, transcribed by Gemini
3. **Context is assembled** → Your memories, conversation history, preferences, connected apps, and messaging patterns are loaded from Supabase
4. **Gemini thinks** → The AI generates a response using all available context, with Google Search grounding for real-world facts
5. **Actions are executed** → If the response includes an `<action>` block, each action is dispatched to the relevant connector
6. **Results are spoken back** → Gemini TTS converts the response to audio, streamed back as base64 WAV via SSE
7. **Memory is updated** → Personal facts are extracted and saved for future conversations
8. **Preferences evolve** → If you say things like "be more concise" or "use bullet points", Oxy adapts

## License

This project is proprietary. All rights reserved.

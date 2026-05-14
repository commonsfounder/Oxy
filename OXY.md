# Oxy — Single Source of Truth

> Oxy is an AI-powered personal assistant you talk to like a friend. It connects to the real services you use every day — Gmail, Google Calendar, Telegram, Spotify, Uber, Trainline, and more — and takes action on your behalf through natural conversation. Voice or text, Oxy listens, understands, remembers, and does things.

---

## Table of Contents

1. [Vision & Ethos](#1-vision--ethos)
2. [Architecture Overview](#2-architecture-overview)
3. [Frontend (PWA)](#3-frontend-pwa)
4. [Backend (Express 5)](#4-backend-express-5)
5. [AI Layer — Gemini](#5-ai-layer--gemini)
6. [Realtime Voice — Gemini Live](#6-realtime-voice--gemini-live)
7. [Authentication & Sessions](#7-authentication--sessions)
8. [Connector System](#8-connector-system)
9. [MCP Server](#9-mcp-server)
10. [Database — Supabase](#10-database--supabase)
11. [Service Worker & Offline](#11-service-worker--offline)
12. [Apple Shortcuts Bridge](#12-apple-shortcuts-bridge)
13. [Data Flows](#13-data-flows)
14. [Environment Variables](#14-environment-variables)
15. [Project Structure](#15-project-structure)
16. [Deployment](#16-deployment)
17. [Known Issues & Audit Notes](#17-known-issues--audit-notes)

---

## 1. Vision & Ethos

Oxy's goal is to be the assistant that actually does things. The design philosophy is captured directly in the system prompt injected into every AI conversation:

> *"You're genuinely here to help. You don't question, gate, or hedge. Default to yes. Only refuse if someone asks you to help them hurt others. Send the message. Set the reminder. Make the call. No hesitation, no 'are you sure?'. You're a person they trust, not a corporate chatbot."*

Core principles:

- **Action-first** — Oxy executes. When a user says "text Sarah I'm running late", it sends the text. When they say "book an Uber", it opens the booking. No confirmation dialogs, no hand-wringing.
- **Memory** — Oxy automatically extracts and stores personal facts from conversations ("Works at KPMG", "Has a dog named Biscuit") and uses them to personalise every future reply.
- **Natural conversation** — Voice or text. Casual, direct, like a friend who happens to have access to all your apps.
- **Preference evolution** — If you say "be more concise" or "use bullet points", Oxy adapts and stores the preference permanently.
- **Factuality discipline** — The system prompt explicitly forbids hallucination. Oxy has Google Search grounding. When it doesn't know, it says so.

Oxy is **not** a chatbot with a to-do list. It is an agent that has persistent memory, learned preferences, and real integrations with the world.

---

## 2. Architecture Overview

```
┌───────────────────────────────────────────────────────────┐
│                      Frontend (PWA)                        │
│   React 18 · Babel (in-browser) · Single index.html       │
│   Voice recording · SSE streaming · Service Worker         │
└──────────────────────┬────────────────────────────────────┘
                       │ HTTPS / WSS
┌──────────────────────▼────────────────────────────────────┐
│              server.js  (Node.js entry point)              │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  api/index.js  (Express 5)                          │  │
│  │  chat · audio · memory · connectors · auth          │  │
│  └─────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  live.js  (WebSocket server — Gemini Live)          │  │
│  │  realtime bidirectional audio ↔ Gemini              │  │
│  └─────────────────────────────────────────────────────┘  │
└──────┬──────────────────────┬─────────────────────────────┘
       │                      │
┌──────▼──────┐   ┌───────────▼──────────────────────────────┐
│  Supabase   │   │          Connector Registry               │
│  (Postgres) │   │  connectors/google.js   — Gmail + Cal    │
│             │   │  connectors/telegram.js — Messaging       │
│  users      │   │  connectors/uber.js     — Ride booking    │
│  convos     │   │  connectors/ubereats.js — Food delivery   │
│  memories   │   │  connectors/deliveroo.js— Food delivery   │
│  action_log │   │  connectors/trainline.js— UK trains       │
│  connectors │   │  connectors/netflix.js  — TV/film         │
│  preferences│   │  connectors/index.js    — Dispatcher      │
└─────────────┘   └──────────────────────────────────────────┘
                             │
              ┌──────────────▼──────────────┐
              │       External APIs          │
              │  Gemini 3 Flash (LLM)        │
              │  Gemini Live 2.5 (realtime)  │
              │  Gemini TTS / STT            │
              │  Google Gmail + Calendar     │
              │  Telegram User API (MTProto) │
              │  Spotify Web API             │
              │  Twilio SMS / Calls          │
              │  TransportAPI (UK trains)    │
              │  Google Maps Geocoding       │
              │  Home Assistant REST API     │
              └─────────────────────────────┘
```

There are two servers in the repo:

| Server | File | Default Port | Purpose |
|--------|------|-------------|---------|
| Main app | `server.js` → `api/index.js` + `live.js` | 3000 | Chat, auth, connectors, PWA, WebSocket voice |
| MCP server | `mcp-server.js` | 3100 | Tool endpoint for external AI agents |

---

## 3. Frontend (PWA)

The entire UI is a single `index.html` file. React 18 and ReactDOM are loaded from the Cloudflare CDN; Babel standalone compiles JSX in the browser at runtime (no build step). The app registers as a Progressive Web App via `manifest.json` and `sw.js`.

### Pages

| Page | Route / State | Description |
|------|---------------|-------------|
| **Chat** | default | Main conversation view. Text input, hold-to-talk voice recording, streamed AI responses with TTS audio playback. |
| **Connectors** | `#connectors` | Toggle connected services on/off. OAuth flows for Google and Telegram auth. Shows which connectors are enabled. |
| **Memory** | `#memory` | View and delete the personal facts Oxy has extracted about you. Search within memories. |
| **Action History** | `#actions` | Timestamped audit log of every action Oxy has executed — what was sent, what was booked, what succeeded or failed. |
| **Settings** | `#settings` | Voice on/off, autonomy level, TTS voice selection, data management (clear history, clear memories). |

### Voice Input Flow

1. User holds the microphone button → `MediaRecorder` captures audio as WebM/Opus
2. On release → audio blob POSTed to `POST /process-audio` (multipart form, max 25 MB)
3. Server transcribes via Gemini STT, processes the chat turn, streams TTS audio back
4. Frontend decodes base64 WAV chunks from SSE and plays them sequentially via `AudioContext`

### Realtime Voice (Gemini Live)

A separate WebSocket path (`/realtime-voice`) connects the browser's microphone directly to Gemini Live for low-latency bidirectional audio. This path is wired up in `live.js` and attached to the same HTTP server as the main app.

### Offline / PWA

- `sw.js` implements network-first for HTML navigation requests (always fresh code)
- Cache-first for static assets (icons, manifests)
- Supabase and Google API calls always bypass the cache
- Push notifications supported; service worker handles `push` events and shows native OS notifications

---

## 4. Backend (Express 5)

**Entry point:** `server.js` — creates an HTTP server, mounts the Express app (`api/index.js`), and attaches the WebSocket server (`live.js`).

**Main API:** `api/index.js`

### Middleware Stack

1. `cors()` — CORS (currently wildcard; see audit notes)
2. `express.json()` — body parsing
3. Auth middleware — checks `publicPaths` set; all other routes require a valid session token via `requireSessionAuth`

### Public Paths (no auth required)

| Path | Purpose |
|------|---------|
| `GET /` | Serves `index.html` |
| `GET /health` | Health check + env var status |
| `GET /install-shortcut` | Downloads the Apple Shortcut file |
| `GET /auth/google/callback` | Google OAuth redirect handler |
| `POST /auth/register` | New user registration |
| `POST /auth/login` | Login → returns session token |

### Key Authenticated Endpoints

| Method + Path | Description |
|---------------|-------------|
| `POST /chat` | Main chat turn — assembles context, calls Gemini, dispatches actions, saves conversation |
| `POST /chat/stream` | Streaming variant — SSE response with text chunks, action results, TTS audio |
| `POST /process-audio` | Audio upload → STT → chat turn |
| `GET /memories/:userId` | List user's memory facts |
| `POST /memories/:userId` | Add a memory fact |
| `DELETE /memories/:userId/:id` | Delete a memory fact |
| `GET /history/:userId` | Conversation history (paginated) |
| `GET /history/:userId/search` | Full-text search across chat history |
| `DELETE /history/:userId` | Clear all conversation history |
| `GET /connectors/:userId` | Get connector state for user |
| `POST /connectors` | Enable/disable a connector |
| `POST /action-log` | Record an action execution |
| `GET /action-log/:userId` | Retrieve action history |
| `GET /preferences/:userId` | Get learned preferences |
| `POST /preferences/:userId` | Set a preference |
| `POST /images/generate` | Generate an image via Gemini Imagen |
| `GET /auth/google/redirect-uri` | Returns the configured OAuth redirect URI |
| `POST /auth/telegram/start` | Begin Telegram phone auth |
| `POST /auth/telegram/verify` | Verify Telegram OTP code |
| `POST /auth/telegram/verify-2fa` | Handle Telegram 2FA password |
| `GET /debug/:userId` | Debug info (env, connector presence, email test) |

### Context Cache

A per-user in-memory `Map` (`contextCache`) caches assembled AI context (memories, preferences, connector state) for 5 minutes with a 500-entry cap. Invalidated on writes to memories or preferences. Skipped in serverless (Vercel) deployments where the Map is ephemeral per invocation.

### Prompt Cache

System prompt and static instruction text are pre-warmed into Gemini's prompt cache at startup (`ensurePromptCacheWarm`). TTL configurable via `OXY_PROMPT_CACHE_TTL` (default `3600s`). Reduces latency and cost on repeated calls.

### Rate Limiting

Audio transcription (`/process-audio`) is rate-limited to 10 requests per minute per user via an in-memory `Map`. No rate limiting on other endpoints (see audit notes).

---

## 5. AI Layer — Gemini

Oxy uses Google Gemini for everything AI-related. There are two SDK clients in use:

| Client | Package | Usage |
|--------|---------|-------|
| Legacy | `@google/generative-ai` | Chat (generateContent) |
| Modern | `@google/genai` | TTS streaming, image generation, Gemini Live |

### Models

| Role | Default Model | Env Override |
|------|--------------|-------------|
| Primary reasoning (chat) | `gemini-3-flash-preview` | `OXY_REASONING_MODEL` |
| Fast/streaming | `gemini-3-flash-preview` | `OXY_FAST_MODEL` / `OXY_STREAM_MODEL` |
| Realtime voice | `gemini-live-2.5-flash-preview` | `OXY_LIVE_MODEL` |

Enterprise (Vertex AI) mode is supported: set `GOOGLE_GENAI_USE_ENTERPRISE=true` + `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`.

### System Prompt ("Oxcy")

The system prompt (`OXCY_SYSTEM_PROMPT` in `api/index.js:184`) defines Oxy's entire personality and operating rules. Key sections:

- **Core Ethos** — Be helpful, default to yes, act like a trusted friend
- **Factuality** — Never hallucinate; use Google Search for real-world facts; say "I don't know" plainly
- **Actions** — Full list of every action type with schema; the AI must return an `<action>` JSON block when executing
- **Absolute Rules** — 18 numbered rules covering action discipline, communication register (formal emails vs casual messages), and retry behaviour

### Action Protocol

When Gemini decides to take an action, it embeds an `<action>` XML block in its response:

```
<action>
{
  "actions": [
    {"type": "send_telegram", "input": {"contact": "Sarah", "message": "Running 10 mins late"}},
    {"type": "create_reminder", "input": {"title": "Call dentist", "due_date": "2025-05-15T09:00:00"}}
  ]
}
</action>
```

The spoken text in the response is everything outside the `<action>` tags. The `parseActions` function extracts both. Multi-action responses execute all actions in parallel. Data-fetching actions (emails, calendar, trains) return their results back into a second Gemini call for natural summarisation.

### TTS

`generateSpeech` / `generateSpeechStream` call Gemini's TTS endpoint. Raw PCM is wrapped in a WAV header by `pcmToWav`. Voice names are validated against a 30-voice allowlist (`GEMINI_TTS_VOICES`). Default voice: `Schedar`.

### Memory Extraction

After each assistant turn, a background call to the `FAST_MODEL` extracts new personal facts from the conversation. Extracted facts are stored in the `memories` table and used to populate context on the next turn.

---

## 6. Realtime Voice — Gemini Live

**File:** `live.js`  
**WebSocket path:** `/realtime-voice`  
**Model:** `gemini-live-2.5-flash-preview` (or Vertex variant)

The realtime voice path establishes a persistent WebSocket from the browser to the server, and a persistent WebSocket from the server to Gemini Live. Audio flows bidirectionally in near-real-time.

### Connection Handshake

1. Browser connects to `wss://<host>/realtime-voice?authToken=<token>`
2. Server verifies the token via `verifySignedPayload`
3. User's context (memories, preferences, connector state) is loaded from Supabase
4. A Gemini Live session is opened with the Oxy system prompt + user context + all function declarations

### Message Protocol (browser ↔ server)

All messages are JSON objects with a `type` field:

| Type (browser → server) | Payload | Description |
|------------------------|---------|-------------|
| `audio` | `{ data: base64, mimeType }` | Raw PCM audio chunk from microphone |
| `text` | `{ text }` | Text message (typed or synthetic) |
| `end_turn` | — | Signal end of user speech |
| `interrupt` | — | Cancel current AI response |
| `set_voice` | `{ voice }` | Change TTS voice |

| Type (server → browser) | Payload | Description |
|------------------------|---------|-------------|
| `live-audio` | `{ data: base64, mimeType }` | TTS audio chunk from Gemini |
| `live-text` | `{ text, final }` | Transcript chunk or final response text |
| `live-action` | `{ actions }` | Actions being executed |
| `live-action-result` | `{ results }` | Action execution results |
| `live-interrupted` | — | AI response was interrupted |
| `live-error` | `{ error }` | Error message |

### Function Declarations

The Live session exposes 17 function declarations to Gemini, covering all the same actions as the text chat path: email, calendar, Uber, Telegram, trains, Uber Eats, Deliveroo, Netflix, reminders, visuals, diagrams, presentations.

When Gemini calls a function during a live session, the server dispatches it to the connector system, returns the result to Gemini, and forwards a `live-action-result` event to the browser.

### Transcript Merging

The `mergeTranscript` function handles overlapping or partial transcript chunks from Gemini (which streams text incrementally) by detecting and deduplicating suffix/prefix overlaps.

---

## 7. Authentication & Sessions

**File:** `auth.js`

Oxy uses its own HMAC-based signed session tokens — no JWTs, no third-party auth library.

### Token Format

```
base64url(JSON.stringify(payload)) . HMAC-SHA256(encodedPayload)
```

Payload structure:
```json
{ "type": "session", "userId": "alice", "exp": 1747123456789 }
```

Session TTL: **7 days**. No refresh — the user re-logs in after expiry.

### Token Delivery

Tokens are accepted via (in priority order):
1. `Authorization: Bearer <token>` header
2. `X-Session-Token` header
3. `?authToken=<token>` query parameter (security risk — see audit notes)

### User Accounts

Stored in the `users` table in Supabase.

- **User IDs**: alphanumeric + `-_`, 1–128 characters (`/^[a-zA-Z0-9_-]{1,128}$/`)
- **Passwords**: hashed with `crypto.scryptSync` (salt:derived hex format, 64-byte key)
- **Registration**: `POST /auth/register` — checks userId uniqueness, hashes password, inserts user
- **Login**: `POST /auth/login` — looks up user, verifies password with timing-safe compare, returns signed token

### OAuth State Tokens

Google OAuth state parameters use the same `signPayload` mechanism with a **15-minute TTL** and `type: 'google_oauth'` to prevent CSRF.

---

## 8. Connector System

**Directory:** `connectors/`  
**Dispatcher:** `connectors/index.js`

Each connector is a module that exports:
- `SUPPORTED_ACTIONS` — array of action type strings
- `execute(userId, action, params)` — returns `{ success: boolean, text: string, ... }`

The dispatcher (`dispatch`) looks up the action in the registry and calls the appropriate connector.

### Connector Registry

| Connector | File | Actions | Auth Method |
|-----------|------|---------|-------------|
| **Google** | `google.js` | `send_email`, `get_emails`, `search_emails`, `create_calendar_event`, `get_calendar_events` | OAuth 2.0 tokens per user in Supabase `connectors` table; falls back to env `GMAIL_REFRESH_TOKEN` |
| **Telegram** | `telegram.js` | `send_telegram`, `get_telegram_contacts` | Telegram MTProto User API; phone number + OTP + optional 2FA; session string stored in Supabase |
| **Uber** | `uber.js` | `book_uber` | Deep link — no auth needed. Geocodes destination via Google Maps then constructs `uber://` URL |
| **Uber Eats** | `ubereats.js` | `order_uber_eats` | Deep link / web handoff |
| **Deliveroo** | `deliveroo.js` | `order_deliveroo` | Deep link / web handoff |
| **Netflix** | `netflix.js` | `search_netflix_title`, `add_to_netflix_list` | Deep link / web handoff |
| **Trainline** | `trainline.js` | `search_trains` | TransportAPI keys for live departures; Trainline booking deep link |

### Adding a New Connector

1. Create `connectors/myservice.js` exporting `SUPPORTED_ACTIONS` and `execute`
2. Import it in `connectors/index.js` and register its actions in the registry loop
3. Add its ID to `IMPLEMENTED_CONNECTORS`
4. Add its action types to the `OXCY_SYSTEM_PROMPT` action list in `api/index.js`
5. Add the corresponding function declaration to `LIVE_FUNCTION_DECLARATIONS` in `live.js`

### Google Connector Detail

Token flow: DB lookup → if missing, fall back to env vars and save to DB. Access token refreshed automatically when within 60s of expiry. Emails are formatted for human readability by `summarizeEmails`.

### Telegram Connector Detail

Uses the Telegram MTProto User API (not Bot API) via the `telegram` npm package. This gives Oxy access to the user's actual Telegram account — sending messages, reading contacts. Auth is a three-step flow: start (send code) → verify (enter code) → optional 2FA password. Session string persisted to `connectors.tokens` in Supabase.

---

## 9. MCP Server

**File:** `mcp-server.js`  
**Port:** 3100 (default)

A standalone Express server that exposes Oxy's tools via a simple `POST /tools` JSON-RPC interface. This allows external AI agents (or other systems) to call Oxy's capabilities programmatically.

### Interface

```
POST /tools
Authorization: Bearer <session-token>

{ "name": "tool_name", "arguments": { ... } }
```

Returns `{ success: true|false, text: "...", ... }` or `{ success: false, error: "..." }`.

### Available Tools

| Tool | Description | Requires |
|------|-------------|---------|
| `send_message` | Send SMS (Twilio) or Telegram Bot message | `TWILIO_*` or `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` |
| `create_reminder` | Create a reminder (stored in `reminders.json`) | — |
| `get_reminders` | List active reminders | — |
| `complete_reminder` | Mark a reminder done by ID | — |
| `make_call` | Initiate a Twilio phone call | `TWILIO_*` |
| `play_music` | Search Spotify and play on active device | `SPOTIFY_*` |
| `create_calendar_event` | Create a Google Calendar event | `GOOGLE_CALENDAR_CREDENTIALS` JSON |
| `smart_home` | Call a Home Assistant service | `HOME_ASSISTANT_URL` + `HOME_ASSISTANT_TOKEN` |

**Note:** Reminders in the MCP server are stored in a flat `reminders.json` file on disk, not in Supabase, and are not scoped per-user (see audit notes).

---

## 10. Database — Supabase

**Schema file:** `supabase-migration.sql`  
**Client:** `@supabase/supabase-js` v2, service-role key, created via `runtime.js`

### Tables

#### `users`
```sql
id          UUID PRIMARY KEY
user_id     TEXT UNIQUE NOT NULL     -- human-chosen identifier
password_hash TEXT NOT NULL          -- salt:scrypt_hex
created_at  TIMESTAMPTZ
updated_at  TIMESTAMPTZ
```

#### `conversations`
```sql
id          UUID PRIMARY KEY
user_id     TEXT NOT NULL
role        TEXT NOT NULL            -- 'user' | 'assistant'
content     TEXT NOT NULL            -- message text or JSON blob
created_at  TIMESTAMPTZ
```
Index: `(user_id, created_at DESC)`

#### `memories`
```sql
id          UUID PRIMARY KEY
user_id     TEXT NOT NULL
content     TEXT NOT NULL            -- "Works at KPMG", "Has a dog named Biscuit"
source      TEXT DEFAULT 'fact'
created_at  TIMESTAMPTZ
```

#### `action_log`
```sql
id          UUID PRIMARY KEY
user_id     TEXT NOT NULL
action      JSONB NOT NULL           -- { type, input, status, resultText, errorText }
status      TEXT DEFAULT 'executed'
error       TEXT
created_at  TIMESTAMPTZ
```

#### `connectors`
```sql
id          UUID PRIMARY KEY
user_id     TEXT NOT NULL
connector_id TEXT NOT NULL           -- 'google', 'telegram', etc.
enabled     BOOLEAN DEFAULT false
tokens      JSONB                    -- OAuth tokens, session strings
updated_at  TIMESTAMPTZ
UNIQUE(user_id, connector_id)
```

#### `preferences`
```sql
id          UUID PRIMARY KEY
user_id     TEXT NOT NULL
key         TEXT NOT NULL            -- e.g. 'response_length', 'tone', 'format'
value       TEXT NOT NULL
updated_at  TIMESTAMPTZ
UNIQUE(user_id, key)
```

### Runtime Client

`runtime.js` exports `createSupabaseServiceClient()` which creates a Supabase client using `SUPABASE_URL` and `SUPABASE_KEY` (service role key). Also exports `createGeminiServiceClient()` and `getMissingRuntimeEnv()` for startup validation.

---

## 11. Service Worker & Offline

**File:** `sw.js`

Caching strategies:
- **Navigation requests + `index.html`**: Network-first; falls back to cached HTML when offline
- **Static assets** (icons, manifests): Cache-first; fetched and cached on first access
- **Supabase + Google API calls**: Always network; never cached

PWA shell (`SHELL`) cached on install: `manifest.json`, `icons/icon-192.png`, `icons/icon-512.png`, `icons/icon.svg`.

Push notification support: the service worker handles `push` events and renders native OS notifications. Clicking a notification navigates to the URL in `event.notification.data.url`.

---

## 12. Apple Shortcuts Bridge

**Files:** `Oxy.shortcut`, `create-shortcut.js`, `gen-icons.js`

The included Apple Shortcut (`.shortcut` file) lets Oxy trigger native iOS actions — iMessage, Reminders, HomeKit — that can't be done via the web. The flow is:

1. Oxy's AI response includes an action that requires a native iOS capability
2. The server signs a payload with the action details
3. The shortcut is triggered (via URL scheme or notification)
4. The shortcut executes the native iOS action and reports back

`create-shortcut.js` generates the shortcut file programmatically. `gen-icons.js` is a utility for generating the PWA icon set.

---

## 13. Data Flows

### Standard Text Chat Turn

```
User types message
      │
POST /chat { userId, message }
      │
      ├── Load context from cache or Supabase:
      │     memories, recent conversations (last 40),
      │     preferences, connector state
      │
      ├── Build Gemini request:
      │     system prompt + context + conversation history + message
      │
      ├── Call Gemini generateContent
      │     (with Google Search grounding)
      │
      ├── parseActions(response)
      │     ├── spoken text
      │     └── actions[]
      │
      ├── dispatch each action → connector.execute()
      │     ├── Data-fetch actions (emails, calendar, trains):
      │     │     results fed back to Gemini for summarisation
      │     └── Fire-and-forget actions (send, book):
      │           return success/failure text
      │
      ├── Save assistant message + action results to conversations
      │
      ├── Log executed actions to action_log
      │
      └── Background: extract memory facts from turn
                      save new facts to memories
                      invalidate context cache

Response → { text, actions[], actionResults[] }
```

### Streaming Chat + TTS Turn

Same as above but response is SSE. Events emitted:
- `text` — text chunks as they stream
- `actions` — list of actions being executed
- `actionResults` — results after execution
- `audio` — base64 WAV chunks of TTS
- `done` — stream complete

### Voice Input Turn

```
User holds mic button → MediaRecorder captures WebM/Opus
On release →
      POST /process-audio (multipart, audio file + userId)
            │
            ├── Rate limit check (10/min per user)
            ├── Gemini STT → transcript text
            └── Continues as streaming chat turn above
```

### Realtime Voice (Gemini Live)

```
Browser connects wss://.../realtime-voice?authToken=...
      │
      ├── Token verified
      ├── User context loaded (memories, prefs, connectors)
      ├── Gemini Live session opened
      │     system prompt + context + function declarations
      │
Browser sends audio chunks →
      server forwards to Gemini Live →
      Gemini streams audio + text + function calls back →
      server forwards audio to browser (live-audio events)
      server executes any function calls via connector system
      server sends live-action-result back to Gemini + browser
```

---

## 14. Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL (`https://xxx.supabase.co`) |
| `SUPABASE_KEY` | Supabase service-role key |
| `GEMINI_API_KEY` | Google Gemini API key (chat + TTS + STT) |
| `OXY_SESSION_SECRET` | Long random secret for signing session tokens |

### Optional — Model Overrides

| Variable | Default | Description |
|----------|---------|-------------|
| `OXY_REASONING_MODEL` | `gemini-3-flash-preview` | Primary chat model |
| `OXY_FAST_MODEL` | `gemini-3-flash-preview` | Fast/extraction model |
| `OXY_STREAM_MODEL` | same as FAST | Streaming chat model |
| `OXY_LIVE_MODEL` | `gemini-live-2.5-flash-preview` | Realtime voice model |
| `OXY_PROMPT_CACHE_TTL` | `3600s` | Gemini prompt cache TTL |
| `GOOGLE_GENAI_USE_ENTERPRISE` | — | `true` to use Vertex AI |
| `GOOGLE_CLOUD_PROJECT` | — | GCP project (Vertex) |
| `GOOGLE_CLOUD_LOCATION` | `us-central1` | GCP region (Vertex) |

### Optional — Connectors

| Variable | Connector |
|----------|-----------|
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | Google (Gmail + Calendar) |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | Telegram User API |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | SMS / Calls (MCP) |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN` | Music (MCP) |
| `TRANSPORT_API_APP_ID`, `TRANSPORT_API_APP_KEY` | UK train times |
| `GOOGLE_MAPS_API_KEY` | Geocoding (Uber deep links) |
| `HOME_ASSISTANT_URL`, `HOME_ASSISTANT_TOKEN` | Smart home (MCP) |
| `GOOGLE_CALENDAR_CREDENTIALS` | Calendar (MCP server — JSON string) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram Bot messages (MCP) |

### Optional — App Config

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `TIMEZONE` | `Europe/London` | Timezone for date formatting |
| `APP_URL` | — | Public URL (used for OAuth redirects + CORS) |

---

## 15. Project Structure

```
Oxy/
├── index.html              # Complete frontend (React PWA, all pages, all CSS)
├── server.js               # Node.js entry point; creates HTTP server + WebSocket
├── live.js                 # Gemini Live WebSocket handler (realtime voice)
├── auth.js                 # HMAC session tokens, password hashing, auth middleware
├── runtime.js              # Supabase + Gemini client factories; env validation
├── mcp-server.js           # Standalone MCP tool server (port 3100)
├── sw.js                   # Service worker (offline + push notifications)
├── manifest.json           # PWA manifest
├── package.json            # Dependencies (Express 5, Gemini, Supabase, Telegram, ws)
├── vercel.json             # Vercel serverless config
├── Dockerfile              # Cloud Run container
├── cloudrun.env.example.yaml # Cloud Run env template
├── .env.example            # Environment variable template
├── supabase-migration.sql  # Full database schema (idempotent)
├── create-shortcut.js      # Apple Shortcut file generator
├── gen-icons.js            # PWA icon generator utility
├── Oxy.shortcut            # Pre-built Apple Shortcut (iOS native actions)
│
├── api/
│   ├── index.js            # Main Express app: all routes, AI calls, action dispatch
│   ├── proxy.js            # Action dispatch proxy (Vercel serverless function)
│   └── geocoding.js        # Google Maps geocoding helper for Uber
│
├── connectors/
│   ├── index.js            # Registry + dispatcher (dispatch function)
│   ├── google.js           # Gmail + Google Calendar (OAuth 2.0)
│   ├── telegram.js         # Telegram User API (MTProto)
│   ├── uber.js             # Uber (deep links + geocoding)
│   ├── ubereats.js         # Uber Eats (deep links / web handoff)
│   ├── deliveroo.js        # Deliveroo (deep links / web handoff)
│   ├── netflix.js          # Netflix (deep links / web handoff)
│   └── trainline.js        # UK trains (TransportAPI + Trainline booking link)
│
└── icons/
    ├── icon.svg
    ├── icon-192.png
    └── icon-512.png
```

---

## 16. Deployment

### Local Development

```bash
git clone https://github.com/commonsfounder/Oxy.git
cd Oxy
npm install
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_KEY, GEMINI_API_KEY, OXY_SESSION_SECRET
# run schema: paste supabase-migration.sql into Supabase SQL editor
npm run dev     # nodemon, restarts on changes
```

App available at `http://localhost:3000`.

To run the MCP server alongside the main app:
```bash
node mcp-server.js   # separate terminal, port 3100
```

### Vercel (Serverless)

```bash
vercel deploy
```

The `vercel.json` routes all requests through `api/index.js`. The realtime WebSocket path (`/realtime-voice`) does **not** work on Vercel (serverless functions don't support persistent WebSocket connections). Set all env vars in the Vercel dashboard.

### Cloud Run (Recommended for Production)

Cloud Run is the best fit: supports persistent WebSocket connections (Gemini Live), long-running processes, and the service worker push notification paths.

```bash
gcloud run deploy oxy \
  --source . \
  --region europe-west2 \
  --allow-unauthenticated \
  --env-vars-file cloudrun.env.yaml
```

After first deploy, set `APP_URL` to the Cloud Run service URL:
```bash
gcloud run services update oxy \
  --region europe-west2 \
  --update-env-vars APP_URL=https://YOUR-SERVICE-URL.a.run.app
```

The MCP server should be deployed as a **separate Cloud Run service** if needed (not as a second process in the same container).

### Docker

```dockerfile
# Dockerfile is included. Build and run locally:
docker build -t oxy .
docker run -p 3000:3000 --env-file .env oxy
```

---

## 17. Known Issues & Audit Notes

The following issues were identified in a May 2025 audit. They are documented here for tracking; fixes are in progress.

### Critical

| ID | Location | Issue |
|----|----------|-------|
| CRIT-1 | `api/index.js:90`, `mcp-server.js:12` | `cors()` called with no config → wildcard `Access-Control-Allow-Origin: *` |
| CRIT-2 | Entire app | No Content-Security-Policy header; Babel standalone ships to production |
| CRIT-3 | `api/index.js:2398` | `GET /health` (public) returns names of missing env vars in response body |
| CRIT-4 | `auth.js:65`, `live.js:586` | Session tokens accepted in URL query string → visible in logs, history, Referer headers |
| CRIT-5 | `mcp-server.js:71` | Telegram messages sent with `parse_mode: "HTML"` but user content is unescaped → HTML injection |
| CRIT-6 | `mcp-server.js:173` | Home Assistant `action`, `domain`, `entity` come from user input with no allowlist → SSRF / privilege escalation |

### High

| ID | Location | Issue |
|----|----------|-------|
| HIGH-2 | `api/index.js:1851` | History search: `%` and `_` wildcards not escaped in ILIKE — can dump full history |
| HIGH-3 | `mcp-server.js:56–116` | Reminders in `reminders.json` are not scoped per user — any user can read/complete another's reminders |
| HIGH-5 | `api/index.js:629,697` | Gemini API key passed as URL query param instead of header → appears in server logs |
| HIGH-6 | `api/index.js:2367` | `/debug/:userId` exposes connector token presence and env var status to any authenticated user |

### Medium

| ID | Location | Issue |
|----|----------|-------|
| MED-1 | Global | No rate limiting on `/chat`, `/auth/login`, `/images/generate`, MCP Twilio endpoints |
| MED-2 | `runtime.js:28` | Supabase client created with placeholder URL/key when env vars missing → silent data loss |
| MED-3 | `api/index.js:2314` | Google OAuth `postMessage` sent to `'*'` instead of fixed origin |
| MED-4 | `mcp-server.js:127` | Hardcoded placeholder Twilio TwiML URL — `make_call` always fails in production |
| MED-7 | `sw.js:35` | `event.data.json()` not in try/catch → bad push payload silently kills service worker handler |
| MED-8 | `api/index.js:1367` | No maximum password length → very long passwords can block event loop via scrypt |

### Low

| ID | Location | Issue |
|----|----------|-------|
| LOW-2 | `index.html:12` | CDN scripts (React, Babel) loaded without SRI `integrity` hashes |
| LOW-6 | `connectors/telegram.js:149` | Full phone numbers of Telegram contacts returned in API responses and stored in conversation log |
| LOW-7 | `index.html` | Accessibility: icon-only buttons missing `aria-label`; nav elements missing `role="navigation"` and `aria-current` |
| LOW-9 | `live.js:611` | No WebSocket message size limit before `JSON.parse` |

---

*This document was generated from the live codebase on 2026-05-14 and reflects the state of the `main` branch at that time.*

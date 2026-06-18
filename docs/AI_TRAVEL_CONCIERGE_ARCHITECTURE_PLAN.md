# AI Travel Concierge Architecture Audit & Implementation Plan

## Current architecture audit

- **Frontend framework:** Native iOS app in `OxyApp/OxyApp`, built with SwiftUI views and service/view-model classes. There is no separate web frontend beyond Express-served support/legal/install pages.
- **Backend structure:** Node.js/Express app in `api/index.js`, booted by `server.js`, with connector adapters in `connectors/` and focused backend services in `api/services/`.
- **Database schema:** Supabase tables are managed by root SQL migration files. Core user data includes `users`, `conversations`, `memories`, `preferences`, `connectors`, `action_log`, `native_context`, and scheduled/proactive task tables. No new table is required for the first travel-concierge foundation; travel session state is stored in `preferences` under `travel.concierge.context`.
- **Authentication:** Local session auth lives in `auth.js`, with signed session tokens plus OAuth flows for Google, GitHub, Microsoft, Spotify, Linear, and Notion in `api/index.js`.
- **Existing AI functionality:** Gemini chat/voice generation is orchestrated in `api/index.js`; context assembly pulls memory, conversation history, native hints, connector availability, search grounding intent, recent action logs, and context-brain resolution.
- **API integrations:** Google/Gmail/Calendar/Maps, Telegram, GitHub, Microsoft, Spotify, Linear, Notion, Trainline/transport, Uber deep links, YouTube, Indeed, LinkedIn, Sentry, Supabase, and Gemini are present.
- **State management:** iOS uses SwiftUI observable state/view models. Backend state is persisted through Supabase `preferences`, `conversations`, `memories`, `connectors`, `action_log`, and `native_context`.
- **Deployment setup:** `Dockerfile`, `cloudrun.env.example.yaml`, `runtime.js`, and `README.md` indicate Cloud Run-style Node deployment with env-driven Gemini/Supabase/connector configuration.
- **Logging:** Structured JSON logging and optional Sentry are in `api/index.js`; chat tracing logs model calls, Supabase calls, search decisions, and now travel-concierge state.
- **File organization:** The backend is currently centralized in `api/index.js` with extracted service modules. This change follows that pattern by adding `api/services/travel-concierge.js` and smoke tests.

## Implementation plan

1. **Foundation now:** Add deterministic travel request detection, requirement extraction, follow-up question generation, and preference-backed session context without changing existing action execution.
2. **Chat integration now:** Inject a compact travel planning state block into the existing Gemini dynamic prompt so Oxy asks focused follow-ups and retains constraints across turns.
3. **API surface now:** Add a safe `/travel-concierge/parse` route for clients or future UI to preview/update travel requirements.
4. **Next backend step:** Add optional schema migration for first-class `travel_sessions` only if analytics, multi-trip switching, or audit history are needed; current preference storage avoids disruptive migration risk.
5. **Next AI step:** Replace simple deterministic extraction with model-assisted structured extraction behind the same service interface, gated by tests and strict JSON validation.
6. **Next integration step:** Map completed requirements into existing `get_directions`, `plan_trip`, `search_trains`, Maps, Calendar, and booking/review actions instead of creating duplicate travel actions.
7. **Risk TODOs:** Do not invent live travel prices/schedules/availability; require grounded connector/search results before presenting booking-sensitive facts.

## Manual verification

- Run `npm test` for all Node smoke tests.
- Exercise chat with: “Plan a weekend trip to Paris from Birmingham next Friday for 2 people under £600, direct if possible.”
- Confirm Oxy asks for missing details instead of inventing availability, and confirm existing Maps/Trainline/Uber behavior still works.

# Architecture

`server.js` is an HTTP/SSE boundary. `runtime.js` owns room state, device registry, ingestion, inference, watches, command records, and local conversations. `store.js` is a local SQLite store. `agent.js` is a provider-neutral adapter over Oxy's existing brain provider. `tools.js` defines read and write tools with permission and side-effect metadata; model-directed tool calls are read-only. `adapters.js` has a working simulator adapter and an explicit unconnected BOX-3 adapter. `voice-cli.js` is an opt-in laptop voice client.

The data path is device identity → authenticated HTTP message → canonical observation → durable event → observed signal → occupancy inference → watch → action decision. All records retain evidence IDs. The world model never writes an inference into the observations table.

This module deliberately does not create a second general digital action executor. Its watch actions are limited to local notification records and optional local speech. Device commands use a narrow safe allowlist; other commands require a reviewed action contract. Purchases, external messages, and potentially dangerous equipment remain behind Oxy's `action-execution.js` and durable approvals. Integration with the consumer iOS surface and server-side production user database remains work to do.

The runtime is a modular monolith. SSE streams local events to the console. SQLite transactions protect ingestion plus watch evaluation. Periodic `tick()` evaluates deadlines and device liveness. No queue or external event bus is needed yet.

The local SQLite file stores `users`, `rooms`, `devices`, `device_messages`, `observations`, `events`, `inferences`, `world_state`, `watches`, `actions`, `commands`, `conversations`, `memories`, `preferences`, and `replay_runs`. Each table holds an ID, creation time, and JSON record. This is local developer storage; it has no migration or sync path to Oxy's production Supabase database yet.

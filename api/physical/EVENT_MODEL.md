# Event model

Stored event records have `id`, `type`, `timestamp`, `evidenceIds`, and `payload`. Current event types are `ObservationReceived`, `StateChanged`, `InferenceCreated`, and `WatchTriggered`; connection, action, and command changes are emitted to the live SSE stream and stored in their own durable tables. Consumers use IDs and types rather than interpreting log strings.

`GET /v1/events` returns durable events. `GET /v1/stream` emits live JSON `{type, record}` over server-sent events. Live streams are not a durable queue; clients reconnect and fetch a snapshot.

Single-observation replay creates a new observation with `source.origin=replay`, original timestamp, `metadata.originalObservationId`, `metadata.originalSource`, and `metadata.replayedAt`. `POST /v1/replay/sequence` recomputes world state, inferences, and current active watches in a separate in-memory SQLite store; it persists the full replay-run result, including the replay observations needed to resolve evidence IDs. It is a counterfactual evaluation of today's watch rules, not a reconstruction of when those watches were historically created. Replay is development-only and does not overwrite live room state or execute physical actions. The sequence endpoint accepts up to 1,000 observation IDs.

# Device protocol v1

The prototype uses HTTP JSON because it is straightforward for ESP-IDF and the local Node runtime. Device traffic uses `Authorization: Bearer DEVICE_SECRET`; admin registration uses loopback access or `x-adam-admin-token`. Every device POST includes `protocolVersion: 1`, `messageId` (unique per device), and an ISO `timestamp` within five minutes of the server clock. Duplicate IDs are rejected. Device IDs are URL path components, not trusted body fields.

Admin endpoints: `POST /v1/users`, `POST /v1/rooms`, `POST /v1/devices/register`, `POST /v1/simulator/devices`, `POST /v1/watches`, `POST /v1/memories`, `POST /v1/chat`, `POST /v1/replay`, `POST /v1/replay/sequence`, `PUT /v1/preferences/:userId`, `GET /v1/users`, `GET /v1/preferences`, `GET /v1/snapshot`, `GET /v1/rooms/:id/state`, `GET /v1/memory/search?q=...`, and list endpoints for observations, events, watches, devices, actions, inferences, memories, conversations, and replay runs.

Device endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/devices/:id/heartbeat` | Keep connection state current and optionally report network state |
| POST | `/v1/devices/:id/capabilities` | Announce the actual firmware capability set |
| POST | `/v1/devices/:id/observations` | Submit a typed observation |
| GET | `/v1/devices/:id/commands` | Poll unexpired commands |
| POST | `/v1/devices/:id/commands/:commandId/ack` | Acknowledge or fail a command |

Admin command endpoint: `POST /v1/devices/:id/commands` with `{ "type": "display", "payload": { "text": "Hello" } }`. The type must be both an announced capability and one of `display`, `play_audio`, `volume`, `flash_led`, `request_reading`, `start_scan`, or `stop_scan`. Commands have ID, creation time, expiry, pending state, acknowledgement, failure, and timeout states. A real firmware transport has not been flashed or validated.

Example observation body: `{ "protocolVersion": 1, "messageId": "uuid", "timestamp": "2026-09-29T17:25:00Z", "type": "motion_detected", "value": true, "confidence": 0.8, "source": { "sensor": "motion" } }`. Origin, adapter, device ID, and room come from the authenticated registry, not this body. Registration returns the device record and a secret once; save it on the device securely.

For physical devices, the observation type must match an announced capability. For example, `motion_detected` requires `motion`, BLE appearance requires `BLE_scan`, and a custom observation requires a capability with the same name. Simulator devices can generate arbitrary development observations but remain marked untrusted.

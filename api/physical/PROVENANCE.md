# Provenance and trust

Each observation stores source device ID, adapter, origin, environment, and sensor, along with observation time, receive time, confidence, trust level, and metadata. The server assigns environment. Device ingress assigns origin, adapter, room, and device ID from the authenticated registry entry, rejecting conflicting claims. A simulator device can only be registered through the development endpoint and is always marked `simulator`.

Device observations also retain the protocol version and message ID in bounded transport metadata. The protocol does not store continuous raw streams or full audio payloads.

An inference has evidence IDs and a distinct `kind=inference`. World-state rows point to the same evidence. Triggered watches and action records retain those IDs. `GET /v1/observations`, `/v1/inferences`, `/v1/watches`, and `/v1/actions` allow a developer to follow the chain.

In production mode, simulated and replayed observations are rejected. In development, actions based on either are recorded with `status=simulated` and do not produce sound or external notification. Device secrets are returned once at registration and only SHA-256 hashes are stored. The prototype LAN protocol needs TLS termination and per-device secret rotation before use across untrusted networks.

Microphone devices report `recordingState` in heartbeat messages (`off`, `active`, or `unknown`). The default is `unknown`; the console does not silently imply that a microphone is off. Continuous raw audio is not accepted or stored by this protocol.

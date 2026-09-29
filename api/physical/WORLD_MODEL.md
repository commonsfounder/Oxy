# World model

Rooms are independent records. A device belongs to at most one room. An observation is an immutable fact about what a source reported; room state is a current projection. Known signal keys include motion, BLE presence, sound, door, device, appliance, and temperature. Each state row carries confidence, observed time, expiry, and evidence IDs. Reads turn expired rows into `unknown` without inventing a new observation.

Occupancy is a separate inference from fresh motion, occupancy, and BLE signals. Supporting and contradicting evidence IDs are kept. Opposing signals can produce `unknown`. A single strong signal yields at most 0.6 confidence; additional independent signals can raise it. This is a conservative prototype rule, not a validated occupancy model. Unknown is the only result when support has expired. A later sensor-fusion policy can replace the inference function without changing ingestion or watches.

Watches use structured conditions: `observation_type`, `state_equals`, `state_transition`, and `deadline_state`. A transition watch records its last evaluated state and links both sides of a change. Watches are durable and fire once. Each trigger links to evidence and a stored action decision. Expired and cancelled watches do not fire. The scheduler checks once per second while the server runs; a delayed restart evaluates due watches when the server starts ticking.

Per-user local preferences can suppress proactive actions during quiet hours, below a confidence threshold, or inside a cooldown. Speech can be disabled. These are deterministic checks after a watch triggers; the action record states the suppression reason.

Durable memories have separate `user`, `environmental`, and `episodic` kinds, scope, source, timestamp, and confidence. Simulated evidence cannot become durable memory. Operational state remains in `world_state`; conversations remain in `conversations`. Retrieval is a bounded keyword search for now.

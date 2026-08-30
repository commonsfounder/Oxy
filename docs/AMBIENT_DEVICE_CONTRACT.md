# Adam ambient-device contract

This is the current boundary between Adam's reusable agent runtime and a physical or
commodity device. It is intentionally small enough to prove in a real home before custom
hardware exists.

## Canonical path today

```text
Adam runtime
  -> bounded display event
  -> authenticated paired browser
  -> text render, or explicit browser voice mode
  -> acknowledgement
```

The existing paired-display service is the first ambient-output adapter. A browser on a phone,
tablet, laptop, Raspberry Pi, or other speaker-equipped computer can act as the commodity
device. It polls `/display/:id/events` with its pairing token, renders the event, and acknowledges
it. The event is short-lived and text-only at the server boundary. The browser may opt into local
speech with `/display?mode=voice`; text mode remains the default.

Pairing is explicit and revocable:

1. A signed-in app creates a one-time pairing challenge at
   `POST /agent/displays/pairing`.
2. The nearby browser redeems the challenge and code at `POST /display/pair`.
3. The browser receives a bearer token once, stores it locally, and polls/acknowledges only its
   own event stream.
4. The user can forget the device from the app. Expired events and pairing material are retained
   only for their bounded lifetimes.

Proactive household notifications do not route to a display merely because it is paired. A
display render still needs an explicit request, and any future ambient-notification channel must
be an explicit user preference with a clear privacy scope. Pairing is device authority, not
consent to speak private household state aloud.

## Event contract

The server sends only:

```json
{
  "id": "event id",
  "kind": "agent_update | reminder | approval | status",
  "title": "short heading",
  "body": "bounded plain text",
  "createdAt": "timestamp",
  "expiresAt": "timestamp"
}
```

The event must not contain credentials, raw tool payloads, cookies, internal provider responses,
or a hidden instruction for the device. A device must render the supplied title/body as data,
never as HTML or executable code, and must acknowledge only after it has received the event.

Native and commodity integrations may submit an `events` array alongside `/native/context`. Adam
normalizes at most 12 observations from the allowed event vocabulary, evaluates them through the
same intervention policy, and retains no raw sensor payload in `native_context`. The durable
notification row is the record of a surfaced event; repeated observations should keep a stable
event `id` so delivery deduplication can work. An observation is not permission to perform a
physical action: any action still goes through its normal capability contract and authority gate.

Example observation:

```json
{
  "events": [{
    "id": "hallway-door-2026-08-30T12:00:00Z",
    "type": "person_near_door",
    "title": "Tom is near the door",
    "body": "Tom may be leaving soon.",
    "personName": "Tom",
    "confidence": 0.91,
    "relevance": 0.9,
    "actionable": true,
    "interruptionCost": "low",
    "occurredAt": "2026-08-30T12:00:00Z",
    "expiresAt": "2026-08-30T12:05:00Z"
  }]
}
```

## Input and custom-hardware boundary

The phone remains the canonical owner of account authentication, permissions, and speech
recognition while the input device is experimental. `OxyPendantFirmware/` describes a BLE
Nordic UART control-command prototype (`START_RECORDING`, `STOP_RECORDING`, and related commands)
where the iPhone records and transcribes. `firmware/` describes a different continuous PCM-over-
BLE experiment. They are not interchangeable implementations of one protocol.

No custom microphone, radio, touch, battery, enclosure, or PCB contract is frozen yet. A new
device must first prove the same user-visible behaviours through the authenticated phone and
commodity output path. Only then should the device adapter be fixed around measured needs.

## Hardware readiness gates

Custom hardware is ready to enter build, rather than just discussion, only when all of these are
measured or decided:

- one canonical input transport and message vocabulary;
- pairing, revocation, reconnect, and offline behaviour;
- microphone/audio ownership and measured end-to-end latency;
- battery capacity, charging, thermal, and standby measurements;
- physical controls and accessibility behaviour;
- enclosure, BOM, schematic, antenna, and manufacturing tolerances;
- firmware update and recovery path;
- privacy behaviour for local audio and spoken household content;
- a repeatable household behaviour and one repeatable fun behaviour used by real people for a
  month, with evidence that removing Adam is noticed.

Until those gates are met, hardware work should be limited to commodity-device validation and
interface tests. The server/runtime, not the enclosure, owns the goal, context, authority, and
verification lifecycle.

The reusable event boundary behind this output is `api/services/household-events.js`. It
normalizes observations into a small allowed event vocabulary and makes the deterministic
surface/quiet decision from confidence, relevance, actionability, urgency, interruption cost,
and cooldown. Both context watches and native event observations use this seam before entering
notification delivery; future sensors and devices should do the same instead of creating their
own proactive policy.

# Proactive "Signals" — a ranked, acting feed

**Date:** 2026-06-24
**Status:** Approved design, pre-implementation

## Problem

The Today tab's proactive layer is a status readout: weather card, inbox card, and one
stitched-together prose paragraph (`buildIntervalBriefing`). The model already receives
calendar, email, location, health, reminders, **memory, history, and preferences** — then
collapses all of it into ~70 words of recap. The intelligence is present but wasted: it
summarizes instead of *judging*, and it never *does* anything.

## Goal

Turn the briefing from a paragraph into a **ranked feed of what actually needs the user
today**, where each item can carry an action — and the safe, reversible actions execute
**unattended** during the background sweep, shown as undoable receipts.

This single slice moves three of the four product gaps at once:
- **Smarter** — ranking the few things that matter *is* the judgement.
- **Agency** — items execute or offer one-tap execution, not just drafts.
- **Knows me** — driven by the memory/preferences already in the prompt.

## Non-goals

- **More sources** (Slack/WhatsApp/news/finance/packages). Separate, expensive pillar; layered on later atop this structure.
- **Auto-sending to people, booking, paying, deleting.** These are the *sensitive* tier — never unattended (see Tiers).
- New DB tables/migrations. Signals ride in existing `briefings.metadata` jsonb.

## Model output

`buildIntervalBriefing` stops returning prose and returns JSON:

```json
{
  "lead": "One warm sentence framing the day. May be empty.",
  "signals": [
    {
      "title": "Leave by 8:40 for the dentist",
      "detail": "20-min drive, rain expected — give it a buffer.",
      "action": { "type": "create_reminder",
                  "params": { "title": "Leave for the dentist", "due_date": "2026-06-24T08:40:00+01:00" } }
    },
    {
      "title": "Sarah's still waiting on the deck",
      "detail": "Her email from yesterday hasn't been answered.",
      "action": { "type": "send_email",
                  "params": { "to": "sarah@…", "subject": "Re: deck", "intent": "draft a short reply confirming Friday" } }
    }
  ]
}
```

- Ranked by importance, **max 4** signals.
- `action` is optional; a signal can be pure information.
- The model proposes `type` + `params` from the existing action set. It does **not** decide
  the tier — the server does (see Tiers). The model is told which action types exist and to
  only propose well-grounded ones.

### Parsing / fallback

Strip ```` ```json ```` fences, extract the first balanced `{…}`, `JSON.parse`. On any
failure: treat the raw text as `lead`, `signals: []` — i.e. exactly today's behaviour. The
`NOTHING` escape still applies (empty `lead` **and** empty `signals` ⇒ skip, as now).
`lead` stays written to `briefings.body` for backward-compat and the chat "Ask about this".

## Tiers (server-authoritative)

Tier is decided by a **server-side allowlist keyed on `action.type`**, never by the model.

| Tier | Action types | Behaviour |
|---|---|---|
| **Safe** (reversible, private, server-executable) | `create_reminder` (→ scheduled task), `create_calendar_event` **with no attendees** | Auto-execute during the sweep. Idempotent. Receipt with Undo. |
| **Sensitive** (irreversible / outward-facing) | `send_email`, `send_message`, `send_telegram`, `book_uber`, anything paying/booking/deleting, `create_calendar_event` **with attendees** | Never unattended. Rendered as a one-tap confirm chip → existing execute path. |
| **Unknown** | anything not in the safe allowlist | Treated as **sensitive** (fail safe). |

Tier also respects existing settings: if `settings.autonomy ∈ {Quiet, Low}` (already short-
circuits briefings) nothing auto-runs; safe-tier auto-execution only happens at Balanced+.

## Execution model

Auto-execution happens **inside the sweep**, in `maybeCreateIntervalBriefing`, after the
signals are generated and **before** the briefing row is written, so the stored signal
carries its result.

- **Idempotency:** each safe action gets a stable `sig = sha256(type + canonical(params))`,
  truncated. Executed sigs are stored on the briefing (`metadata.executed: [sig…]`). Re-runs
  of the sweep (the card refreshes in place every ≤110 min) skip already-executed sigs. A
  regenerated briefing carries forward the prior `executed` set.
- **Validation:** the existing action handler already validates params (`create_reminder`
  rejects missing title/date). A safe action that fails validation degrades to an
  informational signal (no receipt, no chip) — never a silent error.
- **Result on the signal:** after execution each signal gains
  `status: "done" | "pending" | "info"`, and for `done` a `receipt` (the handler's
  `actionSummary`/`text`) plus `undo` (`{ type, params }`) when a cancel action exists.

### Undo

- `create_reminder` → `cancel_scheduled_task` with the created id. Undo button runs it.
- `create_calendar_event` → no delete action exists today. Undo button is **omitted**; the
  receipt instead deep-links to the Calendar app to manage. (Adding `delete_calendar_event`
  is out of scope; note for a follow-up.)

## Storage

`briefings.metadata` (jsonb, no migration) gains:

```json
{ "window": "...", "date": "...", "emails": [...],
  "lead": "…",
  "signals": [ { "title", "detail", "status", "receipt?", "action?", "undo?" } ],
  "executed": ["sig…"] }
```

## App changes (Swift)

- **Models** (`Models/Message.swift`): `BriefingMetadata` gains `lead: String?` and
  `signals: [BriefingSignal]?`. New `BriefingSignal` (title, detail, status, receipt,
  action label/prompt for sensitive chips, undo descriptor). All optional/`decodeIfPresent`
  so old rows decode.
- **New `SignalsCard`** (in `ProactiveView`), rendered at the **top** of the dashboard:
  - `lead` sentence as the card's opening line.
  - Each signal: title (ink) + detail (muted), then:
    - `done` → quiet receipt line (✓ + receipt text) with an **Undo** button when present.
    - `pending` (sensitive) → a **one-tap confirm** button; tapping routes through the
      existing execute path (reuse `ActionReviewSheet` for high-risk confirmation, or direct
      command for low-risk) — **no new execution machinery in the app.**
    - `info` → no button.
- **Fallback:** when a briefing has no `signals`, render today's `briefingCard` prose
  (driven by `body`) exactly as now. The standalone `briefingCard` is hidden when signals
  exist (the lead subsumes it).
- Weather / agenda / inbox / reminders cards are **unchanged** — they remain the live glance
  layer beneath Signals.

## Backend changes (api/index.js)

1. `buildIntervalBriefing` — replace the prose system prompt with the JSON-emitting prompt;
   return the parsed `{ lead, signals }` (with the defensive fallback) instead of a string.
2. New `classifySignalTier(type, params)` — the allowlist above.
3. New `executeSafeSignals(userId, signals, prior)` — runs safe-tier actions idempotently,
   annotates each signal with `status/receipt/undo`, returns `{ signals, executed }`.
4. `maybeCreateIntervalBriefing` — call the executor before persisting; write
   `lead/signals/executed` into `metadata`; keep `body = lead` for compat. The change-
   detection fingerprint is unchanged (still calendar/email/place/reminders).

## Failure handling

- Model JSON unparseable → prose fallback (above).
- Grounded call fails → existing ungrounded retry in `generateGroundedBriefing` (now also
  asked for JSON).
- Safe action throws/validation-fails → signal degrades to `info`; sweep continues; logged.
- Sensitive action never runs server-side, so no unattended outward-facing risk exists by
  construction.

## Testing

- **Unit (backend, node):** `classifySignalTier` allowlist (safe vs sensitive vs unknown→sensitive,
  calendar-with-attendees→sensitive); the JSON parser (fenced, trailing prose, garbage→fallback);
  `executeSafeSignals` idempotency (same sig twice ⇒ one execution) with a stubbed `executeAction`.
  Lives in `test/` next to `context-brain.test.js`.
- **Manual:** trigger a sweep for a test user with a calendar event + an unanswered email;
  confirm a reminder auto-creates once (and only once on re-sweep), the email becomes a
  pending confirm chip, and Undo cancels the reminder.

## Open follow-ups (not this slice)

- `delete_calendar_event` action to enable calendar Undo.
- Additional sources (the breadth pillar).
- Letting the sensitive tier graduate to unattended under an explicit higher-autonomy opt-in.

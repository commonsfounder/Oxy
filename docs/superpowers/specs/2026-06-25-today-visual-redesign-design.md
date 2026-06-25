# Today: visually-rich redesign — living hero + composable card board

**Date:** 2026-06-25
**Status:** Design approved, ready for implementation plan
**Supersedes the Today layout in:** `OxyApp/OxyApp/Views/Proactive/ProactiveView.swift`

## Problem

Today is a flat stack of seven text cards (signals / weather / agenda / inbox /
activity / reminders / briefing). User feedback: "ridiculously ugly, just dumb
useless info." Two real faults underneath the look:

1. The "What matters" / briefing cards are AI-narrated filler — when there's no
   real time-sensitive signal, the model restates standing Memory goals
   (protein target, study subject) and freezes a stale morning weather claim
   (the "39°C furnace" vs the live 23° widget). See the briefing-quality notes
   in `api/index.js` (`buildIntervalBriefing`, `maybeCreateIntervalBriefing`).
2. It looks like a dashboard, which fights the product's de-gadgeted,
   feminine-leaning "Silent Luxury" language.

## Decision

Replace the card stack with **a living weather hero + a board of concrete,
real-data cards the user composes themselves.** No AI editorializing about what
matters — show real things (mail, packages, calendar, reminders) and let the
user pick which cards show and in what order.

Richness comes from **imagery, type scale, motion, and monochrome data-viz** —
never hue. Hue stays reserved for status dots, per `NamelessTheme.swift`.

## Components

### 1. Living weather hero (LOCKED)

A full-bleed atmospheric band (~248pt) at the top of Today, replacing the
current `hero` + separate `weatherCard`.

- **Sky reacts to real conditions + time of day.** Night → dark gradient with
  moon + stars (as mocked). Also needed: dawn wash, clear-day brightness,
  overcast grey, rain. Driven by `OxyWeatherService` snapshot (condition) and
  the clock (`TodayFinish` already splits day/night).
- Greeting (Fraunces serif) + date overlay top-left; large serif temperature +
  "condition · feels X°" bottom-left.
- **Tappable to expand** into richer detail not already on the face — hourly
  curve, H/L, precipitation chance, sunset, air quality — whatever the weather
  service actually has. Reuses the existing `weatherExpanded` state; expansion
  is a sheet or in-place reveal. Only show fields that have real data.
- This hero is the single source of weather truth — kills the briefing's stale
  baked-in weather prose by removing that prose entirely (see §4).

### 2. Composable card board

Below the hero: an ordered, user-toggled list of cards drawn from a fixed v1
library. Drag to reorder, toggle which show. A dashed **"Add a card"** tile at
the bottom opens the library picker.

**v1 library (all real data, all already on-device except Incoming):**

| Card | Content | Data source |
|------|---------|-------------|
| **Inbox** | Primary-inbox threads: sender monogram + subject preview, tap → thread | `briefings` metadata `emails` (already gathered by `gatherProactiveContext`, Gmail Primary) |
| **Incoming** | Deliveries / orders / reservations with progress + ETA | **NEW** — parsed from order/shipping/booking emails (see §3) |
| **Agenda** | Calendar time-rail with now-marker | existing `events` (`TodayEvent`) |
| **Reminders / errands** | Reminders + location-aware errands | existing `reminders` (native sync) |

**Removed:** the `signalsCard` ("What matters"), the prose `briefingCard`, and
the standalone `activityCard`. The AI-narration cards are the thing the user
explicitly rejected.

### 3. Incoming card + parser (the only new backend)

Parse the user's mail for shipments, orders, and reservations and surface them
as structured items: `{ title, vendor, status, eta, progressStage }`.

- Reuse the email fetch already in `gatherProactiveContext` (Gmail Primary,
  `get_emails`). Add a classifier/extractor pass (LLM via the helper model, or
  heuristic on known sender/subject patterns — decide in the plan; lean
  heuristic-first, LLM only if heuristics miss).
- Progress stage for deliveries: ordered → shipped → out for delivery →
  delivered, rendered as a 4-segment monochrome bar.
- Reservations: title + datetime + confirmed state, no progress bar.
- ponytail: start with carriers/vendors that send structured confirmations
  (Amazon, common couriers, OpenTable/Resy). Broaden coverage only if it's thin
  in practice.

### 4. Briefing pipeline cleanup (paired backend change)

With the narration cards gone, the proactive briefing no longer drives Today's
body. Two cleanups so the old pipeline doesn't keep generating unused filler:

- Stop generating prose weather claims (the hero owns weather).
- Either retire `buildIntervalBriefing`'s signal generation for Today, or
  tighten it to feed only the data cards. Exact scope decided in the plan — the
  design intent is: **no AI "what matters" text surfaces on Today.**

## State & persistence

Card visibility + order is **client-only UI state** — store in `@AppStorage`
(UserDefaults) on device, e.g. `today_card_order: [String]` and
`today_cards_hidden: Set<String>`. No backend, no migration. A card with no data
right now collapses to nothing (same rule the current agenda card uses) rather
than showing an empty box.

## Non-goals (v1)

- **Full custom-card builder** (define your own card from a source + filter +
  layout). Deferred — `@AppStorage` toggle+reorder of the fixed library covers
  ~90% of "make it yours" at a fraction of the build.
- Any new hue / color system. Monochrome holds.
- Push/APNs changes (still blocked on the Apple Developer account; out of scope).

## Risks / open questions

- **Incoming coverage**: email parsing is fuzzy; a thin or wrong Incoming card
  is worse than none. Heuristic-first, and the card hides when empty.
- **Hero condition art**: needs a small set of sky treatments (night/dawn/
  clear/overcast/rain). Scope the set in the plan; don't gold-plate.
- **Drag-reorder polish** on iOS: use the native reorder affordance; don't
  hand-roll gestures.

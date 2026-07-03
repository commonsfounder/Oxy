# DESIGN.md — Milgrain app

**Register:** product
**Last captured:** 2026-07-03 (post-QA rebuild)
**Supersedes:** the pure-black "editorial minimalism" direction and the earlier teal
"warm companion" palette. Both are scrapped. The July 3 on-device QA found the
editorial language unreadable and unusable (black-on-black surfaces, Didot prose,
light-weight dim text, invisible navigation); do not reintroduce it.

## Principles

1. **Legibility beats mood.** No text below 72% white on the canvas. No default
   font weight below `.regular`. If a treatment looks "quiet" in a screenshot but
   can't be read on a phone in daylight, it's wrong.
2. **Surfaces are real.** Cards visibly lift off the canvas. Information lives in
   containers the eye can find. Hairlines separate; they do not carry structure alone.
3. **One warm accent.** The brand gold carries selection, CTAs, times, and the
   assistant's presence. Semantics (green/amber/red) are reserved for state.
4. **System type.** SF everywhere — rounded for display, regular for body, mono for
   readouts. The serif exists only inside the wordmark image asset.
5. **Dark-only.** Every token is a fixed dark value and the root pins
   `.preferredColorScheme(.dark)`. Never let system chrome follow iOS light mode —
   it renders a light glass tab bar/keyboard over the dark canvas (July QA bug).

## Palette (`app*` tokens in AppTheme.swift)

- **Canvas:** `appBackground` #0D0E12 — soft charcoal, not void black.
- **Card surface:** `appSurface` #17191F; **raised:** `appSurface2` #1F222A.
- **Hairline:** `appHairline` white 10%.
- **Text:** `appInk` #F4F5F7; `appMuted` white 72% (floor — see Principle 1).
- **Accent:** `appAccent` #E3B35B (Milgrain monogram gold); `appOnAccent` near-black.
- **Semantics:** `appSuccess` green, `appWarning`/`appAttention` amber, `appDanger`
  coral, `appLive` bright green.
- The legacy `oxy*` and `mg*` (settings-family) tokens are aliases into the tokens
  above — do not give them independent values again.

## Typography (`Font.app*`)

- **Display** `appDisplay(size)` — SF rounded semibold. Greetings, card titles,
  metric figures, screen headers.
- **Body** `appBody(size)` — SF regular (default weight `.regular`; pass heavier
  weights explicitly, never lighter).
- **Mono** `appMono(size)` — technical readouts only (battery, latency, IDs).
- Dynamic Type stays on everywhere.

## Components

- **TodayCard** — the standard container: `appSurface` fill, 16pt continuous
  radius, 0.5pt white-6% border. Today board sections, pending action cards.
- **Card headers** — SF Symbol in accent + `appDisplay(16)` title.
- **Chat bubbles** — user: accent 18% tint; assistant: `appFillSubtle` (white 8%)
  with a 3pt accent voice bar. Assistant prose renders markdown; links are
  underlined and tappable; all message text is selectable.
- **Buttons** — primary: accent capsule with `appOnAccent` text. Secondary: plain
  text in `appMuted`. Destructive: `mgDestructive`.
- **Toggles** — accent fill when on.
- **Tab bar** — standard `TabView` with system glass, tinted accent. No custom
  pills, no hide-on-scroll dependencies for reachability.

## Today board

Cards must surface information, not murmur prose: event rows show accent times,
Wellbeing shows figures (steps / sleep / resting HR) with captions, Reminders show
tappable circles and due times, empty states are one readable line plus a real
button when there's an action to take (e.g. Connect Health). Server-generated
narrative copy ("Tonight") only renders when written today and less than 6 hours
old — stale briefings must not survive into the wrong time of day.

## Motion & haptics

Ease-out only (`appFast` 0.15 / `appStandard` 0.22 / `appRelax` 0.4 / `appSpring`
0.28). Entrance staggers run once per screen visit, not on every tab switch.
Haptics on selection and light impacts on row taps, as today.

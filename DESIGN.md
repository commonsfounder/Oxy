# DESIGN.md — Adam app

**Register:** product
**Last captured:** 2026-08-28 (light-paper palette + Fraunces display axes)
**Supersedes:** the pure-black "editorial minimalism" direction and the earlier teal
"warm companion" palette. Both are scrapped. The July 3 on-device QA found the
editorial language unreadable and unusable (black-on-black surfaces, Didot prose,
light-weight dim text, invisible navigation); do not reintroduce those specific
mistakes. July 4 walked back one part of the July 3 rebuild: giving assistant
replies a filled bubble made chat read like a generic chatbot widget. Assistant
text is plain on the canvas again, but keeps the July 3 legibility fixes
(regular-weight SF, `appInk`, no dim text) — the earlier failure was the weight/
color/contrast, not the absence of a bubble.

## Principles

1. **Legibility beats mood.** Body text sits at `appMuted` or darker on the paper
   canvas — never lighter. No default font weight below `.regular`. Any fill that
   carries text must clear 4.5:1 against it. If a treatment looks "quiet" in a
   screenshot but can't be read on a phone in daylight, it's wrong.
2. **Surfaces are real.** Cards visibly lift off the canvas. Information lives in
   containers the eye can find. Hairlines separate; they do not carry structure alone.
3. **One warm accent.** The brand gold carries selection, CTAs, times, and the
   assistant's presence. Semantics (green/amber/red) are reserved for state.
4. **SF for interface, Fraunces for voice.** SF carries body, labels and readouts.
   The Fraunces serif carries the display moments — the Home greeting, the Chat
   greeting — and nothing else. It is a voice, not a body face.
5. **Light-only.** The root pins `.preferredColorScheme(.light)` and the palette is
   warm paper. Tokens are declared via `appDynamicColor(dark:light:)`, so the `dark:`
   branch exists but never renders today; keep it correct rather than deleting it.

## Palette (`app*` tokens in AppTheme.swift)

Values below are the rendered light branch.

- **Canvas:** `appBackground` #F6F3EE — warm paper, not white.
- **Card surface:** `appSurface` #FCFAF6; **inset:** `appSurface2` #EAE4DB — sand.
- **Hairline:** `appHairline` ink 10%.
- **Text:** `appInk` #25221E deep umber; `appMuted` #6B6459 warm secondary.
- **Accent:** `appAccent` #936825 antique gold. Its foreground is `appOnAccent`,
  which is **dynamic**: near-white on the light-mode gold (4.96:1), near-black on the
  dark-mode gold (7.81:1). One fixed foreground cannot serve both — the two accents
  sit on opposite sides of mid-luminance.
- **Semantics:** `appSuccess` green, `appWarning`/`appAttention` amber, `appDanger`
  coral, `appLive` bright green.
- The legacy `oxy*` and `mg*` (settings-family) tokens are aliases into the tokens
  above — do not give them independent values again.

## Typography (`Font.app*`)

- **Editorial** `appEditorial(size, weight:soft:wonk:)` — Fraunces, display only.
  Fraunces ships as a **variable** font whose default instance is `opsz 9 / wght 900`,
  so a bare `.custom("Fraunces", size:)` resolves to Fraunces-9ptBlack — a heavy
  caption cut scaled up, which is why it went unused for months. The helper drives
  `opsz`/`wght`/`SOFT`/`WONK` and tracks optical size to point size. Never bypass it.
- **Display** `appDisplay(size)` — SF semibold. Card titles, metric figures, headers.
- **Body** `appBody(size)` — SF regular (default weight `.regular`; pass heavier
  weights explicitly, never lighter).
- **Mono** `appMono(size)` — technical readouts only (battery, latency, IDs).
- Dynamic Type stays on everywhere, including the Fraunces helper.

## Components

- **TodayCard** — the standard container: `appSurface` fill, 16pt continuous
  radius, 0.5pt white-6% border. Today board sections, pending action cards.
- **Card headers** — `AppIcon` in accent + `appDisplay(16)` title. SF Symbols are
  banned app-wide; `Image(systemName:)` must never appear. Glyphs are bundled
  template assets under `Assets.xcassets/ic-*`, resolved through `AppIcon`.
- **Chat messages** — user: compact rounded bubble, accent 18% tint, right-aligned.
  Assistant: plain text directly on the canvas, no fill, no accent bar, full-width,
  left-aligned — reads as a reply, not a chat-widget echo. Assistant prose renders
  markdown (with a plain-text fallback so `*`/`#` never leak on a parse miss);
  links are underlined and tappable; all message text is selectable.
- **Tool/action receipts** — one-line hairline row (status glyph + Title Case
  summary + optional detail + Open), not a boxed card. A pending action awaiting
  confirmation is the one exception and keeps a bordered `TodayCard` surface,
  since it's a decision, not a receipt.
- **Network error banner** — quiet recovery state: muted icon + message in
  `appMuted` inside a bordered `appSurface` pill, accent-colored Retry, no red text.
- **Buttons** — primary: accent capsule with `appOnAccent` text. Secondary: plain
  text in `appMuted`. Destructive: `mgDestructive`.
- **Toggles** — accent fill when on.
- **Home masthead** — a 1pt accent rule with the `TODAY` eyebrow and the date sitting
  directly beneath it, then the Fraunces greeting. The rule sits *above* the row so
  the block reads as a printed dateline rather than a floating eyebrow.
- **Navigation** — there is no tab bar. Home is the sole root screen; Chat is reached
  from the composer or a right-edge swipe, and More from the profile avatar.

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

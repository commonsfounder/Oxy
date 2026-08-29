# DESIGN.md — Milgrain app

**Register:** product
**Last captured:** 2026-08-29 (design system re-enforced)
**Supersedes:** the pure-black "editorial minimalism" direction and the earlier teal
"warm companion" palette. Both are scrapped. The July 3 on-device QA found the
editorial language unreadable and unusable (black-on-black surfaces, Didot prose,
light-weight dim text, invisible navigation); do not reintroduce those specific
mistakes. July 4 walked back one part of the July 3 rebuild: giving assistant
replies a filled bubble made chat read like a generic chatbot widget. Assistant
text is plain on the canvas again, but keeps the July 3 legibility fixes
(regular-weight SF, `appInk`, no dim text) — the earlier failure was the weight/
color/contrast, not the absence of a bubble.

The August 29 pass changed no direction — it made the screens obey the one already
written here. The system had drifted: 26 distinct type sizes (five of them
half-point), ten `appSurface.opacity(…)` fills, six widths for the same hairline,
around twenty ad-hoc ink opacities (several under the legibility floor below), and a
black-capsule primary button that all but vanished on the dark canvas. The tokens
below are now the only source of those values, and
`test/smoke/ios-design-system.test.js` fails the build if a screen goes around them.

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
5. **Two finishes, one scheme at a time.** Every token is a dynamic colour with a
   dark and a light value, and the root pins one of them
   (`OxyApp.swift` currently pins `.light`). Both have to be right: a fixed
   `Color.white` / `Color.black` is a colour that works in one finish and breaks the
   other, and that is what the black-capsule primary and the 40%-white secondary
   capsules were. Never let system chrome follow the *other* scheme — a light glass
   tab bar over a dark canvas was the July QA bug.

## Palette (`app*` tokens in AppTheme.swift)

Each is `appDynamicColor(dark:light:)`; the dark values are given below.

- **Canvas:** `appBackground` #0C0B0B — soft charcoal, not void black.
- **Card surface:** `appSurface` #151413; **raised:** `appSurface2` #1E1C1A.
- **Hairline:** `appHairline` ink at 10%.
- **Text:** `appInk` #F2EEE7; `appMuted` #A7A19A (floor — see Principle 1; 7.6:1 on the
  canvas). Secondary copy is `appMuted`, never faded ink.
- **Non-text quiet:** `appFaint` — rules, inactive glyphs, disabled chrome,
  placeholder shapes. It does not carry text, at any size.
- **Accent:** `appAccent` #C8A96B (Milgrain monogram gold), #93681F on the light
  finish. `appOnAccent` is the label paired with it and follows the finish —
  near-black on the dark gold, white on the light one; a single fixed value scores
  3.5:1 on one of the two.
- **Semantics:** `appSuccess` green, `appWarning`/`appAttention` amber, `appDanger`
  coral, `appLive` bright green.
- The legacy `oxy*` and `mg*` (settings-family) tokens are aliases into the tokens
  above — do not give them independent values again.

## Typography (`Font.app*` at an `AppText` step)

- **Display** `appDisplay(step)` — SF semibold. Greetings, card titles, metric
  figures, screen headers.
- **Body** `appBody(step)` — SF regular (default weight `.regular`; pass heavier
  weights explicitly, never lighter).
- **Mono** `appMono(step)` — technical readouts only (battery, latency, IDs).
- Dynamic Type stays on everywhere.
- SF only. The bundled serif is not used in the interface; the one serif in the
  product lives inside the wordmark image asset.

**The scale is eight steps and nothing between them** (`AppText`):

| Step | pt | Carries |
|------|----|---------|
| `micro` | 11 | Eyebrows, tracked micro-labels. Never a sentence. |
| `caption` | 12 | Timestamps, metric captions, chips. |
| `footnote` | 13 | The secondary line under a title. |
| `body` | 15 | The default: copy, rows, fields, buttons. |
| `callout` | 17 | Row titles, emphasis inside a card. |
| `title` | 20 | Card and section titles. |
| `display` | 28 | Screen headers, money and metric figures. |
| `hero` | 40 | The home greeting, and nothing else. |

## Geometry

- **Spacing** (`AppSpacing`) — a 4pt grid; 1 and 2 are allowed as optical nudges,
  everything above 3 is even.
- **Radius** (`AppRadius`) — `sm` 8, `md` 12, `lg`/`card` 16, `bubble` 18, `xl` 22.
  Nest with `AppRadius.inner(outer, inset:)` so a shape inside a shape stays
  concentric rather than drifting a point off.
- **Borders** (`AppBorder`) — `hairline` 0.5 and `strong` 1. Two widths, not six.
  A `StrokeStyle` drawing artwork (a dashed route, a progress ring) picks its own.

## Elevation

`AppElevation` has three levels and every fill is opaque:

- `.flat` — in the canvas: hairline only, no fill.
- `.raised` — a card on the canvas (`appSurface`).
- `.floating` — above a card: popovers, focused fields, chips (`appSurface2`).

`AppSurfaceBackground` draws it, `.appPlate(_:radius:)` applies it, and `AppCard` /
`TodayCard` / `MissionGlassPlate` are all the same surface under their own names.
Nothing hand-rolls a background + strokeBorder + shadow triple.

## Components

- **TodayCard** — the standard container, and one of three names for the single
  surface described under Elevation: `appSurface` fill, `AppRadius.card` continuous
  radius, `AppBorder.hairline` border. Today board sections, pending action cards.
- **Card headers** — accent `AppIcon` glyph + `appDisplay(AppText.callout)` title.
  (There are no SF Symbols anywhere — see AGENTS.md rule 7.)
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
- **Buttons** — primary: accent capsule with `appOnAccent` text, everywhere,
  including the home composer's send button and every mission CTA. Secondary:
  a hairline capsule outline with `appMuted` text. Destructive: `mgDestructive`.
  There is no second primary style — a white/`appInk` slab is not one.
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

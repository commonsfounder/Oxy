# DESIGN.md — Adam

**Register:** product

**Direction established:** 2026-09-02

**Supersedes:** the warm-paper, gold and editorial-newspaper direction.

Adam is a household companion and control surface for a general-purpose personal worker. The interface should feel like a small, beautifully made piece of domestic technology: calm at rest, unmistakably alive when doing something, and direct whenever the user must decide.

## Identity

The Adam mark is architectural: a graphite frame with three electric-blue channels. It defines the product language.

- **Graphite is structure.** Navigation, typography and durable controls use deep blue-black ink.
- **Blue is energy.** Reserve it for activity, selection, live context and the next useful action.
- **White space is functional.** The mark's negative space becomes the layout's breathing room. Do not fill every gap with a card.
- Render the mark from deterministic vector geometry (`AdamMark`), not a loosely matched icon or generated bitmap.

The wordmark uses compact, tracked sans-serif capitals. Fraunces is no longer part of the core interface voice.

Use the logo once per screen at most. It is an identity anchor, never a watermark,
empty-state glyph, card ornament or repeated button icon.

## Product hierarchy

The app is not a task manager and not a SaaS connector catalogue. Its primary hierarchy is:

1. **Home state** — what Adam truthfully knows about the household now.
2. **Needs you** — specific decisions and approvals, with their real context.
3. **In motion** — active work and watches.
4. **Around you** — timely deliveries, reservations and other grounded context.
5. **Adam noticed** — concise changes and outcomes, deduplicated.

Conversation remains one tap away, but the persistent composer must not dominate Home or cover content. Activity/history, services and controls live behind the account surface.

Never invent rooms, occupants, sensors, devices or environmental readings to make a screen feel richer. Unknown and not configured are designed states, not empty spaces to disguise.

## Palette

Light values are the primary rendered values; dark values remain complete and usable.

- **Canvas:** `appBackground` #F6F9FD — cool near-white.
- **Surface:** `appSurface` #FFFFFF.
- **Active inset:** `appSurface2` #E8F0FB.
- **Ink:** `appInk` #101721.
- **Secondary:** `appMuted` #5C697A.
- **Energy:** `appAccent` #135EE1.
- **Hairline:** blue-black at 11%.
- **Semantics:** green for confirmed/live success, amber for attention, red only for failure or destructive action.

No beige, antique gold, paper grain, sepia vignette or decorative pastel blobs. Gradients are limited to a very faint ambient blue lift on the canvas. Do not put gradients on ordinary controls.

## Typography

- Interface and display type use the system sans-serif.
- Display: 25–32pt, bold, tight tracking, short statements.
- Section title: 18pt bold.
- Row title: 14–16pt semibold.
- Secondary text: 11–14pt regular.
- Mono is for timestamps, counts and technical identifiers only.
- Never use light font weights for essential text. Dynamic Type and multiline layouts are mandatory.

## Shape and depth

- Hero/home state: 22pt continuous radius.
- Grouped list: 18pt.
- Individual activity row: 16pt.
- Compact control: 13–17pt.
- Use one hairline and a restrained local shadow. Never combine blur, thick border and heavy shadow on the same surface.
- Prefer grouped rows inside one surface over a stack of identical floating cards.
- Pills are for status, compact counts and short choices only.

## Interaction

- Home uses a safe-area dock, never an overlay that obscures scroll content.
- The main dock says **Ask Adam** and supports voice or text. Conversation history is a separate, adjacent action.
- A whole household-state surface is tappable only when it has a meaningful action: setup or refresh. Static states should not promise navigation.
- Connected services use **Manage**, followed by explicit confirmation before disconnecting.
- Protected and irreversible actions are always gated by the deterministic execution policy. UI preferences may add review; they may not remove mandatory review.

## Copy

Copy is terse, factual and situated.

- Prefer “You're away” over “Adam has detected that you may no longer be at home.”
- Prefer “No action needed” over a motivational empty state.
- Replace generic approval text with the actual prompt or subject when available.
- Do not narrate how an assistant works, use fake warmth, or add marketing subtitles to self-evident labels.

## Motion and feedback

- Motion communicates state change, hierarchy and continuity only.
- Use short spring responses for touch, one entrance sequence per visit, and subtle progress motion for live work.
- Respect Reduce Motion.
- Use light haptics on navigation and selection; medium haptics for committing or beginning work.

## Accessibility and QA

- WCAG AA contrast is the floor.
- Minimum hit target is 44pt even when the visible control is smaller.
- Check every primary screen at large Dynamic Type.
- SF Symbols are banned. All icons are bundled assets rendered through `AppIcon`.
- Simulator review must cover Home, More, Services and Settings, including scroll bottoms and the safe-area dock.

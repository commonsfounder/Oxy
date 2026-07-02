# App UI Direction — July 2026 (Burned the old one)

**Old direction (burned):** Nameless / Silent Luxury / editorial minimalism.
- Obsidian + titanium hairlines + ultra-restrained type.
- "Where should we begin?", thin vertical rules for AI text, floating glass everything, edCanvas, shadow mode.
- Cold, pretentious, literary, low-contrast, fights the product.
- Matched hardware jewelry fantasy more than daily "friend that acts for you".

**New direction (locked): Warm, Clear, Capable Assistant.**

Core principles (no fluff):
- The UI must feel like a helpful, slightly warm, competent friend who gets shit done.
- Clarity and trust > aesthetic purity, especially on money, orders, bookings, proactive.
- Use color purposefully for energy, status, and safety (accent for actions, strong semantics for warnings/confirm).
- Chat should feel conversational and alive, not like reading an art book.
- High-stakes moments (payment confirm, order review) get bold, explicit, reassuring treatment — never generic "review action".
- "Today" is a lively home, not another minimal list.
- Respect iOS muscle memory where it helps (tabs, sheets). Custom only when it adds real value or delight.
- Personality: subtle but present. the app has a voice. Users should feel the AI is capable and on their side.
- Craft still matters: good haptics, interruptible motion, optical alignment, proper hit areas, concentric radii, scale 0.96 on press. But in service of usability + warmth.
- Dark-first for companion feel, but excellent light support. Readable at a glance.

**Palette direction:**
- Primary background: rich dark (near black but warm).
- Accent: vibrant, friendly teal/cyan-ish (trust + energy). Example #00B4A0 or similar — used for AI elements, primary CTAs, highlights.
- Surfaces: layered dark with good lift.
- Semantic: clear success (green), warning (amber), danger (coral/red) — make them pop when needed.
- Text: high contrast ink, muted for secondary.
- No more "titanium hairlines only". Use hairlines sparingly; color and weight for separation.

**Chat:**
- Real bubbles or strong visual distinction.
- User: right aligned, tinted with accent.
- AI/the app: left, with subtle presence (icon or left accent bar or distinct fill). Streaming feels responsive.
- Action cards: prominent, labeled clearly (especially "Confirm order — this will charge £X").
- Welcome/empty: inviting, quick-start actions that feel useful not poetic.
- Kill "shadow mode" pretension or make incognito obvious and secondary.

**Navigation / Tabs:**
- Clear, immediate tabs: Chat (main conversation), Today (proactive home), More (or Settings/Connectors).
- Bottom bar should be reliable — floating glass was clever but fussy. Consider standard + personality layer, or a bolder custom that doesn't tuck in annoying ways.
- Default to useful starting tab (probably Today or Chat depending on context).

**Today / Proactive:**
- Lively cards with real data (incoming deliveries highlighted, agenda with color, weather integrated but not the sole source of color).
- Cards should feel alive and scannable. Use accent and semantics.
- No more "removed AI filler" leading to dead minimalism — make data delightful.

**Actions & Payments (critical):**
- Review/confirm sheets or cards are explicit.
  Example: "Confirm order on Deliveroo — £14.50 to 123 Street. Uses card saved on Deliveroo."
  Big primary "Confirm & Pay" (or "Yes, place it"), clear secondary "Cancel / Add payment method on site".
- When no saved payment: surface early "You'll need to add a card on the site first" + easy handoff.
- Never ask for card details in chat. Agent should refuse gracefully and guide to the site.

**Typography & Density:**
- Readable sizes, good weights. Less ultra-light editorial.
- Information density appropriate for phone — not sparse luxury.
- Consistent scale.

**Motion & Feel:**
- Purposeful. Confirmations feel solid/safe. New content enters cleanly.
- Haptics on key actions.
- Keep the good engineering (streaming, voice, native handoffs).

**Brand in UI:**
- "the app" or simple wordmark when needed. No heavy Milgrain worship in software.
- Subtle personality: consistent icon or glyph for the AI when it speaks or acts.
- Settings for personality level later if wanted.

**Migration notes:**
- Old tokens (nml*, edCanvas, nmlGlassContainer etc.) will be removed or mapped temporarily.
- New tokens under oxy* or clean Color extensions + modifiers.
- Update all views incrementally.
- Preserve functionality: auth, chat streaming, voice, browser actions, pendant, etc. Design is the layer on top.

**Success metrics (harsh):**
- Does a first-time user immediately understand they can ask it to do real things?
- When about to spend money, does the UI make them feel informed and in control (not elegant and lost)?
- Does the chat feel like talking to something helpful rather than reading at it?
- Does Today make you want to open the app in the morning?

This direction serves the actual product: agent that takes action, friend-like, real life integration.

Old aesthetic burned. Moving forward.

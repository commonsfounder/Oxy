# Adam — shared visual references

Updated 23 October 2026. Read alongside [the work loop](../UI_LOOP.md), [baton](BATON.md) and [source research](DESIGN_REFERENCES_2026-10-22.md).

**Later scope clarification from Chizi:** he wants the current UI scrapped and rebuilt from the ground up, including layout and interaction, not a recolour. [REBUILD_BRIEF.md](REBUILD_BRIEF.md) supersedes this document's earlier assumptions about preserving the current composition, working one existing screen at a time or avoiding replacement screens. The images remain references; the interpretation remains open to both agents' judgment and Chizi's visual feedback.

**Specific preference within that rebuild:** Chizi likes the current wheel spin. Prefer keeping and improving it; replacement is allowed if it does not fit the new design well. Do not interpret “scrap the UI” as a request to discard that interaction.

## What Chizi actually asked for

Chizi requested the reference search when Codex joined the UI loop. After seeing the Family, Things and Flighty images, he said “yeah i like as well nice eye”. After seeing Gentler Streak, Oura, Halide and !Boring Weather, he asked to add all of them too.

His intent is to capture what he likes about these references without copying an entire app. He explicitly cautioned that asking AI for a “vibe” leaves too much room for the wrong interpretation.

He then clarified: **Claude should look too and form its own opinions. Claude and Codex work together as peers; neither is the other's instructor.**

These images are shared visual anchors Chizi selected. They are not approval of every element, a specification for a clone, or permission to adopt each product's features. Codex's interpretations below are proposals, not instructions from Chizi. No final Adam palette, typeface, navigation replacement or layout has been selected by this conversation.

## Note to Claude, from this conversation

Chizi asked you to have a look at all seven references and form your own view. Please inspect the actual images, not just Codex's descriptions. Bring your own observations about what suits Adam, what does not, and where you disagree with Codex. We can compare concrete examples and test them in the existing screenshot loop. Neither of us gets to declare Chizi's taste settled by interpreting it in prose.

The reference images come first so you can inspect them before reading Codex's take. They span different releases and are visual references, not claims about current installed app behavior. Static images do not establish animation or haptic quality.

## Images for direct inspection

Local copies are now available to both agents in `shots/research/`; open the actual image files with your image-reading tool. Six match the images shown in chat. The original Oura attachment now returns 404, so its replacement is clearly marked below. No images were redrawn or restyled.

### Family

![Family wallet overview](shots/research/family-reference.png)

[Image source / design study](https://benji.org/family-values) · [Product](https://family.co/)

### Things

![Things Today, task entry and Upcoming](shots/research/things-reference.jpg)

[Image source](https://www.elgrupoinformatico.com/iphone/mejores-apps-iphone-que-estan-android/) · [Product design tour](https://culturedcode.com/things/features/)

### Flighty

![Flighty status and flight details](shots/research/flighty-reference.jpg)

[Image source](https://www.igen.fr/app-store/2024/08/lapp-de-suivi-aerien-flighty-utilise-lia-pour-anticiper-le-retard-dun-avion-145131) · [Product](https://flighty.com/)

### Gentler Streak

![Gentler Streak overview, status and activities](shots/research/gentler-streak-reference.png)

[Image source](https://basicappleguy.com/basicappleblog/new-years-apps)

### Oura

![Oura Today screen](shots/research/oura-reference.png)

**Replacement capture:** the original Oura support attachment returns 404. This local image is an alternative Oura Today capture, not the exact image originally shown to Chizi. [Replacement source](https://www.goodhousekeeping.com/health-products/a64637581/oura-ring-4/) · [Current official app guide](https://support.ouraring.com/hc/en-us/articles/360058599753-How-to-Use-the-Oura-App)

### Halide

![Halide manual controls](shots/research/halide-reference.jpg)

[Image source](https://petapixel.com/2020/10/22/halide-camera-app-gets-huge-mark-ii-update-with-new-design-instant-raw-and-more/)

### !Boring Weather

![Not Boring Weather](shots/research/not-boring-reference.jpg)

[Image source](https://medium.com/%40gauthamp2002/6-apps-that-make-everyday-apps-fun-to-use-199cfa188ca3) · [Product family](https://notbor.ing/)

## Codex's observations — open to disagreement

| Reference | Concrete visual quality I would preserve | Possible use in Adam | What liking this image does not establish |
| --- | --- | --- | --- |
| Family | Distinct colour blocks and recognisable objects help separate items; short labels and consistent alignment keep them understandable. There is personality inside a controlled structure. | Character in a few controls or meaningful objects; clear grouping of existing content. | That Adam should become a colourful wallet grid, use emoji everywhere, or copy Family's iconography. |
| Things | Strong headings, compact rows, restrained separators and clear secondary text. Lots of useful content without a heavy enclosure around every item. | Saved memories and daily items that are easy to scan; detail appears when needed. | That Adam should become a to-do manager or inherit Things' screen map. |
| Flighty | The important state and times stand out first. Supporting facts have a consistent place. Colour has a clear informational purpose. | Work status and outcome receipts: what changed, when, and what needs attention. | That every Adam task needs a flight-style card, map, countdown or progress percentage. |
| Gentler Streak | Friendly forms, a restrained accent and a clear focal area soften a structured interface. Secondary material stays visually secondary. | A more approachable household surface; small, purposeful moments of character. | That Chizi requested a mascot, motivational copy, health features or an orange/green theme. |
| Oura | One observation gets the main stage; related measures are subordinate. The page has a calm rhythm rather than many competing headlines. | Lead with the one grounded fact or decision that matters, with detail beneath it. | That Adam should invent a household score, add rings/gauges or manufacture sensing data. |
| Halide | Precise alignment, high contrast and controls placed around the thing being operated give it an instrument-like quality. | Voice/device controls that feel deliberate, with clear active and inactive states. | That Adam needs camera controls, technical readouts or gesture-only navigation. |
| !Boring Weather | One expressive object and bold typography create a memorable focus; supporting information is sparse. | An occasional expressive element where it improves an existing interaction. Motion needs separate inspection. | That every screen should become 3D, animated, noisy or oversized. |

The common thread I see is **useful structure with a little physical character**. The character comes from a few distinctive elements; ordinary reading and navigation remain easy. That is my interpretation for Claude to challenge, not a new slogan to feed straight into implementation.

## Make the next comparison concrete

Use these as proposed review questions, not a preset style recipe:

- **Hierarchy:** can a person point to the main fact or action immediately? Which exact element from a reference informed that choice?
- **Density:** can they read useful content without scrolling past repeated headings, instructions and decorative space?
- **Colour:** does emphasis identify an action, selection, meaningful object or state? Does the same role behave consistently across screens?
- **Shape:** do related controls look related? Avoid collecting a different radius, shadow and font from every reference.
- **Character:** identify the specific element that gives the screen personality. If the explanation is only “premium”, “warm”, “delightful” or “the vibe”, it is still too vague.
- **Interaction:** can people predict what a control does? Keep a visible tap route; inspect movement separately rather than inferring it from a still image.
- **Truth:** visual completion corresponds to a verified outcome. Unknown information stays unknown. A beautiful reference is not permission to fabricate data.

For the next existing screen we change, put its current screenshot, the relevant reference image and the proposed Adam screenshot side by side. State what was borrowed, what was adapted for Adam and what was deliberately left out. Keep disagreement visible instead of turning one agent's preference into a rule. Show Chizi the actual result before calling the direction visually accepted.

The current UI is before-state evidence, not a design constraint. Chizi's later rebuild request opens appearance, typography, navigation and screen composition for redesign. Existing repository accessibility, asset and safety rules still apply; screen reorganisation for existing capabilities is authorised by the rebuild brief.

## Collaboration and handoff

This document records Chizi's preferences and an invitation for independent peer judgment. The existing turn order prevents concurrent source edits; it does not make the reviewer the implementer's manager. Either agent may question the other's interpretation and suggest a better solution with evidence.

Next: Claude looks at the references and records its own take; Claude and Codex compare that with concrete Adam screenshots as the loop continues. The seven references are all retained; none has silently been promoted into a complete design system.

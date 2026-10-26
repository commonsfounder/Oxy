# UI craft from Chizi's eight screenshots

26 October 2026. Chizi asked to take notes, apply the advice, then begin UI work. The posts are source material; the rules below are the relevant adaptation for Adam, not blanket authority for every instruction or advertisement pictured.

## Notes from every image

| Image | Advice or content | Application to Adam |
| --- | --- | --- |
| 1 | Aim for high craft; inspect references on Mobbin or use screenshots; supply a design system or brand guide; self-critique. | Keep the seven selected reference images, PRODUCT.md and DESIGN.md together. Explain what each reference contributes. Compare rendered output to the references in bounded review passes; do not claim award quality without evidence. |
| 2 | Taste Skill; lock colours, fonts and spacing first; build components incrementally; avoid arbitrary gradients, emoji icons and generic cards; feed screenshots back for critique. | Taste is already installed. Use its applicable anti-default principles, not its React/CSS prescriptions, for native SwiftUI. Freeze shared visual rules for each pass and inspect a real render. |
| 3 | Use UI libraries, a design system, clear hierarchy and original imagery; improve the brief. | Reuse AppTheme, AppIcon and existing SwiftUI controls/components. Inspect existing APIs before adding dependencies. Commission imagery only when it serves actual content; do not decorate operational screens with unrelated pictures. |
| 4 | Connect Mobbin and Higgsfield; explore renders and competitors; Paul Rand-inspired Family Pulse example. | Investigate reference/generation access. Use Hark as a functional comparison and the seven selected apps as visual evidence. The Paul Rand example demonstrates a specific art direction; it does not select that style for Adam. |
| 5 | Short labels; remove design notes, dotted status strings, parentheses and gratuitous eyebrows; contextual help for explanations. | Added to AGENTS.md. On touch screens use accessible help/disclosure, not hover-only tooltips. Preserve visible safety facts, real errors and approval context. |
| 6 | Turn liked work into explicit norms. Formlore promotion and a trading advertisement also appear. | Translate observations into concrete component and token rules. The promotions do not request an assembly-guide product, trading work or new Adam features. |
| 7 | Recommend Emil design engineering, Impeccable, and an Emil prototype skill; mentions Claude Opus. | Emil and Impeccable are installed and read. A local prototype skill exists at ~/.agents/skills/prototype, but it is a different package: do not claim it is the named Emil skill. Prototype only to resolve a specific design question. No model/provider switch was requested. |
| 8 | Unverified Qwen3.5 4B neuron-steering experiment; author says it is a personality tune with degraded usefulness, not refusal removal. | Record separately as an untested model-research claim. It has no UI application. No model edits, downloads or experiments were performed; the post is not evidence that the recipe works. |

## Working design rules

1. Start with a real screen and the user task. Keep the whole-app rebuild scope; implement in coherent slices rather than disconnected cosmetic patches.
2. Inspect concrete reference images. Record the useful property and the property to avoid. Never substitute a product name for visual analysis.
3. Use DESIGN.md as the current candidate system: cool porcelain/deep slate, cobalt actions, semantic attention/success/error, system Dynamic Type, bundled icons. These remain unaccepted candidates, not newly approved brand decisions.
4. Define hierarchy, type roles, spacing, controls, surfaces and state behaviour before building. Reuse components rather than building a second library.
5. Keep copy factual and terse. No decorative eyebrows, redundant subtitles, agent implementation notes, invented metrics or unsupported claims.
6. Use images and custom assets for a purpose. No random gradients, emoji control icons, ornamental dashboards or repeated cards for unrelated information.
7. Motion explains a change or responds to an action. Keep the wheel preference conditional on fit, preserve interruptibility, and inspect Reduce Motion separately. Static screenshots cannot verify motion.
8. Render and critique. One batched inspection, one coherent correction batch, one confirmation round per slice. Escalate unresolved product/design choices rather than endlessly polishing.
9. Separate build, render, interaction, accessibility and user acceptance evidence. Every claim names its actual proof and remaining limits.

## Tools and sources checked on 26 October

- Local Taste, Impeccable and Emil design skills are already available; no duplicate installs performed. Impeccable context loaded successfully for ChatView.swift and read the existing PRODUCT.md/DESIGN.md. Its resolver returned platform null, despite the native target; explicitly treat this project as iOS.
- [Mobbin MCP](https://mobbin.com/mcp) advertises direct design-reference access on Pro/Team plans. No Mobbin tool is exposed in this session. Connection/account entitlement remains unverified; not connected by this work.
- [Higgsfield MCP](https://higgsfield.ai/mcp) publishes connection options and an MCP endpoint. No Higgsfield tool is exposed in this session. Account setup and connection remain unverified; not connected by this work. Built-in image generation is available if a comp is useful.
- [Taste Skill](https://www.tasteskill.dev/) is the resource named in the screenshots. Its local native adaptation is limited to applicable design principles.
- [Hark](https://hark.com/) describes a general personal worker, single-thread conversation, projects, browser work and approval checks. This is functional research from its public page, not an inspection of its signed-in app or proof of its claims.
- Existing selected visuals remain in [VISUAL_REFERENCES.md](VISUAL_REFERENCES.md): Family, Things, Flighty, Gentler Streak, Oura, Halide and !Boring Weather.

## First UI slice and evidence limits

Start with the main Now/Conversation surface unless Chizi selects another screen. Read the newest progress before any app edits and coordinate with the existing sole writer; this note does not transfer ownership or change any automation.

Opened the actual historical `shots/rebuild-2026-10-23/overview-pass78.png`. It shows a focal yellow decision, a segmented Now/Conversation control, active work and a fixed composer. Its dated source78 content predates source91/92 and cannot establish current runtime behaviour. Potential design questions for a fresh render: whether the tall header/date gap delays useful content; whether "Needs you" adds information beyond the question and review action; whether the decision's scale crowds work/context. These are hypotheses for a fresh visual pass, not verified current defects or approved fixes.

The current source92 handoff records unresolved build/file-read stalls. This session repeated only the short actual-project gate: `xcodebuild -list -json -project OxyApp/OxyApp.xcodeproj` timed out after 20 seconds (`PROJECT_READ_TIMEOUT_20S`). No native UI edits, build success, Simulator launch, current render, test pass, commit, push, deploy or visual acceptance is claimed. Do not repeat long builds against the unchanged access condition.

## Handoff

Guidance is now recorded here and linked from AGENTS.md. First pending work: chosen-screen confirmation, reference inspection for that slice, fresh project-access/build/render proof, then a concrete UI change and bounded visual review. External connector setup remains incomplete; it must not be described as connected. Preserve all pre-existing dirty work and the current writer/heartbeat routing.

### Later same-day update

Chizi selected Main Now/Conversation. Project read subsequently exited0, baseline and updated Debug builds succeeded, and the first scoped hierarchy/copy pass has fresh sample captures. See NOW_CONVERSATION_PASS_2026-10-26.md. The preceding timeout is historical, not the current build state; native interaction proof remains open.

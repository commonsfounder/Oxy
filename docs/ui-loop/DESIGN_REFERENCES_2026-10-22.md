# Design references for Adam — 22 October 2026

**23 October update:** Chizi subsequently liked the images of Family, Things and Flighty and asked to retain Gentler Streak, Oura, Halide and !Boring Weather as well. See [VISUAL_REFERENCES.md](VISUAL_REFERENCES.md) for all seven exact images, Chizi's stated intent and Codex's separately labelled interpretations. Chizi explicitly asked Claude to look and form its own opinions: the agents work together as peers, not instructor and subordinate. Recommendations below remain Codex's research opinions, not a complete user-approved specification.

## Request and provenance

**Chizi requested this research when Codex joined Claude's UI work loop.** Chizi asked to search GitHub and other sources for beautiful, liked, intuitive design languages, borrowing selected ideas rather than copying an entire product. Chizi then explicitly asked to include Twitter/X and to record that the request came from him. This research supplements the current UI loop; it does not replace Claude's implementation turn or establish a new approved visual direction.

## Recommendation

My strongest combination for Adam is **Things' calm content, Family's tactile controls, Flighty's explicit state, and Rauno/Emil's interaction detail**, with Linear as a reference for consistent hierarchy. Each contributes a different job; do not mix their full themes.

Keep Adam's existing identity and night appearance while testing these ideas. The goal is a coherent household product that feels immediately usable and unusually well made. Most screens should stay quiet. A few interactions can have character: opening the wheel, revealing a useful detail, finishing a task. This is a design judgment, not a measured usability finding.

## Primary references: what to borrow

| Reference | Why it made the shortlist | Specific idea for Adam | Where to try it |
| --- | --- | --- | --- |
| [Things](https://culturedcode.com/things/features/) | A mature native product whose own feature tour explains progressive disclosure, direct manipulation and structured daily content. Its site records two Apple Design Awards. | Put the useful title first; keep details secondary; expand an existing item in place instead of sending people through repeated full-screen interruptions. | Memory rows and Today items. Reduce the large preparatory region above saved memories. |
| [Family](https://family.co/) | An expressive native reference that still gives actions clear labels. Its public demos cover send/receive, readable activity and transaction states. | Controls should look and feel pressable. Show human-readable consequences and a clear progression through pending/completed states. Use friendly detail sparingly. | Existing approval surfaces and Activity receipts; press/selection feedback on the wheel. |
| [Flighty](https://flighty.com/) | Its public product presentation emphasizes changed gates, delays, timing and what changed. The site records its 2023 Apple Design Award. | Let a short status, time and concrete change do the explaining. Clearly distinguish a plan, an action in progress and a verified result. | Live work in the thread and completed-task receipts. A reservation needs evidence; a calendar entry should say calendar entry. |
| [Linear's interface refresh](https://linear.app/now/behind-the-latest-design-refresh) | The team's March 2026 explanation directly addresses accumulated inconsistency, predictable action placement and navigation competing with content. | Reuse the same header geometry and action locations. Make navigation recede after reaching a destination while preserving legibility. | Existing sheet headers and close/back controls. Fix overlap rather than hiding content beneath a fade. |
| [Rauno's craft archive](https://rauno.me/craft) and [interaction essay](https://rauno.me/craft/interaction-design) | Concrete examples include wheel interfaces, SwiftUI radial menus, toolbars and docks. Particularly relevant to Adam's existing wheel. | Preserve the relationship between the control and what it opens. Keep transitions interruptible and direct manipulation connected to the finger. | The current wheel and sheet transitions. An optional gesture must have an obvious tap route. |
| [Emil's animation guidance](https://emilkowal.ski/ui/7-practical-animation-tips) and [Sonner demo](https://sonner.emilkowal.ski/) | Specific, inspectable interaction guidance rather than an aesthetic mood. Sonner provides compact feedback with optional actions. | Fast, restrained press feedback; short state transitions; compact acknowledgement of reversible changes. | Memory saved/removed feedback, copy feedback and existing task-state changes. Important receipts remain persistent. |
| [!Boring](https://notbor.ing/) | A deliberately more expressive counterpoint: physics, haptics, sound and bold single-purpose tools. | Give one or two existing interactions a memorable physical feel. Evaluate whether it helps before keeping it. | Wheel selection or a small completion gesture. Do not spread animation, 3D or sound over every list and message. |

Family and Flighty were inspected in the browser, including their visible product examples. Things' feature presentation and Rauno's archive were also inspected visually. These are public web presentations, not hands-on evaluations of installed apps. Screenshots retained in shots/research are research captures, not Adam mockups or proof of native interaction quality.

## GitHub: community signals and useful source material

These are rounded star counts displayed on the public repository pages retrieved on 22 October 2026. They are discovery signals, not votes proving that an interface is beautiful or intuitive. No repository was installed or added as a dependency.

| Repository | Displayed stars | What is useful | Fit for this SwiftUI app |
| --- | ---: | --- | --- |
| [shadcn/ui](https://github.com/shadcn-ui/ui) | 126k | Consistent, composable controls and explicit component states. | Study hierarchy and control consistency. The React implementation is not a native iOS dependency. |
| [Sonner](https://github.com/emilkowalski/sonner) | 13.1k | Compact feedback and action placement; inspect its public demo. | Adapt selected feedback behavior using the existing native UI. |
| [cmdk](https://github.com/dip/cmdk) | 13k | Search, grouping, filtering and empty-state behavior in a compact surface. | Useful if improving an existing search surface; a desktop command palette is not a reason to add another mobile screen. |
| [Telegram iOS](https://github.com/TelegramMessenger/Telegram-iOS) | 9.3k | A real, substantial native messaging implementation; includes a ContextMenuMorph prototype directory. | Source-study candidate for composer, keyboard and context-menu behavior. This pass did not audit or run those implementations. |
| [Radix Themes](https://github.com/radix-ui/themes) | 8.8k | A coherent set of components with emphasis on accessibility and maintenance. | Study semantic color roles and component states; translate into existing native tokens. |
| [Vaul](https://github.com/emilkowalski/vaul) | 8.6k | A widely starred drawer reference. | Inspiration only. Its README explicitly says it is unmaintained. Prefer native sheet behavior for Adam. |
| [NumberFlow](https://github.com/barvian/number-flow) | 7.8k | Number transitions; [interactive examples](https://number-flow.barvian.me/). | A reference for changes to real values. Do not roll money amounts while someone is approving payment. |
| [Open SwiftUI Animations](https://github.com/amosgyamfi/open-swiftui-animations) | 5.7k | Native animation examples across loading, state changes and transitions. | Example library, not a complete visual language. Select effects by purpose. |
| [Pow](https://github.com/EmergeTools/Pow) | 4.4k | SwiftUI effects and transitions. | Native implementation reference for a narrowly chosen moment; no need to adopt the whole package for a small effect. |
| [Exyte Chat](https://github.com/exyte/Chat) | 1.9k | Customizable message/input views, attachments, pagination and message menus. | Compare edge-case behavior with Adam's current thread. Avoid replacing the existing chat framework merely for its appearance. |

## Twitter/X findings

Public profiles and posts were read directly in the browser after the ordinary web fetch returned 403. No login or account changes were needed. Some embedded videos reported “Unable to play media”; their motion was not verified. The accessible view exposed Like controls as checked/unchecked state, not reliable engagement counts. Consequently this is a sourced shortlist, **not a ranking of the most-liked tweets**.

| Person / direct post | What was actually observed | Relevance |
| --- | --- | --- |
| [Emil, 21 October 2026](https://x.com/emilkowalski/status/2112878634746986947) | A post introducing examples of his work at Linear; the embedded video could not play. | A strong follow-up reference for interaction details, with the playable essays/demo sites used for substantive design guidance. |
| [Emil, 19 October 2026](https://x.com/emilkowalski/status/2112245483464802700) | A post arguing for larger, more inviting long-form text. | Protect readable conversation text and comfortable leading. Web pixel sizes are not SwiftUI point specifications. |
| [Emil, 17 October 2026](https://x.com/emilkowalski/status/2111450789566943247) | Recommends identifying animation opportunities, implementing them, then reviewing them. | Matches the existing look–fix–look loop. Do not animate everything by default. |
| [Rauno's interaction manual announcement](https://x.com/raunofreiberg/status/1962882635501330637) | Pinned 2 September 2025 post describing 23 chapters and downloadable React components. Video unavailable. | His public craft archive is the useful preview; no course purchase is needed for this research. |
| [Rauno, 19 October 2026](https://x.com/raunofreiberg/status/2112190931126378871) | A warning that broken links and poor mobile behavior invalidate an impressive-looking portfolio. | Visual novelty has to survive real interactions and mobile constraints. |
| [Paco's cmdk handoff](https://x.com/pacocoursey/status/1983342409401688342) | A 29 October 2025 post says cmdk moved under dip and links that repository. | Follow the current repository rather than an obsolete ownership assumption. |

For further browsing: [Emil](https://x.com/emilkowalski), [Rauno](https://x.com/raunofreiberg), [Paco](https://x.com/pacocoursey). Things' site also embeds selected public praise, including [this September post](https://x.com/GradyGaugler/status/2099600133835137253); those are vendor-selected testimonials, not independent consensus.

## Wider sources worth retaining

- [Component Gallery](https://component.gallery/): its current index lists 60 components, 95 systems and 2,671 examples. Useful for comparing the same control across systems rather than copying a whole theme.
- [Brian Lovin's App Dissection](https://brianlovin.com/app-dissection): historical interface studies. Useful for noticing detail, but the archive's examples are dated; do not treat them as current app screenshots.
- [Amie](https://amie.so/): the current public positioning is an AI note-taking/workday product. Keep it as a secondary reference for compact ongoing activity; do not rely on old calendar-app screenshots as evidence of its current product.

## A coherent borrowing plan for the next visual pass

1. **Today: Things + Family.** Readable situation, secondary timing/context, a separate action whose wording matches the request. Press feedback on that action. Keep card contents aligned whether a brand logo exists or not.
2. **Thread: messaging conventions + Linear.** Clear text, predictable navigation placement, readable composer and no overlapping content. Preserve chat continuity through keyboard and attachment states.
3. **Work and receipts: Flighty.** Show what is happening, what changed and when. A short verified result can expand into evidence. Never let a decorative completion animation substitute for verification.
4. **Memory: Things.** Saved content first, compact search, a small existing add action and optional detail revealed on demand. Preserve existing deletion confirmation.
5. **Wheel: Rauno + a small amount of !Boring.** Test existing tap/drag behavior and selection feedback before changing it. Try one deliberate tactile refinement. Keep labels legible and destination reachability obvious.

These are proposed applications, not implemented changes. Use the existing type, spacing, color and asset primitives; one component should not inherit one source's font and the next another source's radius. Retain bundled icons, 44pt targets, Dynamic Type, Reduce Motion and mandatory approval behavior. Do not add new settings, switches or screens without Chizi's approval under UI_LOOP.md.

First implement the concrete round-one trust/readability fixes. Then test the selected visual borrowing on those same screens and compare real before/after Simulator captures. Judge each change by clarity, tap count, legibility and behavior as well as appearance.

## Verification and handoff

Research only. Sources opened, public X posts read, reference pages inspected, sourcebook and baton updated. No libraries installed, app code changed, builds launched, commits made, push or deploy. `git diff --check` is the applicable document whitespace check; npm test remains mandatory before any eventual commit.

Claude remains the next implementation owner. The research adds concrete reference material without changing the turn order.

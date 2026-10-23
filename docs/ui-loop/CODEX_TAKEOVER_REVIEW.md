# Codex takeover — 23 October 2026

## Scope and ownership

Chizi has reassigned UI implementation to Codex after rejecting Claude's round-four pass. This supersedes the earlier Claude-implements/Codex-supports rule. The task remains the ground-up UI rebuild described in REBUILD_BRIEF.md, with the wheel spin preferably kept. Claude can offer independent critique; the two agents must not concurrently edit the same UI files.

## What the round-four captures show

Reviewed r4-today.png, r4-settings.png and r4-apps.png directly. These are historical captures, not approval of current working files.

- Today still gives almost half the screen to a generic letter tile, a broken sentence and generic answers. “4 things need you” and “Next up” duplicate structure without making the facts easier to scan. The primary action should name its actual outcome and show its relevant context together.
- Settings keeps the same grouped-list skeleton and adds coloured object tiles. Those colours and a larger rounded heading do not establish a new layout. Repeated decorative tiles draw more attention than the destinations.
- Apps puts the four connected accounts into large equal tiles. It is recognisable, but “Adam can use 4 of your apps” repeats the count and the grid consumes space without giving more useful control or context. Real account identity and management should determine the composition.
- Across the three screens, everything has become rounder, larger and more saturated. The selected references were useful for their distinct hierarchy, composition and interaction, not a licence to apply their most obvious surface motifs everywhere.

## Direction to carry forward

Make one coherent everyday experience: clear conversation, legible input, a useful place for current work and decisions, and connected overview/detail layouts. Keep the wheel's physical spin but give navigation intentional space so it cannot cover message text. Ordinary facts should read easily; a consequential decision should contain the actual object, consequence and action. Do not manufacture urgency or rank the first returned item as “most pressing” without data that supports it.

Use the seven actual images to compare structure and detail. Build real SwiftUI surfaces with meaningful populated and quiet states, inspect them, correct the visible faults in a bounded batch, then confirm with fresh captures. Larger text and the keyboard are part of the composition, not later polish. A good Today screenshot is one slice, not the entire rebuild.

## Automatic continuation

The app heartbeat **Adam UI rebuild loop** (`adam-ui-rebuild-loop`) was created ACTIVE for this chat, every 30 minutes. It reads the latest baton, chooses the next substantive slice, implements, builds and visually inspects, records proof and continues. It stays quiet for unchanged/non-actionable state and surfaces substantial progress, failures or decisions. It ends at a locally verified whole-app milestone for Chizi's visual review; it must not silently decide Chizi approved the look.

At setup, an existing `scripts/ui-loop.sh 4 2` process was active (PID 54012), with Codex round one running and writing `/tmp/ui-loop/codex-1.log`. That process is an implementation owner. Let the already-running bounded cycle complete; do not start another shell loop or another UI writer. The heartbeat checks actual process/git state before taking the next slice. Stale PID or ownership notes alone do not establish a live writer.

The legacy script's output is terminal output, not an exchange in Chizi's existing Claude app chat. Use this chat's heartbeat and the shared files as a visible progress record. Do not claim a sent prompt means implementation, a passing build means visual approval, or a local commit means deployment.

No app source was changed by this takeover review while the other implementation process was active. No app build was launched by this review. Simulator availability and current runtime hierarchy were read; the scheduled heartbeat was created and its saved status checked. No deploy or real-phone installation is authorised by scheduling the loop.

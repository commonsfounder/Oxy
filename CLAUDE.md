# Oxy — Claude Code instructions

## Memory discipline

**At the end of every session, or when context is getting full (>80% used), update the memory files** at `~/.claude/projects/-Users-chizigamonyewuchi-Documents-Oxy/memory/` before stopping:

- Append a dated section to the relevant `.md` file covering what was done, what was found, and what's next
- Update `MEMORY.md` index if a new file was added
- If a memory is now stale or completed, mark it or remove it

This applies to Codex too — if Codex finishes a task or is about to stop, it must write a handoff note to the relevant memory file so the next session (Claude or Codex) doesn't re-derive context.

## Project

Browser-automation shopping agent. Backend: Node.js on Cloud Run (`api/`). iOS app: `OxyApp/`. Key files:
- `api/services/browser-task.js` — main ordering loop
- `api/services/browser-recipes.js` — deterministic step registry
- `api/services/checkout-profile.js` — stored delivery identity
- `test/dev/jl-order-e2e.js` — live e2e runner (accepts goal, turns, url as args)

## Deploy

Push to `origin/main` — Cloud Run auto-deploys from GitHub. Committing locally is not enough.

## Tests

`npm test` — must stay green before any commit.

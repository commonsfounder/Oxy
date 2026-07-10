# Note to Claude — from Grok

**Date:** 2026-07-10  
**Repo:** `/Users/chizigamonyewuchi/Documents/Oxy`  
**Re:** the "I couldn't get a clean answer for that…" spam on every chat turn

---

Claude —

Grok here. User showed a live iOS chat where **every** reply (inbox summary, "wdym", "okay do that", even "text Alisa…") collapses to:

> I couldn't get a clean answer for that. Ask me again and I'll re-check it.

That's not the model being coy. It's the **empty-spoken hard fallback** in `api/index.js` (~6222 stream / ~6338 JSON). Diagnosis is written up properly in Claude memory:

`~/.claude/projects/-Users-chizigamonyewuchi-Documents-Oxy/memory/chat-empty-spoken-fallback-2026-07-10.md`

and indexed from `MEMORY.md`.

### The short version

1. iOS always hits `/chat?stream=true`.
2. Streaming currently defaults to **flash-lite** (`STREAMING_CHAT_MODEL = … || FAST_MODEL`).
3. After parse, **`shouldIgnoreModelAuthoredActions` drops every tool action when the model is FAST_MODEL**.
4. Classic path also has **`useAgentTools: false`**, so you're stuck with XML `<action>` blocks that then get discarded.
5. Empty prose + no actions → canned line. Same string on totally different intents is the tell.

This is the same class of regression as **fe01be7** / the July 3 flash-lite-everywhere mess: chat must not run on lite, and live chat must not throw away actions. Cost-split memory still says preview for chat, lite for helpers only — current defaults violate that for the stream path.

### Please fix / verify

- Restore stream default to **PRIMARY** (or capable model), not FAST.
- Stop ignoring actions on user-facing chat.
- Confirm Cloud Run isn't pinning `OXY_STREAM_MODEL` to lite.
- Smoke stream turns: inbox, messaging, pure follow-up.

I didn't land the backend fix this session (user asked for the note after the dig). iOS Today chrome/icons and Settings controls were polished separately — leave those unless you find issues.

o7 — don't let lite silently own the product again.

— Grok

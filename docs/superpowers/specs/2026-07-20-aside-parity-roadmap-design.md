# Aside-parity roadmap — design (2026-07-20)

## Context

Researched aside.com (AI browser product, YC-backed) to extract functionality worth porting
into Oxy. Aside's pitch: a standalone browser that drives real websites directly (no API
integrations), with a credential vault, personal memory, live task transparency, and routines/
scheduling. Full feature extraction and pricing breakdown covered in this session's research
before this doc; not repeated here.

Oxy is architecturally different: chat-first, with a headless browser-task engine invoked from
chat for specific tasks (see `docs/BROWSER_TASK_SESSION_HANDOFF.md` and the fastpaths design at
`docs/superpowers/specs/2026-07-01-self-learning-fastpaths-design.md`), plus a native iOS app.
Oxy is not a general-purpose browser replacement and this roadmap does not attempt to make it
one. Goal: take the Aside capabilities that map cleanly onto Oxy's existing shape — reliability/
speed, credential safety, transparency, memory, routines — and close that gap specifically,
while explicitly not chasing full browser-replacement parity.

## Decisions made during brainstorming

- **Priority**: balanced roadmap, no single area weighted over others.
- **Phase sizing**: fewer, bigger phases (not micro-slices) — each phase is a substantial,
  independently shippable subsystem.
- **Credential vault scope**: full vault — general site credentials (not just the existing
  payment-card flow), iOS Keychain + Secure Enclave-backed storage, scoped per-task grants.
- **Memory scope**: entity/task recall only. Structured log of
  `{task_id, site, entity_name/id, timestamp}` for tasks the *agent* ran. Explicitly NOT full
  page-content capture/embeddings, and explicitly NOT capture of the user's manual browsing
  (out of scope — see Non-goals).
- **Speed** is a cross-cutting constraint, not its own phase: nothing in this roadmap may
  regress the existing fastpath/warm-pool latency wins.

## Phase 1 — Reliability & Live Visibility Foundation

- Harden the existing browser-task engine: expand recipe coverage, tighten error-recovery/retry
  paths, keep the self-learning fastpath registry growing (builds directly on the existing
  `browser_fastpaths` design).
- **Live step-trace activity feed**: backend emits per-step task events; iOS surfaces them as a
  running "Recent tasks" panel with live status (mirrors Aside's transparency UX). This event
  stream is required plumbing for Phase 2 (audit log) and Phase 3 (memory writes) — build it
  generically enough to carry both.
- **Routines**: user-saved, reusable task templates (name + prompt + optional schedule stub).
  Simple CRUD; no new infra beyond a table and a list UI.

## Phase 2 — Full Credential Vault

- General-purpose vault (not just payment cards): iOS Keychain + Secure Enclave-backed storage
  for arbitrary site credentials.
- Extend the existing agent-card autofill pattern (shipped in the browser-checkout-payment work,
  commit `255d0d5`) to any stored credential — the secret is injected into the page by the
  browser-task engine and never enters the LLM's context window.
- Per-credential **audit log**: every use logged (task, site, timestamp), rendered via the
  Phase 1 activity feed — no separate UI surface needed.
- **Scoped per-task grants**: a task requests access to specific credentials/sites at dispatch
  time; the tool layer denies anything outside that scope, independent of what the vault
  physically holds.
- **Human confirmation gate**, generalized beyond money: extend the existing agentic
  money-guardrail review-gate pattern (spend caps, commit `3751394`) to cover messages/posts as
  well as payments — same mechanism, wider trigger set.

## Phase 3 — Personal Memory (entity/task recall)

- New table logging `{task_id, site, entity_name/id, timestamp}`, written only for tasks the
  agent itself executes (not manual user browsing — Oxy has no surface for that; see Non-goals).
- Chat pipeline gets a resolution step: a reference like "the candidate I opened yesterday"
  queries this log before falling back to asking the user to clarify.
- Surfaced lightly in the UI (e.g. a recent-entities strip near the activity feed), not a new
  standalone screen.

## Phase 4 — Scheduling, Controls & Polish

- Turn Phase 1's routines into schedulable recurring tasks (cron-style), extending the existing
  proactive-briefing pattern (`gatherProactiveContext`) to user-defined routines, not just the
  built-in daily briefing.
- Expose model/effort and a "Guard mode" (stricter, confirm-everything) toggle in the chat UI.
- Final visual/motion pass across the new surfaces (activity feed, vault settings, routines
  list) — polish applied last, once functionality is stable, per Apple Design pass conventions
  already established in this codebase.

## Comparison to Aside, post-roadmap

**Matches or beats:**
- Speed — existing fastpath/warm-pool system already turns ~17s tasks into ~5s; Aside discloses
  no equivalent speed metric anywhere in its public materials.
- Credential safety — same autofill-without-exposure pattern, plus scoped per-task grants and a
  confirm-gate generalized beyond payments.
- Live task transparency — same step-trace activity feed UX.
- Routines/scheduling — same, built on proactive-briefing infra already in production.

**Still short, and why (corrected from initial framing):**
- **Browser breadth is not a hard architectural gap** — Oxy's headless engine can technically
  reach any site, same as Aside's browser. The real gap is narrower:
  1. **Session continuity** — Aside is the user's daily-driver browser, so it has real
     logged-in sessions for everything the user visits, for free. Oxy's headless engine only
     has session state where the vault (Phase 2) or cookie import provides it.
  2. **Bot-detection exposure** — a non-interactive automated browser with no organic usage
     history reads as more bot-like to anti-automation systems than a daily-driver browser.
     Already a documented open problem (see `browser-task-reliability` memory: bot-walls
     flagged as unsolved on some sites; the device-body-agent-pivot idea was floated
     specifically to dodge this).
  3. **Per-site coverage depth** — recipes/fastpaths are narrower today than a mature product's;
     converges with usage over time, same as Aside's own approach would need to.
- **Memory breadth** — Phase 3 only remembers what the agent ran, not manual browsing. This is
  a product-shape difference, not a missing feature: Oxy has no surface for manual browsing at
  all (users browse in Safari/Chrome normally, not inside Oxy's headless engine), so there is
  nothing to capture on that axis. Not a real deficit, just not a comparable axis.
- **Full page-content history search** — explicitly deferred (see Non-goals).
- **Accuracy claim** — Aside's 99% Online-Mind2Web number is self-reported; no equivalent
  benchmark has been run for Oxy, so no comparative claim can be made either way.
- **Product shape** — Aside is a standalone browser the user lives in. Oxy remains chat-first
  with browser automation as a capability. Closing this fully would mean building an actual
  browser — a different product decision, not a roadmap item here.

## Spitball (not scoped into any phase — flagged for future consideration)

**Companion Chrome extension for session-linked automation.** Idea raised during brainstorming,
explicitly not committed to a phase:

- A desktop Chrome extension (Manifest V3) holding a websocket to the backend; backend sends
  action commands (click/fill/navigate), extension executes them in the user's real Chrome tab
  using the user's real cookies/session. Precedent that this pattern works: the Claude-in-Chrome
  MCP integration used in this same environment is architecturally identical (real browser, real
  logged-in session, remotely driven).
- Would close the bot-detection and session-continuity gaps identified above for any user who
  opts in and has desktop Chrome — because it's not a bot, it's the user's own browser.
- **iOS Safari extension is not a viable equivalent** — Apple's Safari Web Extension API doesn't
  support remote-command-driven arbitrary automation at Chrome's level, and Oxy is iOS-first, so
  this can only ever be a desktop-companion upgrade, not a primary-platform solution.
- **Real risks not yet resolved**: Chrome Web Store review is strict about extensions that
  execute autonomous remote commands (rejection risk); the command channel needs to be
  authenticated/signed per user to avoid becoming a new attack surface; fallback logic is needed
  for users without the extension installed (headless engine remains the default).
- Recommended shape if this is ever picked up: hybrid — headless engine stays the default/
  fallback for all users, Chrome extension is an opt-in companion used only when installed and a
  session exists for the relevant site.
- **Status: not scoped, not estimated, no phase assignment.** Revisit only if bot-detection
  actually blocks a real user workflow after Phase 1 ships, rather than building it speculatively.

## Non-goals

- Full page-content memory / embeddings-based history search.
- Capturing the user's manual (non-agent) browsing — no surface exists for this in Oxy's product
  shape.
- Rebuilding Oxy as a standalone browser / browser replacement.
- The companion Chrome extension (see Spitball) — noted for future consideration, not committed.
- Gesture-driven nav redesign — separate, already-discussed track, not part of this roadmap.

## Rollout approach

Each phase ships as its own commit(s) directly on `main`, verified end-to-end in the real app
before starting the next phase. No big-bang integration at the end.

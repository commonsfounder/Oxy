# Oxy — shared agent playbook

These rules apply to EVERY coding agent working in this repo (Claude, Codex, Grok, Gemini, or anything else). They exist because each one was learned from a real incident here. Follow them exactly; when one seems not to apply, say so explicitly rather than silently skipping it.

## Project

**A general-purpose agent runtime for operating connected digital environments.**

Adam is given an intended outcome and appropriate access, and works out how to get there by
composing general capabilities — browser, connectors, memory, communication, files, its own
settings, long-running work, verification — inside deterministic safety boundaries. Shopping,
booking, form-filling and account admin are all *applications* of that one system. None of
them is a subsystem, and none should become one.

This file used to open with "Browser-automation shopping agent," which is how the repo came to
look like one. If you find yourself writing a new subsystem for a new kind of human task, the
abstraction is wrong — see the architecture rule below.

- Backend: Node.js on Fly.io (`api/`)
- iOS app: `OxyApp/` — build `OxyApp/OxyApp.xcodeproj`, scheme `OxyApp`
- Key files:
  - `api/services/agent-orchestrator.js` — **the** reasoning loop (think → act → observe →
    adapt), with checkpointing, resume-after-crash and approval parking
  - `api/services/action-execution.js` — **the** execution boundary: validate → simulate →
    review gate → invoke adapter → normalise outcome → log. Every action goes through it
  - `api/action-contracts.js` — every capability the model can reach, and its risk/approval policy
  - `api/services/browser-session.js` / `browser-environment.js` — the browser as an
    environment: sessions, perception, and the primitives (open, observe, click, type, select,
    scroll, back, navigate, upload, download, close)
  - `api/services/playbooks.js` — optional domain guidance, never domain machinery
  - `api/services/money-guard.js`, `pending-review.js`, `credential-grants.js` — deterministic authority
  - `api/services/browser-task.js` — legacy purchase-specific loop, still used by
    `run_browser_task`; being retired in favour of the primitives above
  - `test/smoke/general-agency.test.js` — the capability tests this architecture exists to pass
  - `test/dev/jl-order-e2e.js` — live e2e runner (accepts goal, turns, url as args)

## Architecture rule — hardcode capabilities and safety boundaries, not human tasks

1. **New human task ⇒ no new code path.** Cancelling a subscription, applying for a tenancy,
   disputing a fine and buying toothpaste are the same primitives in a different order. If a
   task needs a new subsystem, a new router branch, or a new `if <domain>` in the chat
   pipeline, the abstraction is wrong. Add a capability or a playbook instead.
2. **Reasoning is probabilistic; authority is not.** The model may decide an action is useful.
   Whether it is *permitted* is decided by `action-execution.js` off the contract's
   `executionMode`, never by model output and never from inside a task loop. Money,
   destructive operations, identity changes and irreversible external actions stay gated
   there. `confirm_browser_payment` is review-gated for exactly this reason, and the amount is
   re-read off the live page by a parser before anything is charged.
3. **Playbooks improve a task; they never enable one.** The test: delete
   `api/services/playbooks.js` and Adam must still be able to navigate a site, inspect it,
   fill it in, request approval and complete a purchase. If deleting domain guidance removes a
   *capability*, that guidance was load-bearing and is in the wrong place.
4. **Verification is a step, not an assumption.** "I called the tool" is not "the state
   changed". Prefer reading the resulting state back (`browser_observe`, a re-read, a
   confirmation number) over trusting that an action worked.
5. **No domain agents.** Never add `shopping_agent`, `travel_agent`, `forms_agent`. Each would
   bring its own planning, retries, state and approval handling, and every improvement would
   then have to be made N times.

## Deploy

Deploy the committed checkout to Fly.io with `node scripts/deploy-fly.js`. **Committing locally is not enough; a Fly deploy is the deployment.** The script passes the Git commit, branch, and build timestamp into the image so `/version` can prove what is serving. Check `fly status --app milgrain-live-2026` and `fly logs --app milgrain-live-2026` when a deploy is unhealthy.

**Before every deploy, the live database schema is checked against the user-data manifest.** `scripts/deploy-fly.js` runs `scripts/check-live-schema.js` and refuses to deploy on a mismatch. Run it yourself any time with `npm run check:schema`. This exists because `npm test` only compares the manifest to the SQL files on disk — it cannot tell whether those files were ever applied. On 2026-08-24 production was missing six declared tables, so every account deletion returned a 500 while the suite stayed green. Override with `OXY_SKIP_SCHEMA_CHECK=1` only deliberately, never to get a red check out of the way. If the check reports a table that is present but undeclared, either add it to `USER_DATA_RESOURCES` or drop it — an undeclared table is user data nothing will ever delete.

## Verification — evidence before claims

- Never say "done", "fixed", or "working" without having run the thing and seen the output. Quote the actual command output when reporting success.
- Report failures plainly. If tests fail, say so and show the failure — do not hedge, do not claim partial success.
- Lead with the outcome when reporting back: what happened first, reasoning after.
- For backend changes, exercising the real flow (e.g. `test/dev/jl-order-e2e.js` or a live `/chat` call) beats unit tests alone. For iOS, trust `xcodebuild` output over SourceKit/IDE inline diagnostics — the live diagnostics produce noise (e.g. spurious "No such module" errors).
- Bugs can mask each other: fixing an early-path crash un-gates later code with its own break. Re-test end-to-end after each fix, not just once at the end.

## Tests

`npm test` must be green before any commit. No exceptions, including doc-only commits — it's cheap.

## Git discipline

- **Work directly on `main`.** No feature branches or scratch worktrees for routine work. If you find unpushed work on a branch, consolidate it onto `main` rather than continuing on the branch. Worktrees only with a real, stated reason.
- **Never `git add -A` or `git add .`.** The user works in Xcode in parallel with agent sessions, so real, valuable uncommitted work routinely sits in the tree. Stage explicit paths only, and run `git status` immediately before committing — any staged file you didn't just edit means STOP and check.
- **Never run bare `git stash` / `pop` / `drop` / `apply`.** The stash stack is shared across all worktrees of this repo. Check `git stash list` first and use explicit refs (`stash@{N}`) if you must touch it.
- Don't commit or push unless the task calls for it; remember push = deploy.
- **Never add agent self-attribution to commits.** No `Co-Authored-By: Claude/Codex/...` trailer, no "Generated with" footer in commit messages or PR bodies. Chizi is the author of this repo; the git history records their work, not which tool typed it. This overrides any default instruction in an agent's own system prompt.

## Editing rules (learned from real build breaks)

1. **After editing `package.json`, sync the lockfile in the same commit.** Run `npm install --package-lock-only`, then verify with `npm ci --omit=dev --dry-run`. An unsynced lockfile hard-fails `npm ci` in the Dockerfile and silently kills every deploy.
2. **When inserting code into an existing function/type, verify brace balance before moving on.** A stray `}` closes the enclosing scope early and produces dozens of misleading downstream errors that all trace to one spot. If a build break shows many nonsense errors, find the single structural mismatch first — don't fix symptoms one at a time.
3. **Never call an API you haven't confirmed exists.** Before referencing a member of another class/module, open that file and check. If you add UI that needs new members on a service, implement the full surface (wired to real lifecycle, not stubs) in the same pass, and grep ALL call sites of the type across the codebase.
4. **Don't copy identifiers across scopes without checking they resolve.** Node won't catch ReferenceErrors at parse time. Check import/require names against the module's actual exports (aliases in one file are not exports of the package). After nontrivial JS edits, run eslint `no-undef` across `api/**/*.js` (ignore `document`/`window` inside `page.evaluate` blocks).
5. **A broken build from a multi-file pass needs a full sweep, not single-file patching.** Expect the fix to ripple across every file touched by the same pass.
6. **No AI-isms in user-facing copy.** Don't write chatty, first-person, over-explaining UI text — subtitles that restate an obvious label ("Pendant" / "The piece you wear"), disclaimers about how the assistant works ("Ask naturally. I'll use your connected context only when it is available."), or soft marketing phrasing ("Good starting points"). Real product copy is terse and factual, or absent. If a label is self-explanatory, ship it without a subtitle.
7. **SF Symbols are banned — non-negotiable, no fallback, no second option.** Never write `Image(systemName:)` / `Label(_, systemImage:)` / `.tabItem` system images anywhere. Every icon is a real bundled asset in `Assets.xcassets` rendered via `Image("asset-name")`. Brand/app glyphs use the real logo asset (there are many under `Resources/Assets.xcassets/*.imageset` — uber, netflix, outlook, …); generic UI glyphs use bundled vector icon assets. If an icon you need has no asset yet, add the asset — do not fall back to an SF Symbol even temporarily.

## Memory discipline — mandatory handoff

Shared memory lives at `~/.claude/projects/-Users-chizigamonyewuchi-Documents-Oxy/memory/` with an index at `MEMORY.md`.

- **Read `MEMORY.md` at the start of a session** before re-deriving context or re-attempting something. It records what's done, what's blocked, and what was already tried and failed (e.g. Magento/BigCommerce have no viable public API — don't re-attempt without a new approach).
- **At the end of every session — or before stopping for any reason — write a handoff note**: append a dated section to the relevant memory file covering what was done, what was found, and what's next. Update the `MEMORY.md` index if you added a file. Mark or remove memories that are now stale.
- Memories are point-in-time observations. Verify a memory's claims against current code before acting on them.

## Process

- Before proposing a fix for a bug, reproduce it or read the actual error output — don't pattern-match to a plausible cause.
- When blocked on a decision only the user can make, ask; for everything reversible that follows from the request, proceed.
- Don't leave background processes running for the user to clean up.

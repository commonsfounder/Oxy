# Oxy — shared agent playbook

These rules apply to EVERY coding agent working in this repo (Claude, Codex, Grok, Gemini, or anything else). They exist because each one was learned from a real incident here. Follow them exactly; when one seems not to apply, say so explicitly rather than silently skipping it.

## Project

Browser-automation shopping agent.

- Backend: Node.js on Cloud Run (`api/`)
- iOS app: `OxyApp/` — build `OxyApp/OxyApp.xcodeproj`, scheme `OxyApp`
- Key files:
  - `api/services/browser-task.js` — main ordering loop
  - `api/services/browser-recipes.js` — deterministic step registry
  - `api/services/checkout-profile.js` — stored delivery identity
  - `test/dev/jl-order-e2e.js` — live e2e runner (accepts goal, turns, url as args)

## Deploy

Push to `origin/main` — Cloud Run auto-deploys from GitHub. **Committing locally is not enough; pushing IS deploying.** If a deploy seems frozen, check the Cloud Run "Build History" strip for red bars before assuming anything else: a failed build produces NO new revision, so the old revision keeps serving and masks the real cause.

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

## Editing rules (learned from real build breaks)

1. **After editing `package.json`, sync the lockfile in the same commit.** Run `npm install --package-lock-only`, then verify with `npm ci --omit=dev --dry-run`. An unsynced lockfile hard-fails `npm ci` in the Dockerfile and silently kills every deploy.
2. **When inserting code into an existing function/type, verify brace balance before moving on.** A stray `}` closes the enclosing scope early and produces dozens of misleading downstream errors that all trace to one spot. If a build break shows many nonsense errors, find the single structural mismatch first — don't fix symptoms one at a time.
3. **Never call an API you haven't confirmed exists.** Before referencing a member of another class/module, open that file and check. If you add UI that needs new members on a service, implement the full surface (wired to real lifecycle, not stubs) in the same pass, and grep ALL call sites of the type across the codebase.
4. **Don't copy identifiers across scopes without checking they resolve.** Node won't catch ReferenceErrors at parse time. Check import/require names against the module's actual exports (aliases in one file are not exports of the package). After nontrivial JS edits, run eslint `no-undef` across `api/**/*.js` (ignore `document`/`window` inside `page.evaluate` blocks).
5. **A broken build from a multi-file pass needs a full sweep, not single-file patching.** Expect the fix to ripple across every file touched by the same pass.
6. **No AI-isms in user-facing copy.** Don't write chatty, first-person, over-explaining UI text — subtitles that restate an obvious label ("Pendant" / "The piece you wear"), disclaimers about how the assistant works ("Ask naturally. I'll use your connected context only when it is available."), or soft marketing phrasing ("Good starting points"). Real product copy is terse and factual, or absent. If a label is self-explanatory, ship it without a subtitle.

## Memory discipline — mandatory handoff

Shared memory lives at `~/.claude/projects/-Users-chizigamonyewuchi-Documents-Oxy/memory/` with an index at `MEMORY.md`.

- **Read `MEMORY.md` at the start of a session** before re-deriving context or re-attempting something. It records what's done, what's blocked, and what was already tried and failed (e.g. Magento/BigCommerce have no viable public API — don't re-attempt without a new approach).
- **At the end of every session — or before stopping for any reason — write a handoff note**: append a dated section to the relevant memory file covering what was done, what was found, and what's next. Update the `MEMORY.md` index if you added a file. Mark or remove memories that are now stale.
- Memories are point-in-time observations. Verify a memory's claims against current code before acting on them.

## Process

- Before proposing a fix for a bug, reproduce it or read the actual error output — don't pattern-match to a plausible cause.
- When blocked on a decision only the user can make, ask; for everything reversible that follows from the request, proceed.
- Don't leave background processes running for the user to clean up.

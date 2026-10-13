# YC push backlog

Ranked by expected score gain per hour. The recurring loop takes the top unblocked **agent** item each run;
**founder** items are listed so you can see what only you can unblock. Re-ranked every run.

## Founder only — these move the score most

| # | Item | Score impact | Notes |
|---|---|---|---|
| F1 | **Recruit 5–10 households for a two-week pilot** (spare iPhone on a shelf + Adam on their own phone). Not close friends. | up to +25 | `PILOT.md` has the setup, consent wording and what to measure. |
| F2 | **Deploy** this branch after merging: `node scripts/deploy-fly.js` | +1, unblocks F1 | Ships the working root page and the "Google is not connected" recovery. This session can't reach Fly. |
| F3 | **Record the 90-second demo** (script in `APPLICATION_W27.md`) | +4 | Unedited. One real task. |
| F4 | **Fill the [FOUNDER] fields** in `APPLICATION_W27.md` | +4 | Origin story, time on it, entity, equity. |
| F5 | **Confirm or replace the wedge** (⚑ decision in `APPLICATION_W27.md`) | +5 when settled | Everything public should say one thing. |
| F6 | **Open network access for this environment** (allow `*.fly.dev`, `api.openai.com`, `*.supabase.co`) | unblocks agent items A5, A6 | Lets the loop run live smoke tests instead of only offline ones. |

## Agent — the loop works these in order

| # | Item | Status |
|---|---|---|
| A3 | Model prompt: when a needed service isn't connected, offer to connect it first instead of attempting the action | next |
| A4 | Sound: glass false alarms (6/h) — cooldown / second-window rule using existing benchmark harness | queued, needs the eval data, which isn't in the repo |
| A5 | Live acceptance run (`test/dev/real-user-task-matrix.js`) and publish pass rate into the scorecard | blocked on F6 |
| A6 | Release smoke against production after F2 | blocked on F2, F6 |
| A7 | Draft (not send) pilot recruitment emails in Gmail for founder review | queued |
| A8 | Align `launch/` copy and the 18 Sep pitch with the chosen wedge | waits on F5 |
| A11 | iOS listening-station mode: keep the screen awake while sound listening is on, and evaluate the `audio` background mode (App Review risk) | needs a Mac build |
| A9 | iOS: show a Connect button when a chat result carries `open_connector_settings` | needs a Mac build to verify; do not push unbuilt Swift |
| A10 | Fix Supabase advisor WARN `update_travel_sessions_updated_at` mutable search_path | low value |

## Done

| Item | Run |
|---|---|
| Scorecard, competitors, application draft | 1 |
| Pilot kit (`PILOT.md`) | 1 |
| Real-database tests skip with a reason when unreachable; CI workflow | 1 |
| `scripts/traction-report.js` (+ tests) | 1 |
| Root URL served an error → real page (+ test) | 1 |
| Never-connected services now say "Connect Google in Settings" with a recovery action instead of "re-enable" | 1 |

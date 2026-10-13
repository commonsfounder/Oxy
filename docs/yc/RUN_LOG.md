# Run log

One entry per run, newest first. **⚑** marks a load-bearing decision — something you may want to reverse.

---

## Run 1 — 2026-10-13 · score 36 (first assessment)

**Found**
- Production: 38 accounts have ever messaged Adam; weekly actives peaked at 11 (week of 17 Aug); since 7 Sep the
  only weekly active is the founder; 0 new accounts in 30 days; 0 subscriptions.
- Of 39 non-founder people: 17 left after 1–2 messages; the 18 who sent 3–10 messages saw 23 of 33 actions fail,
  19 of those 26 failures being calendar/email asked before Google was connected. The error told them to
  "re-enable" something they had never turned on, and carried no recovery action.
- The public root `/` sent an `index.html` that doesn't exist in the repo.
- Tests: 1,989 run here; 1,893 pass; the 94 failures are all in 8 files that write to the real Supabase, which
  this container can't reach. Browser tests needed a Chromium path fix local to this container (not a repo change).
- YC W27 on-time deadline: 2 Nov 2026, 8pm PT.
- Competitors researched: Muse, Instinct, Poke, Pally, Aside, Alexa+/Gemini (`COMPETITORS.md`).
- Pilot constraint found while writing `PILOT.md`: the app has no `audio` background mode, so sound listening
  only runs while Adam is open on screen. The kit works around it (Auto-Lock off, app open, plugged in); the
  fix is backlog A11.

**Shipped (branch `claude/friendly-hawking-mpwfnd`, not deployed)**
- `docs/yc/` — scorecard, competitors, application draft, pilot kit, backlog, this log.
- `api/services/traction-metrics.js`, `scripts/traction-report.js`, test — weekly actives, retention, executed vs
  failed actions, excluding test and named accounts.
- `GET /` serves a real page linking privacy, terms, support; test.
- Not-connected services: `Google is not connected. Connect it in Settings to use this.` plus
  `healthStatus: not_connected` and an `open_connector_settings` recovery; test.
- Real-database tests now skip with the reason when Supabase can't be reached (`test/support/real-database.js`;
  `OXY_REQUIRE_REAL_DB=1` makes that a failure). Suite here: **1,996 tests, 1,895 pass, 0 fail, 101 skipped**, in
  54 s instead of ~10 min of connection timeouts. On your Mac, with the real `.env`, they run as before.
- CI: `.github/workflows/test.yml` runs syntax check, undefined-reference lint and `npm test` on every push.

**⚑ Decisions**
- ⚑ **Wedge recommendation: "an agent that lives at home".** Reasoning and alternatives in `APPLICATION_W27.md`.
  Not applied to `PRODUCT.md`, `launch/` or the pitch — those wait for you.
- ⚑ **Branch.** `AGENTS.md` says work on `main`; this session is only permitted to push
  `claude/friendly-hawking-mpwfnd`. Merge it to `main` yourself.
- ⚑ **No deploy.** The environment's network policy blocks Fly, OpenAI and Supabase's REST host, and push ≠ deploy
  here. Nothing reaches production until you run `node scripts/deploy-fly.js`.
- ⚑ **Scoring weights** (users 30, founders 20, product 15, insight 15, application 10, model 5, hygiene 5) are my
  judgement of how YC reads an application. Change them in `SCORECARD.md` and the loop will follow.
- ⚑ **No co-author trailers** on commits, per `AGENTS.md`.
- ⚑ **Root page copy** reuses the pitch's line ("Give it the outcome. Adam does the legwork.") rather than the
  new wedge, so it doesn't get ahead of F5.

- ⚑ **Five offline-passing tests now skip offline** too, because the wrapper guards whole files. They still run
  wherever the database is reachable.

**Next:** A3 (offer to connect before attempting), then A7.

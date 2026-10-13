# YC readiness scorecard

**Score: 36 / 100** · last assessed 2026-10-13 (run 1) · YC W27 on-time deadline **2 Nov 2026, 8pm PT** (decisions by 11 Dec)

100 means: everything a solo founder could reasonably have in place for a strong YC application —
real users who come back, a sharp reason Adam wins, a truthful demo, a finished application.
It is not "the product is finished". Scores move only on evidence that can be pointed at.

## Rubric

| Area | Weight | Now | Evidence | What moves it |
|---|---|---|---|---|
| **Users and retention** | 30 | **3** | 38 people have ever messaged Adam. Peak 11 weekly active (week of 17 Aug). Since 7 Sep: 1 weekly active, the founder. 0 new accounts in 30 days. 0 paying. Of 39 non-founder people, 17 left after 1–2 messages; the 18 who sent 3–10 saw 23 of 33 actions fail, mostly "Google is disabled" (never connected). | Weekly actives other than you, week-over-week. 10 households using it is worth ~15 points; 4 weeks of retention ~10 more. |
| **Product works** | 15 | **9** | ~2,000 tests (here: 1,895 pass, 0 fail, 101 skipped — the real-database ones, which this container can't reach). Real browser checkouts, approval-gated payment with amount re-read, durable tasks, iOS app, household sound detection benchmarked against Apple. But John Lewis checkout attempts in Aug/Sep logged as failing; no recorded end-to-end demo. | A recorded, unedited run of the core loop working for a non-founder. |
| **Insight and differentiation** | 15 | **5** | Story has moved pendant → phone → home device; `launch/` copy still sells a fashion pendant; the 18 Sep pitch argues phone-first while the 8 Sep review and October commits are hardware/home-first. Meanwhile Muse (Meta, #1 App Store), Instinct ($10B), Poke ($300M, iMessage) own "text an agent that does errands". | One sentence that a YC partner can repeat, which none of those five can claim. See `COMPETITORS.md`. |
| **Founder and team** | 20 | **11** | Solo technical founder shipping at high speed across backend, iOS, ML and firmware (62 non-merge commits between 1 and 8 October). No cofounder. Founder story not written. | Written founder answers; a committed cofounder or first hire would move this most. |
| **Application and demo** | 10 | **2** | No YC application draft until this run. No demo video. 18 Sep pitch exists but contradicts later direction. | Finished application (4), 1-minute founder video (2), demo video (4). |
| **Business model** | 5 | **2** | £14.99/mo in Terms, nothing collecting money (`user_subscriptions` empty). No unit economics. | A price someone has paid, or a pilot with a stated price. |
| **Execution hygiene** | 5 | **4** | Deploy refuses on schema drift; evidence-before-claims culture; RLS deny-all on every table. CI workflow added this run (not yet seen green on GitHub). Public root URL served an error (fixed in code this run, not deployed). | CI green on GitHub; prod root page live. |

## Top blockers, in order

1. **Nobody but you uses Adam right now.** Everything else is secondary. The data says the August cohort didn't stall on intelligence — they stalled on setup (Google not connected) and on failures early in their first session.
2. **No single story.** Pick the wedge (recommendation in `APPLICATION_W27.md` §Decision) and make the repo, pitch and launch copy agree.
3. **No demo.** A 60–90 second unedited recording of one real outcome is the cheapest large gain on the board.

## History

| Date | Score | Change |
|---|---|---|
| 2026-10-13 | 36 | First assessment. |

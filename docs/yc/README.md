# YC push

Where the work toward a YC W27 application lives. Start with the scorecard, or the live dashboard:
https://claude.ai/artifact/CZBEz3HXVxhSjQCDALkwzx (private to you until you share it).

| File | What it is |
|---|---|
| [SCORECARD.md](SCORECARD.md) | The 0–100 number, how it's scored, the evidence, and its history |
| [RUN_LOG.md](RUN_LOG.md) | What each run did; ⚑ marks decisions you may want to reverse |
| [BACKLOG.md](BACKLOG.md) | Ranked next steps — yours and the loop's |
| [APPLICATION_W27.md](APPLICATION_W27.md) | Application draft; `[FOUNDER]` marks what only you can fill |
| [PILOT.md](PILOT.md) | How to run a 5–10 household pilot before 2 Nov |
| [COMPETITORS.md](COMPETITORS.md) | Muse, Instinct, Poke, Pally, Aside, Alexa+/Gemini — and where Adam is different |

Usage numbers: `OXY_TRACTION_EXCLUDE_USERS=<your user ids> node scripts/traction-report.js`.

A recurring loop picks the top unblocked agent item from the backlog every few hours, does it, re-scores, and
appends to the run log. To stop it, say so in the session, or disable the "Adam YC loop" routine
(`trig_01MWVeEzDzDTdXFxpF2RUr8j`, every 3 hours at :26 UTC; it ends itself after 3 Nov).

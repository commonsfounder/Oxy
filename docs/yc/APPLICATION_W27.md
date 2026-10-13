# YC W27 application — working draft

Deadline: **2 Nov 2026, 8pm PT** (on-time; decision by 11 Dec). Batch: Jan–Mar 2027, San Francisco.

How to use this: every answer is written from the repo and the production database as of the date in the
history table at the bottom. **[FOUNDER]** marks facts only you have. **[UPDATE]** marks numbers to refresh
from `node scripts/traction-report.js` the day you submit. Nothing here has been submitted.

---

## ⚑ Decision this draft depends on

**Wedge: an agent that lives at home.** Recommended over "a personal agent you text" because that category
now has Meta Muse (free, #1 App Store) and Instinct ($10B) in it, and over "hardware first" because a custom
device can't be proven in 20 days. The iPhone already runs Adam's household sound detection, so a spare phone on
a shelf is the pilot device — no hardware needed to test whether people want it.

Alternatives considered: (a) trust-first text agent — strong angle against Muse/Instinct's privacy problems, but
a feature the giants can copy; kept as the *reason* people let Adam in, not the headline. (b) browser/checkout
agent — Aside (YC F25) and Instinct are ahead and it's the area with the most logged failures. (c) pendant — the
`launch/` copy still sells this; nothing in October's work supports it.

If you disagree, the sections marked § below change; the rest stands.

---

## Company

**Company name:** Adam

**Describe what your company does in 50 characters or less.**
> An AI agent that lives at home and acts for you  *(48)*

**Company URL:** [FOUNDER] — the API host's root now serves a real page (`/`, with `/privacy`, `/terms`, `/support`) once deployed. A proper domain is still needed.

**Demo video:** [FOUNDER] Record before submitting. Suggested 90-second script at the end of this file.

**What is your company going to make? §**
> Adam is a personal agent that lives in the home. It listens for what matters there — smoke and CO alarms,
> a baby crying, glass breaking, someone at the door — and tells you, wherever you are. And it does the
> household's digital legwork: it works through websites, email, calendar and messages to finish a task, not
> just answer a question.
>
> Agents like Meta's Muse live in a chat thread. Speakers like Alexa live in the room but can't finish a job on
> the open web. Adam does both, and the thing that makes a household willing to let an agent in is built into
> the architecture: the model proposes actions, but code decides what is permitted. Payments wait for an
> approval that re-reads the amount off the live page, and nothing is reported as done until the result has
> been read back.
>
> Today it runs as an iPhone app with a Node backend. A spare iPhone at home is the first "device"; a
> dedicated home unit (ESP32-S3 prototype with our own on-device sound model) follows once people keep the
> phone version switched on.

## Progress

**How far along are you?**
> Working product in a private pilot. Backend in production on Fly.io, iOS app on TestFlight [FOUNDER: confirm
> TestFlight], ~2,000 automated tests. What works end to end today:
> - A general reasoning loop with checkpointing, resume after crash and approval parking — one runtime, no
>   per-task agents.
> - A browser agent that has completed real purchases in production, with spend caps and approval-gated payment.
> - Email, calendar, messaging (Telegram), maps, reminders, appointment booking, durable background watches.
> - Household sound detection on iPhone: smoke/CO alarms recognised by beep rhythm (Apple's classifier hears
>   alarm clocks as smoke alarms; ours doesn't), plus glass, knock, doorbell and baby crying with our own model.
>   In a 30-minute realistic stream it found 16 of 36 glass breaks vs Apple's 9, and 20 of 36 baby cries vs 13.
> - An on-device version of the sound model for the ESP32-S3 hardware, in progress.

**How long have each of you been working on this? How much of that has been full-time?**
> [FOUNDER] Production database created 30 Apr 2026; first user account 11 May 2026.

**What tech stack are you using?**
> Node.js/Express on Fly.io, Supabase Postgres (EU), Playwright browser sessions with optional per-user E2B
> sandboxes, OpenAI models via the Responses API, SwiftUI iOS app, Core ML and Apple SoundAnalysis on device,
> EfficientAT (MIT) fine-tuned and quantised for ESP32-S3, C for firmware.

**Are people using your product?** Yes, in a small way.

**How many active users or customers do you have? How many are paying? Who is paying the most?** [UPDATE]
> 38 accounts have sent Adam a message [FOUNDER: subtract your own test accounts and close friends]. Weekly actives peaked at 11 (week of 17 Aug), then fell to the
> founder alone through September while we rebuilt the agent loop. We learned why: of the people who stopped,
> most hit setup failures in their first session (asking about their calendar before connecting Google) rather
> than bad answers. We've fixed that path and are starting a household pilot on [DATE] with [N] homes.
> No revenue yet.

*Write the pilot sentence only once it is true. If the pilot hasn't started by submission, say so plainly — YC
reads an honest "we are pre-traction and here is what we learned" far better than a dressed-up number.*

**If you are applying with the same idea as a previous batch, did anything change?** [FOUNDER]

**If you have already participated or committed to participate in an incubator…** [FOUNDER]

## Idea

**Why did you pick this idea to work on? Do you have domain expertise? How do you know people need it?**
> [FOUNDER — the honest origin story. Strongest if it is a specific moment.] Then: what the August test taught
> you (setup is the cliff, not intelligence), and what the sound benchmarks taught you (off-the-shelf
> classifiers fail in real rooms — Apple caught 0 of 112 glass breaks under echo; ours caught 78, with 15 false alarms we are still driving down).

**What's new about what you're making? What substitutes do people resort to?**
> Substitutes: a smart speaker that can't finish a task; a phone agent that can't hear the house; dedicated
> alarms (Ring, Nest Protect) that alert but can't act; and doing the legwork yourself.
> What's new is the combination — presence in the home, follow-through on the open web, and authority that is
> enforced by code rather than promised by a model.

**Who are your competitors? What do you understand about your business that they don't?** §
> Meta Muse, Instinct and Poke are personal agents you message. Amazon Alexa+ and Google's Gemini speaker are
> in the room. We understand two things they've shown they don't:
> 1. Households will only hand an agent their accounts if its authority is legible. Muse is criticised for
>    building a dossier of unstated goals; Instinct for a perpetual data licence and acting after access was
>    revoked. Adam's permission is a deterministic boundary in code that the model cannot talk its way past.
> 2. The home is where an agent earns daily presence. A thread waits to be messaged; something in the room
>    can notice the alarm going off while you're out.
> Details and sources: `docs/yc/COMPETITORS.md`.

**How do or will you make money? How much could you make?**
> Subscription, £14.99/month (set in our Terms; not yet charging). Later, a home device sold at a margin with
> the subscription. Back-of-envelope: [FOUNDER — keep it to one honest line; e.g. UK+US households with
> young children × plausible conversion × price]. Instinct's merchant-commission model is a reason
> households distrust it; we will not take commissions on what Adam buys for you.

**Which category best applies?** Consumer / AI.

**If you had any other ideas you considered applying with, please list them.** [FOUNDER]

## Founders

[FOUNDER] for all of: names, roles, LinkedIn, education, employment, accomplishments, "something impressive
you've built or achieved", whether you're full-time, who writes code, how you met (if a cofounder joins),
equity split, location / visa.

Material to draw on for the "impressive" answer, from this repo: as a solo founder, built the agent runtime,
the browser agent, the iOS app, and a household sound model that beats Apple's on-device classifier in
real-room conditions — and is now fitting it onto a ~$50 ESP32-S3 board. 62 commits in the first 8 days of October.

## Equity, legal

[FOUNDER] Incorporated? Where? Any investment taken? Cap table.

---

## Demo video script (≤ 90 s, unedited, phone screen recording plus one room shot)

1. (0–20 s) A spare iPhone on a kitchen shelf. Play a smoke-alarm recording from across the room. Your own
   phone, in another room, shows the alert. Say nothing; let it happen.
2. (20–60 s) On your phone, one real task you have seen succeed live this week, end to end, including the
   approval step. Not the appointment flow: it runs against a sandbox practice, and the demo must be real.
3. (60–90 s) Open Activity: show the receipt — what Adam did, what it read back to verify it.

Do not cut between takes. If step 2 fails on camera, show the failure and the recovery; that is still a demo.

## History

| Date | Change |
|---|---|
| 2026-10-13 | First draft from repo + production data (run 1). |

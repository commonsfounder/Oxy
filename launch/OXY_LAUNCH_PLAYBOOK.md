# Oxy — Launch Execution Playbook

A literal, dated, do-this-then-that plan: **who to contact, when to post, what to do, which tool.**
Assumes: solo/tiny team · low budget · app at TestFlight stage · ~0 starting audience · UK-first ·
path = **validate → build audience → beta → Kickstarter for hardware.**

How to read it: each step is `[ ] ACTION — tool — output — done-when`. Artifacts marked **[READY]** are
already written for you in `WEEK_1_READY_TO_SEND.md` (just paste/send). Don't sprint to hardware before
the validation gate in Phase 1 passes — that's the whole point.

> The line: I draft and prepare everything. **You** click publish / send / pay. Anything outward-facing
> with your name on it stays a human action.

---

## Tool stack (set up once, Week 0)

| Job | Tool | Cost | Why this one |
|---|---|---|---|
| Landing + waitlist page | **Framer** (or Carrd if simpler) | free–£10/mo | fast, beautiful, fits a fashion brand |
| Email capture form | **Tally** | free | clean, embeds anywhere |
| Email list / newsletter | **Beehiiv** (or Resend for transactional) | free to start | build-in-public newsletter + broadcasts |
| Web + funnel analytics | **PostHog** (or Plausible) | free tier | see conversion + later in-app retention |
| Interview scheduling | **Calendly** | free | 1-click booking for user interviews |
| Short-form video edit | **CapCut** | free | TikTok/Reels demos |
| Post scheduling | **Typefully** (X) + **Buffer** (IG/TikTok) | free tier | write once, schedule a week |
| Visuals / shells / mockups | **Figma** + **Canva** | free | renders, carousels, thumbnails |
| Planning + CRM | **Notion** | free | content calendar + outreach tracker |
| Crowdfunding (later) | **Kickstarter** + **BackerKit** | % fee | hardware presale |

**Week 0 setup checklist**
- [ ] Claim handles everywhere: X, Instagram, TikTok, YouTube, LinkedIn, Reddit. Same name (`@oxy` or closest). — *output: consistent brand presence*
- [ ] Stand up landing page with the **[READY]** copy + Tally waitlist form. — *done-when: live URL collects emails*
- [ ] Install PostHog on the landing page. — *done-when: you can see visits + signups*
- [ ] Create the Notion board (columns: Backlog / This week / Posted / Outreach / Replied). 
- [ ] Set up Calendly "Oxy user chat — 20 min."

---

## Phase 1 — Validate demand (Weeks 1–3)  ← do NOT skip

Goal: prove a real, painful, frequent job exists and that strangers will give you their email (and ideally a deposit). Two tracks run in parallel: **talk to people** + **smoke test**.

### Track A — Customer interviews (target: 20 conversations)
The rule: never pitch. Ask about their real past behavior, not your idea. Script is **[READY]**.
- [ ] **Who to contact** (15–25 people fitting your ICP — busy people who live on their phone, want hands-free, care about how things look): your own network first, then DM strangers in the communities below. — *tool: DMs + Calendly*
- [ ] Recruit via: r/ (see list) · X replies · IG comments · friends-of-friends. Offer a £10 voucher if needed.
- [ ] Run 5 interviews/week using the **[READY]** Mom-Test script. Record (with consent) or take notes in Notion.
- [ ] **Gate to pass:** ≥40% describe the pain *unprompted* and have tried to solve it before. If they shrug, the job isn't real — pivot the angle before spending more.

### Track B — Landing-page smoke test
- [ ] Page live (Week 0). Headline = the **[READY]** value prop. Two CTAs: "Join waitlist" (email) and "Reserve — £1 deposit" (intent signal via Stripe payment link).
- [ ] Drive traffic: organic posts (Phase 2 cadence starts now) + optionally **£150 of TikTok/Meta ads** to a lookalike of your ICP.
- [ ] **Gate to pass:** ≥25–30% of visitors give an email; any £1 deposits at all = strong signal. Track in PostHog.

### Communities to contact (interviews + early audience)
Engage genuinely first, don't drop links cold:
- Reddit: r/gadgets, r/apple, r/ArtificialIntelligence, r/wearables, r/startups, r/SideProject, r/EDC, r/ProductivityApps
- Indie Hackers · Product Hunt (claim an "upcoming" page) · relevant Discords (AI tools, EDC, productivity)
- X: reply under AI-wearable + "second brain" + Humane/Rabbit post-mortem threads (high-intent lurkers there)

---

## Phase 2 — Build audience in public (Weeks 3–8, runs continuously)

Goal: turn the build into content, grow the waitlist to 500–1,000, find your early-adopter segment.

### Where + cadence
| Platform | Role | Cadence |
|---|---|---|
| **TikTok / IG Reels** | demos + fashion-tech visual hook (your differentiator) | 1 short/day, 5–7/wk |
| **X** | build-in-public, founder voice, AI-wearable takes | 1–2 posts/day + reply 15 min/day |
| **YouTube Shorts** | repost TikToks | mirror |
| **Beehiiv newsletter** | nurture the waitlist | 1 email/week |
| **LinkedIn** | credibility + investor/press surface | 2/week |

### What to post (rotate these 6 angles — first 7 are **[READY]**)
1. **Demo** — Oxy doing one real task, screen-recorded, < 20s.
2. **Why I'm building this** — the personal story / the gap.
3. **Fashion-tech teaser** — shells, renders, "AI you'd actually wear."
4. **Contrarian/insight** — "Why the Humane Pin failed and what it teaches" (you have a real POV from this build).
5. **Behind-the-scenes** — building, a bug, a decision, a metric.
6. **Ask/poll** — "what would you want it to do hands-free?" (also recruits interviews).

### Creator/influencer outreach (start Week 4)
- [ ] Build a list of **30 micro-influencers** (10k–100k) split: AI/tech reviewers + fashion/lifestyle. Track in Notion. — *who: search TikTok/IG for "AI gadgets", "tech wearables", "smart jewelry", UK tech creators*
- [ ] DM 5/week with the **[READY]** template. Goal: early units / collabs, not paid (yet).
- [ ] Keep a relationship log; follow up once after 5 days.

---

## Phase 3 — TestFlight beta (Weeks 8–12)

Goal: real retention data (ties directly to `docs/SHIP_READINESS_SOFTWARE_GAPS.md`).
- [ ] Invite top 100–200 waitlist signups to TestFlight. — *tool: App Store Connect + email broadcast*
- [ ] Weekly feedback loop: 1 in-app prompt + 3 user calls/week.
- [ ] Watch the **Day-7 / Day-30 retention** curve — this is the truth about whether people *want* it.
- [ ] Capture testimonial clips + screen recordings for the Kickstarter.
- [ ] **Gate to Kickstarter:** decent D30 retention + a waitlist that's still growing + ≥some deposits. If retention is poor, fix the product (use the gaps doc) before hardware.

---

## Phase 4 — Kickstarter for hardware (only after Phase 3 gate)

- [ ] Kickstarter **pre-launch page** up; drive the whole email list + audience to it for "notify me." — *tool: Kickstarter + Beehiiv*
- [ ] **Press outreach** (2–3 weeks before launch). Who to contact:
  - UK startup press: **Sifted, UKTN (UK Tech News), TechRound**
  - Tech/gadget: **The Verge, Wired, Stuff, TechRadar, Engadget, NewAtlas**
  - Newsletters/creators with a hardware/AI audience.
  - Use the **[READY]** press email; personalise the first line per writer.
- [ ] Launch-day playbook: email blast at 9am, post across all channels, reply to everything, post hourly milestone updates, mobilise the beta users to share.
- [ ] After funding: BackerKit for surveys/add-ons; manufacturing track (PCBA quote — JLCPCB; titanium supplier; charger prototype) per the overview roadmap.

---

## The weekly rhythm (pin this)

- **Mon:** plan week in Notion, schedule all posts (Typefully/Buffer), send newsletter.
- **Tue–Thu:** 2 user interviews/day this phase, 15 min community replies/day, 5 outreach DMs.
- **Fri:** review metrics in PostHog (signups, conversion, retention), write the "build-in-public" recap post.
- **Always:** every bug/decision/metric is potential content. Build in public = marketing for free.

## The metrics that actually matter (don't vanity-chase followers)
1. Waitlist signups/week and **email conversion %** on the landing page.
2. **£1 deposits** (intent that costs something).
3. Interview "unprompted pain" rate.
4. **D7 / D30 app retention** once on TestFlight.
5. Kickstarter pre-launch "notify me" count.

If 1–4 are weak, the market is telling you something — listen before building hardware.

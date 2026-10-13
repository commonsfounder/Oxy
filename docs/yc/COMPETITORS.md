# Competitors (checked 2026-10-13)

Sources are linked inline. Most coverage is launch press and secondary summaries; numbers marked
*reported* were not confirmed against a primary source.

## The field

| | What it is | Where you reach it | Scale / money | Known weak spots |
|---|---|---|---|---|
| **Meta Muse** | Personal agent for long-running tasks; each user's agent runs in its own VM. Launched 8 Sep 2026. | Muse app, macOS app control, agent email address, smart glasses (wake word). | #1 free app in US App Store, 5M+ downloads; free, Power $20/mo, Maximum $100/mo *reported*. | Time: "building a dossier on you" — infers goals "you have not said out loud". Encrypted mode promised, not shipped. No independent reliability data. [Meta](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) · [Time](https://time.com/article/2026/10/06/meta-muse-ai-agent-privacy/) · [CNBC](https://www.cnbc.com/2026/10/07/meta-muse-personal-ai-agents-dazzle.html) |
| **Instinct** (Spear Street Technology) | Errand agent on its own computer: travel, groceries, chasing threads, calls businesses for you. | Text, WhatsApp, phone call; own email addresses. | $1B at $10B (Sep 2026) after $2.5B in Aug; invite-only. Free to users, paid by merchant commission. | Perpetual licence to reuse user data; agent kept acting after access was revoked; unsolicited shopping suggestions tied to the commission model. [SiliconANGLE](https://siliconangle.com/2026/09/28/everyday-personal-ai-assistant-startup-instinct-raises-1b-at-10b-valuation/) · [aiweekly/TechCrunch](https://aiweekly.co/node/10806) · [runtimewire](https://runtimewire.com/article/instinct-unsolicited-shopping-recommendations-noah-shinn-commissions) |
| **Poke** (The Interaction Company) | Text-native assistant: schedules, smart home, photos, health goals. | iMessage (first approved AI agent on Messages for Business, Jun 2026), SMS, Telegram, WhatsApp. | ~$300M post *reported*; ~100M messages *reported*. Pays Apple per user. | Lives in a chat thread; no physical presence; depends on Apple's channel terms. [AppleInsider](https://appleinsider.com/articles/26/06/04/first-ai-agent-for-messages-business-chat-approved-by-apple) |
| **Pally** | Started as relationship manager, now a text-first assistant that acts after approval. | iMessage / RCS. | Free; Pro $25/mo *reported*. Funding figures conflict. | Small; deep account access is the whole product. [Product Hunt](https://www.producthunt.com/products/pally) |
| **Aside** (YC F25) | Chromium desktop browser whose agent works inside sites you're logged into; bring your own Claude/ChatGPT. | Desktop only. | 3 people; Free / $20 / $200 *reported*; vendor-reported benchmark leads. | Desktop-bound; an agent that runs until done needs a clear approval gate. [eesel review](https://www.eesel.ai/blog/aside-ai-browser-review) |
| **Alexa+ / Gemini for Home** | Generative assistant in existing speakers and displays. | The speaker. | Alexa+ free with Prime; Google's $99 Gemini speaker. | Weak at real follow-through on the open web; tied to one ecosystem. [Futurum](https://futurumgroup.com/insights/amazons-alexa-plus-takes-a-voice-first-design-with-ai) |

## What this means for Adam

**Do not compete on "text an agent that does errands".** That category now has a free product from Meta at #1 on the
App Store and a $10B startup. A solo founder cannot out-distribute either.

**Two things Adam has that none of the text agents do:**

1. **It can be in the room.** Every product above except the speakers lives in a chat thread or a browser. Adam
   already detects smoke and CO alarms by beep rhythm, plus glass breaking, knocking, doorbells and a baby crying,
   on an iPhone today and on BOX-3 hardware in progress — benchmarked against Apple's classifier (`docs/SOUND_HANDOFF.md`).
   The speakers have presence but can't finish a job on the open web; Adam can.
2. **Its authority is deterministic and visible.** Muse's dossier, Instinct's perpetual licence and post-revocation
   actions are exactly the fears that keep a household from handing over its accounts. Adam's permission is decided
   by code at one execution boundary (`api/services/action-execution.js`), never by the model; money waits for an
   approval that re-reads the amount off the live page; "done" means the resulting state was read back.

**Positioning that combines them:** an agent that lives at home, notices what happens there, and handles what
follows — with authority you can see. That is a different product from Muse and Instinct, and a different
capability from Alexa.

**What this still has to prove:** that households want the in-room part enough to leave it on, and that the
follow-through is reliable for people other than the founder. Those are pilot questions, not pitch questions.

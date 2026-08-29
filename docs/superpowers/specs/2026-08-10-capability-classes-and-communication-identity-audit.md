# Capability Classes & Communication Identity — Audit

**Date:** 2026-08-10
**Status:** Research + recommendation. No provider committed, no implementation started.

This audit answers seven questions: (1) which phone provider, (2) what a number does and does not unlock across SMS/voice/WhatsApp/Telegram/iMessage, (3) the safe role of verification codes, (4) how far Adam's browser/work capability is from ChatGPT Work / Codex, (5) an outcome-level capability gap audit, (6) the small set of primitives that unlock the most, (7) the next implementation pass.

---

## 0. Where the code actually is today

Facts established by reading the repo, not by memory:

| Thing | State |
|---|---|
| `api/services/adam-identity.js` | Exists. Identity + per-channel handles, idempotent provisioning. |
| `connectors/adam-email-resend.js` | Exists. Outbound + inbound parse + signature line. |
| `connectors/adam-sms-twilio.js` | Exists. `provisionPhoneNumber`, `sendAdamSms`, `parseInboundSmsPayload`. 69 lines, plain REST. |
| `POST /webhooks/millie-email`, `POST /webhooks/millie-sms` | Both wired in `api/index.js` (lines 415, 496). |
| `send_adam_email`, `send_adam_sms` actions | Both in `executeAction` (lines 2885, 2940), both review-gated. |
| `external_conversations` / `_events` | Built. Channel-agnostic thread, encrypted bodies, `last_inbound_at`/`last_outbound_at`/`next_follow_up_at` reserved. |
| Twilio credentials | **Empty placeholders** in `cloudrun.env.example.yaml`. No account. |
| `MILLIE_EMAIL_DOMAIN` | Not in the env example at all. No domain. |
| Phone provisioning at signup | Deliberately off — every call site passes `attemptPhone: false`. |

**So: the phone identity is code-complete and provider-dead.** Nothing has ever been provisioned. That is the good news — we are choosing a provider with the abstraction already written, exactly the position the brief asked for.

**Provider-lock risk that does exist:** `adam-identity.js` hardcodes `provider: 'twilio'` on the handle row, and `api/index.js` `require`s `../connectors/adam-sms-twilio` directly from the action case. That is one small seam away from being provider-agnostic, and it is the low-regret foundational work worth doing regardless of which provider wins.

Other load-bearing facts about the current agent:

- **108 action contracts** in `api/action-contracts.js`. This is the "app with 87 tools" the brief warns about, already exceeded.
- **`browser-task.js` is 6,045 lines and shaped as a shopping loop.** Its whole action vocabulary is `['click', 'fill', 'select', 'back', 'wait', 'ask', 'done', 'ready_for_payment']` plus `navigate` (line 1268). There is an `isOrder` latch threaded through ~30 call sites, retailer-specific recipes, a checkout profile, and a payment-ready state. It is very good at buying things and structurally not a general work agent.
- **Browser sessions die after 20 minutes idle** (`SESSION_IDLE_MS`, line 348). There is no resumable long-running browser work.
- **There is no file capability anywhere.** No binary store, no Supabase storage bucket, no email attachments in or out, no browser file upload (`setInputFiles` appears zero times), no browser download handling. `agent-workspace.js` validates content as text and stores rows in Postgres. `multer` exists only for in-memory chat image upload.
- **Telegram is not a bot.** `connectors/telegram.js` uses GramJS/MTProto with a `StringSession` — it is logged into *the user's own* Telegram account. This matters a lot in §2.

---

## 1. Phone provider audit

### What we actually need

Ranked by how much each affects the decision:

1. **UK mobile (+447) numbers** — not local/national. Mobile numbers are the ones businesses text back without thinking, the ones application forms accept, and the ones with the least-bad OTP acceptance. A +4433 national number in a "mobile" field gets rejected or silently never contacted.
2. **Two-way SMS, inbound-first.** The whole thesis is that Adam is *reachable*.
3. **A voice path that isn't a dead end** — programmable voice, streaming media, DTMF, and transfer-to-human.
4. **API provisioning + webhooks** — already assumed by the code.
5. **Per-user economics that survive scale.**
6. **Regulatory durability** — a number we keep, on an account that doesn't get suspended.

### Findings

**Twilio**

- UK offers three types: local/national (+4433), **mobile (+447)**, and toll-free (+44808/+44800). ([Twilio UK regulatory guidelines](https://www.twilio.com/en-us/guidelines/gb/regulatory))
- **The regulatory asymmetry is the single most useful fact in this audit:** UK *local* numbers require a valid UK address with documentary proof of address. UK **mobile and toll-free numbers require only government ID, and the address "may be anywhere in the world"** — no UK proof-of-address, no local-presence hurdle. The number type we want is also the easier one to provision.
- Since 30 September 2024, every UK long code (local, national, mobile, toll-free) must be attached to an approved UK Regulatory Compliance bundle before messaging or voice will work. The KYC contact number must be a real mobile *not acquired from a CPaaS provider* — i.e. a founder's own phone. ([Twilio UK KYC](https://help.manychat.com/hc/en-us/articles/15618454726172-New-KYC-requirements-for-Twilio-in-the-UK-What-you-need-to-know), [Reading the UK bundle](https://www.twilio.com/docs/phone-numbers/regulatory/reading-regulations-for-the-uk-bundle))
- UK long codes support **two-way SMS with sender ID preserved**. Alphanumeric sender IDs exist but are effectively one-way and useless to us — we need replies. The UK has **no mandatory pre-registration** for ordinary long-code A2P today, unlike US 10DLC. ([Twilio UK SMS guidelines](https://www.twilio.com/en-us/guidelines/gb/sms))
- Pricing, from Twilio's own page: **UK mobile number $2.50/month**, UK local $1.15/month, **outbound SMS $0.056**, **inbound SMS $0.0075**. ([Twilio UK SMS pricing](https://www.twilio.com/en-us/sms/pricing/gb))
- Voice: the most mature route to a real voice agent. Twilio publishes a step-by-step integration of the **OpenAI Realtime SIP connector over Elastic SIP Trunking**, and a **warm transfer to a human agent** tutorial via Programmable SIP — which is exactly the "escalate to the user" primitive the brief asks for. ([Twilio × OpenAI Realtime](https://www.twilio.com/en-us/blog/developers/tutorials/product/openai-realtime-api-elastic-sip-trunking), [warm transfer](https://www.twilio.com/en-us/blog/developers/tutorials/product/warm-transfer-openai-realtime-programmable-sip))

**Telnyx**

- Owns its own global IP network rather than reselling, which is why its rates are materially lower — UK numbers advertised from **$1.00/month plus $0.10/month to enable SMS**, and voice per-minute rates roughly half Twilio's. ([Telnyx UK numbers](https://telnyx.com/phone-numbers/united-kingdom), [Telnyx pricing](https://telnyx.com/pricing/messaging))
- Routes to OpenAI's Realtime SIP endpoint and supports Opus (mandatory for that bridge). Independent June 2026 testing put Telnyx p95 media latency at ~118ms vs Twilio ~161ms — a real advantage once you stack STT/LLM/TTS against the ~800ms conversational threshold. ([Voice agent telephony comparison](https://techsy.io/en/blog/voice-agent-telephony-comparison), [Telnyx vs Twilio voice](https://telnyx.com/resources/telnyx-vs-twilio-which-voice-api-is-better))
- **I could not confirm from a primary source that Telnyx sells UK *mobile* (+447) numbers with two-way SMS.** Their UK page advertises numbers "from $1" without breaking out type. This is the pivotal unknown, and it is not a detail — if Telnyx is local/national-only in the UK, it fails requirement #1 outright.

**Vonage** — telco-grade SLAs and the deepest carrier relationships across Europe/Asia; genuinely good for global enterprise routes. But the API and docs are the weakest of the three for agentic voice, and there is no cost advantage to offset that. No reason to pick it for this.

**Sinch** — enterprise/high-volume messaging aggregator. Contract-and-account-manager shaped rather than self-serve. Wrong stage for us.

### Recommendation

**Provision on Twilio. Build a provider adapter seam in the same pass. Re-decide at scale on a fact we don't have yet.**

The reasoning, in order:

1. Twilio is the only provider where I can confirm from primary sources that **UK mobile numbers exist, are two-way SMS capable, and are provisionable by an individual with no UK proof-of-address**. That is the requirement everything else hangs off.
2. The voice path is documented end-to-end, including transfer-to-human. We are not building voice now, but this is the box-out risk the brief specifically told me to avoid, and Twilio is where it's already closed.
3. Twilio is the expensive option and I am not choosing it because the SDK is easy — we aren't even using the SDK (the existing connector is plain `axios` REST, deliberately). I'm choosing it because it's the one that provably clears the hard requirement.
4. **At scale, $2.50/month/user for a number is a real cost** and Telnyx would roughly halve it. So the seam matters, and there's a concrete task: get Telnyx to confirm UK mobile inventory + two-way SMS + rates in writing. If they do, the migration is one adapter file.

### The economics decision that actually matters

Not "which vendor" — **how many numbers**.

At $2.50/month/user, a dedicated UK mobile per user is ~$30/user/year in fixed cost before a single message. That is not obviously wrong for a premium product, but it is wrong to pay it for every user on day one.

The insight: **a shared number works for everything Adam starts, and only fails for cold inbound.**

- When Adam texts a business first, the reply resolves cleanly — inbound from that number matches an open conversation with that participant. `participant_addresses_lookup_idx` already exists for exactly this lookup.
- It only breaks when a business contacts a number **cold** — because the user put it on an application form, gave it to a courier, or handed it to a recruiter. Then there's no prior thread, and a shared number can't tell which user it's for.

So: **shared regional pool by default, promoted to a dedicated number when a workflow needs a stable contact number to hand out.** The promotion trigger is a real product event ("this application wants a phone number"), the cost lands only on users doing work that needs it, and the data model already supports both — a handle is a row, not a schema assumption.

Collision case to handle honestly: two users with open conversations to the *same* business number on the shared pool. Detectable, and the right behaviour is to treat it as ambiguous and surface rather than guess.

---

## 2. What a phone number actually unlocks — channel by channel

The brief was right to demand precision here. One number does **not** give us five channels.

| Channel | Does Adam's own number unlock it? | Reality |
|---|---|---|
| **SMS** | **Yes** | This is the real unlock. Two-way, inbound-first, works today with the existing code once a number exists. |
| **Voice** | **Yes, eventually** | Same number, programmable voice. Inbound/outbound, DTMF, recording/transcription where lawful, streaming, transfer-to-human. Not blocked by the provider choice. |
| **WhatsApp** | **Effectively no** | Two separate walls. (a) WhatsApp verification rejects VoIP/virtual numbers; a Twilio number *can* register only if it can receive the SMS/voice OTP, and numbers behind IVR/computer-operated systems can't complete it. (b) The policy wall is worse: from 21 May 2026 businesses must hold **opt-in before messaging anyone**, and every message outside the 24-hour service window must use a **Meta-approved template**. Adam cold-messaging a garage on a user's behalf is exactly what that policy forbids. WhatsApp is a channel for *businesses messaging their own customers* — it is not a channel for an assistant to contact arbitrary businesses. ([Twilio WhatsApp docs](https://www.twilio.com/docs/whatsapp/api), [opt-in policy](https://developers.facebook.com/documentation/business-messaging/whatsapp/getting-opt-in)) |
| **Telegram** | **No — and it already works another way** | Bots need no phone number at all. Registering a Adam *user account* needs one, and Telegram flags/bans VoIP-originated numbers — that's exactly the "shady SIM farm" territory the brief rules out. **But we don't need to:** `connectors/telegram.js` is GramJS/MTProto logged into the *user's own* Telegram account. Telegram is already solved, decoupled from Adam's number, and should stay that way. Worth being clear internally: today's Telegram is a *user↔Adam* channel using the user's identity, not a *Adam↔business* channel. |
| **iMessage / Apple Messages for Business** | **No** | Not a number feature at all. Requires brand registration in Apple Business Register, an Apple-approved Messaging Service Provider, an admin + technical contact + sponsoring executive, and a commitment to provide **live human agents during business hours** — Apple explicitly prohibits bot-only solutions. It is also inbound-only by design: customers message the brand. Structurally incompatible with a personal agent. ([Apple MFB registration](https://register.apple.com/resources/messages/messaging-documentation/register-your-acct), [policies](https://register.apple.com/resources/messages/messaging-documentation/policies)) |
| **RCS** | Not now | Same brand-verification shape as the above. Revisit only if SMS deliverability becomes a problem. |

**The honest summary: a Adam number buys SMS and voice. That's it — and that is enough, because SMS and voice are the two channels the external world actually uses to reach a person.** Every business, courier, surgery, garage, recruiter and application portal in the UK can text or call a mobile number. None of them will WhatsApp you unprompted.

---

## 3. Verification codes — the safe design

The product concept is legitimate and worth stating precisely, because the difference between it and the prohibited thing is narrow:

> **Allowed:** Adam receives a message sent to *Adam's own number*, and uses it to advance a workflow the user explicitly delegated in this session.
>
> **Not this:** collecting the user's codes, reading codes from the user's own phone, or using a code to get past a control that exists to stop an agent.

### Binding rules

A code is only usable if **all** of these hold:

1. There is an **active delegated workflow** in an explicit `awaiting_verification` state.
2. That workflow **declared it was expecting a code** *before* the message arrived — the expectation is registered at the moment Adam submits the form, not inferred afterwards.
3. It arrives inside a **short window** (10 minutes) of that declaration.
4. The **sender plausibly matches** the service the workflow is transacting with.
5. **Exactly one** workflow is waiting. Two candidates means ambiguous, means don't consume — surface it.

Unmatched code arrives → log **metadata only** (sender, arrival time, "looked like a verification message"), never the code itself, and never surface it. An unmatched code is not ours to use.

### Handling rules

- **Never persisted in the conversation log.** The existing `external_conversation_events` path would encrypt-and-store it, which is exactly wrong — the whole point is that it should not still exist in ten minutes. Codes take a separate short-TTL path with hard expiry, not the durable thread.
- **Redacted at the boundary**: out of logs, out of any error message, out of any prompt beyond the single tool call that types it into the field, and out of anything rendered to the user.
- **One-shot.** Bound to one workflow, marked consumed, unreadable a second time.
- **A code advances a step; it never clears a gate.** If the next action is consequential — a payment, a submission, a legal declaration — the existing review gate still fires. A code arriving means "the form accepted us," not "the user approved this."
- **Categorical refusal:** codes that appear to be bank/payment-authentication for anything outside the delegated flow are dropped, not surfaced, not used.

### The reality we must not oversell

**Many platforms will reject a CPaaS number outright**, and no legitimate provider gets around that — the strict cases (banks especially) are structurally required to bind to carrier-registered SIM lines. UK mobile (+447) numbers on a reputable CPaaS are the *best available* posture, meaningfully better than local/national or a "virtual number" service, but coverage is partial and always will be.

**We should never promise universal OTP compatibility.** The correct product framing is that Adam's number is a **contact number that also happens to be able to receive verification messages when the service allows it** — and when a service rejects it, Adam says so and asks the user to supply the code from their own phone. That failure mode is fine. It only becomes a problem if we designed as though it wouldn't happen.

---

## 4. The work/computer-use gap vs ChatGPT Work / Codex

The right question, per the brief, is not which API is missing. It's: *what can those environments do because they can manipulate a workspace?*

| Capability class | Adam today | Gap |
|---|---|---|
| Working through complex websites | `run_browser_task` — real, live-verified, with learned recipes and a platform-API fast path | **Shaped as a shopping loop.** `isOrder` latch, checkout profile, `ready_for_payment` state, retailer recipes. A 9-page insurance quote funnel is not an order and falls to the generic path. |
| Creating/editing files | `workspace_write/read/list` — **text only**, stored as Postgres rows | No binary. No real files. |
| Filling forms | `fill` + `select` actions, checkout profile autofill, vault credentials for login | Good, and the most transferable thing we have. Field semantics are commerce-tuned. |
| Handling uploaded documents | **Nothing** | `multer` in-memory for chat images only. No store, no persistence, no retrieval. |
| Downloading / re-uploading documents | **Nothing** | `setInputFiles` appears zero times in 6,045 lines. Cannot upload a CV. Cannot save a policy PDF. Cannot fetch a returns label. |
| Transforming files | **Nothing** | No PDF read, no doc→form extraction. |
| Multi-page applications | Partially | 20-minute idle session death (`SESSION_IDLE_MS`). A form that needs a document the user hasn't sent yet cannot be paused and resumed. |
| Long-task project state | **Strong** — `agent_tasks`, `task_steps`, commitments, watches, scheduled tasks, `external_conversations` | Genuinely one of the better parts of this codebase. Underused. |
| Running code/tools | `project_*` actions exist | Dev-shaped, not user-work-shaped. Fine. |
| Interpreting screenshots/pages | Yes — vision loop over JPEG screenshots + extracted elements | Solid primitive. |
| Sites with no API | Yes, that's the browser | Same commerce-shaping caveat. |
| User's cloud documents | Google Docs + Notion connectors (create/append/search) | Read/write text. No Drive files, no PDFs, no attachments. |
| Sequential workflows, next action unknown | The agentic loop does this | Within one session. Not across days. |

**Two structural gaps, and they compound.**

**Gap A — there are no files.** Not "we should add a file connector": there is no representation of a document anywhere in this system. Every one of the brief's examples runs into it. Insurance renewal produces a policy PDF and a certificate. A claim needs receipts and photos. An application needs a CV and proof of address. A return needs a label. Travel produces boarding passes and bookings. Adam can read the *email* that mentions a document and cannot touch the document.

**Gap B — browser work is a sprint, not a project.** Twenty minutes, one goal, commerce-shaped. The brief's examples are all multi-day: apply → wait for a reply → upload something → wait → later stages. Nothing in the current design survives a wait.

**And this is where the "87 tools" worry gets its real answer.** We have 108 action contracts, and the capability jump is not tool 109. It's that a general work loop with file handling collapses whole *rows* of that table — `search_amazon`, the retailer recipes, the per-site special cases, half the document-adjacent connectors — into "go do the thing on the website, and here are the files."

---

## 5. Outcome-level capability gap audit

Blocker key: **DOC** documents/files · **BRW** browser/computer depth · **PHN** phone identity · **VOI** voice · **PAY** payment · **ACC** external account · **MEM** state/memory · **SAF** review/safety

| # | "Sort this out for me" | Adam can already | Blocked by | General or bespoke? | Value | Freq | Diff |
|---|---|---|---|---|---|---|---|
| 1 | **Sort out my car insurance renewal** | Find the renewal email, read the policy terms in-body, remember the date, search alternatives, hold payment | **DOC** (policy PDF, certificate, no-claims proof), **BRW** (multi-page quote funnels, aggregator bot-walls), **PHN** (quote forms require a number; insurers call back) | ~85% general | Very high (£100s) | 1×/yr per policy, 3–4 policies | Very high |
| 2 | **Deal with this claim / dispute** | Reconstruct correspondence from Gmail, track case state, draft chases, track deadlines via commitments+watches | **DOC** (receipts, photos, letters), **PHN** (claim lines text updates), partly **MEM** (case state isn't linked to the user's own email threads) | ~90% general | Very high | Several/yr | Very high |
| 3 | **Apply for this** (job, permit, school, benefit, tenancy) | Read the listing (`search_jobs` MCP exists), hold a profile, fill fields, ask when genuinely stuck | **DOC** (CV/passport/payslip upload — hard blocker), **BRW** (multi-page, multi-day), **PHN** (phone field + recruiter callbacks), **MEM** (weeks-long state) | ~90% general | Very high | Bursty | **Highest** |
| 4 | **Household & government admin** (council tax, DVLA, TV licence, tenancy) | Some browser work, deadlines, reminders | **DOC**, **BRW**, **ACC** (gov identity), **PHN** | ~75% general | High | Steady | High |
| 5 | **Handle this return / refund** | Find the order, email the retailer, track the outcome | **DOC** (returns label PDF), **BRW** (returns portals), **PHN** (courier SMS) | ~90% general | Medium-high | Monthly | Medium |
| 6 | **Get everything sorted for my trip** | **Strongest today** — real flight+hotel search, itinerary engine, calendar, weather, watches, exact-date integrity | **DOC** (boarding passes, visas, confirmations), **PHN** (airline disruption texts go to a phone, not an inbox) | ~70% general | High | 2–6×/yr | Medium (crowded) |
| 7 | **Audit and cancel my subscriptions** | Detect recurring spend (`find_spend`, receipts), surface them | **BRW** (retention/dark-pattern flows), **VOI** (some are phone-only), **SAF** | ~80% general | Medium-high | 1–2×/yr, high value | Medium |
| 8 | **Switch my bills** (energy, broadband, mobile) | Same shape as #1 | **DOC**, **BRW**, **PHN** | ~85% general | High | 1×/yr each | High |
| 9 | **Book/move this appointment** (dentist, GP, garage) | `book_appointment`, `find_appointment_options`, calendar, cancellation | **VOI** — a large share of UK surgeries and garages are phone-only. This is the clearest voice-only outcome. | ~40% general, needs voice | High | Monthly | **Very high** (nobody does this) |
| 10 | **Deal with this delivery** | Track packages, read courier emails | **PHN** (couriers text, not email), plus a narrow authorized-reply capability ("reply 1 to leave with neighbour") | ~95% general | Medium | Weekly | High |
| 11 | **After-purchase support / warranty** | Correspondence, case state, chases | **DOC** (receipt, warranty), **PHN**, **VOI** | ~90% general | Medium | Occasional | Medium |
| 12 | **Personal finance admin** (ISA transfer, pension consolidation) | Read statements in email, track deadlines | **DOC**, **ACC**, **SAF** (high consequence, correctly gated) | ~70% general | Very high £ | Rare | Medium |
| 13 | **Job search end-to-end** | `search_jobs`, profile, drafting | **DOC** (CV tailoring + upload), **BRW**, **PHN** (recruiters phone) | ~85% general | High | Bursty, intense | High |
| 14 | **Medical admin** (prescriptions, referrals, results) | Reminders, calendar | **VOI**, **ACC** (NHS login), **SAF** (sensitive) | ~50% general | High | Steady | Medium — proceed carefully |

### Ranking

**Tier 1 — build for these:** #3 Applications, #1 Insurance renewal, #2 Claims/disputes.
They are the highest-value, most-differentiated, and — critically — they share *the same blockers in the same order*: documents, then durable browser work, then phone. Solve those three primitives and all three outcomes move together. This is the capability jump.

**Tier 2 — mostly free once Tier 1 lands:** #8 Bills, #5 Returns, #10 Deliveries, #13 Job search, #4 Household admin.

**Tier 3 — different primitive (voice):** #9 Appointments, #7 Subscription cancellation, #11 Warranty escalation. Highest differentiation of anything here. Deliberately later.

**Tier 4 — deepen rather than start:** #6 Travel (already good; documents + phone finish it), #12 Finance and #14 Medical (real value, but the right gate is caution, not capability).

**The pattern worth naming:** across 14 outcomes, **DOC is a blocker in 11**, **BRW in 9**, **PHN in 9**. Not one of them is blocked by a missing named integration. The brief's instinct is correct and the data supports it.

---

## 6. The five primitives

**P1 — Documents & files.** A real object store (Supabase Storage), a `documents` table with provenance and per-user scoping, PDF/image extraction, email attachments in and out, and — the part that makes it agentic rather than a filing cabinet — **`upload` and `download` actions in the browser loop**. This is the single largest unlock: it appears in 11 of 14 outcomes and it is currently a *zero*, not a weakness.

**P2 — Durable, general browser work.** Split the general work loop out from the commerce loop. Longer and resumable sessions with persisted storage state; a checkpoint/resume model so a multi-day application survives a wait; `upload`/`download`/`scroll` in the action vocabulary; and stop making everything inherit the `isOrder` shape. Not a rewrite of `browser-task.js` — a second goal mode alongside it, sharing the vision loop and element extraction.

**P3 — Communication identity (phone).** Inbound-first. A UK mobile number, shared-pool by default, promoted to dedicated when a workflow needs a number to hand out. The code exists; this is provider + seam + pool policy.

**P4 — Responsibility state.** A durable "Adam owns this outcome" object that outlives the turn and owns: the goal, the correspondence, the documents, the deadlines, **who owes the next action**, and what would count as done. `agent_tasks` + `task_steps` + `external_conversations` + commitments + watches are ~70% of this already, sitting unassembled. This is mostly composition, not construction — and it's what turns "did a task" into "has responsibility."

**P5 — Voice.** Not now. The only requirement on this pass is that the provider choice doesn't box it out — Twilio's programmable voice + OpenAI Realtime SIP + warm transfer path satisfies that, so P5 costs us nothing today.

**Design principle to hold, as the brief asks:** every future requirement should first be tested against these five. Almost everything in §5 is one of them wearing a costume.

---

## 7. Proposed next implementation pass

Ordered so each step is independently useful and nothing is a bet on the step after it.

**Pass A — Provider seam + provision one number** *(small, low-regret, unblocks the real learning)*
1. Extract a phone-provider adapter interface; make `provider` on the handle row meaningful instead of a hardcoded `'twilio'`; move the direct `require('../connectors/adam-sms-twilio')` in `api/index.js` behind it.
2. Open a Twilio account, complete the UK Regulatory Compliance bundle (needs a government ID and a personal mobile that isn't CPaaS-issued — **this is on you, not me**), provision **one UK mobile number**, point both existing webhooks at it.
3. Prove it end-to-end against a real phone: outbound send, inbound receive, thread matching. Live evidence, per AGENTS.md.
4. In parallel, get Telnyx to confirm UK mobile inventory + two-way SMS + rates in writing.

**Pass B — Documents** *(the big unlock)*
5. Object store + `documents` table + provenance + retention policy entry.
6. Email attachments in and out; document extraction (PDF/image → text/fields).
7. **`upload` and `download` actions in the browser loop.** This is the step that converts a filing cabinet into a capability.

**Pass C — Durable work sessions**
8. General work goal mode alongside the order mode; persisted session state; checkpoint/resume across days.

**Pass D — Responsibility objects**
9. Compose the existing task/conversation/commitment/watch pieces into one durable outcome object with a next-action owner.

**Pass E — Verification codes** — after A and C, since it depends on a workflow that can declare `awaiting_verification`. Small once those exist.

**Deferred: voice.** Unblocked by Pass A, built when Tier-3 outcomes come up the list.

### What I need from you before Pass A

- **Twilio account + UK RC bundle** requires your government ID and a personal mobile. I can write every line of the adapter; I cannot open the account.
- **`MILLIE_EMAIL_DOMAIN` is still unset and there's no Resend domain.** Adam's email is code-complete and has never sent a message from her own address. Worth closing in the same pass — it's the cheaper half of the same identity.

---

## Sources

- [Twilio — United Kingdom regulatory guidelines](https://www.twilio.com/en-us/guidelines/gb/regulatory)
- [Twilio — United Kingdom SMS guidelines](https://www.twilio.com/en-us/guidelines/gb/sms)
- [Twilio — UK SMS pricing](https://www.twilio.com/en-us/sms/pricing/gb)
- [Twilio — Reading regulations for the UK bundle](https://www.twilio.com/docs/phone-numbers/regulatory/reading-regulations-for-the-uk-bundle)
- [Twilio — New KYC requirements in the UK](https://help.manychat.com/hc/en-us/articles/15618454726172-New-KYC-requirements-for-Twilio-in-the-UK-What-you-need-to-know)
- [Twilio — OpenAI Realtime SIP over Elastic SIP Trunking](https://www.twilio.com/en-us/blog/developers/tutorials/product/openai-realtime-api-elastic-sip-trunking)
- [Twilio — Warm transfer to a human agent with OpenAI Realtime](https://www.twilio.com/en-us/blog/developers/tutorials/product/warm-transfer-openai-realtime-programmable-sip)
- [Twilio — WhatsApp Business Platform](https://www.twilio.com/docs/whatsapp/api)
- [Telnyx — United Kingdom phone numbers](https://telnyx.com/phone-numbers/united-kingdom)
- [Telnyx — SMS and MMS pricing](https://telnyx.com/pricing/messaging)
- [Telnyx vs Twilio voice API](https://telnyx.com/resources/telnyx-vs-twilio-which-voice-api-is-better)
- [Voice agent telephony: Twilio vs Vonage vs Telnyx 2026](https://techsy.io/en/blog/voice-agent-telephony-comparison)
- [Meta — Get opt-in for WhatsApp](https://developers.facebook.com/documentation/business-messaging/whatsapp/getting-opt-in)
- [Apple Messages for Business — register your account](https://register.apple.com/resources/messages/messaging-documentation/register-your-acct)
- [Apple Messages for Business — policies](https://register.apple.com/resources/messages/messaging-documentation/policies)
- [Ofcom consultation on mobile messaging scams (MEF analysis)](https://mobileecosystemforum.com/2025/11/05/the-uks-messaging-firewall-analysing-ofcoms-new-consultation-on-mobile-scams/)

---

# Addendum — Pass 1 complete: can Adam apply for a job?

**Date:** 2026-08-10, after the four Files/Documents commits
(`c10d28ed`, `a27e3415`, `09df23c3`, `b705800a`).

The honest answer is **no, not yet — three concrete blockers**, and two of them are exactly
Pass 2's scope. That is a good result: it means the ordering was right, not that the pass
fell short.

| Step in "apply for a job" | State | Evidence |
|---|---|---|
| Identify what the application needs | **Works, weakly** | The vision loop reads "Upload your CV (PDF)" off the page. No dedicated capability required. |
| Find the CV | **Works** | `findDocuments` is loaded lazily into the prompt as an `AVAILABLE DOCUMENTS` block, ids only. |
| Create a tailored version | **BLOCKED** | `createDerivedDocument` can *store* derived bytes and version them correctly. Nothing *produces* those bytes — there is no way to author a PDF or DOCX. `workspace_write` writes text into Postgres rows, not files. |
| Upload it | **Works** | `upload` action → `setInputFiles` from a buffer, id-resolved, workflow-guarded. |
| Download a form, fill it | **Half** | `download` works and carries provenance. Filling a *downloaded* PDF is the same missing capability as authoring one. |
| Save application evidence | **GAP** | A confirmation page is not a download. Screenshots exist inside the loop but are never stored as documents, so "here is proof I applied on the 10th" cannot be produced. |
| Remember status / resume later | **BLOCKED** | Two parts. (a) `session.agentTaskId` is *read* by the download/upload dispatch and **never set anywhere** — so every file fetched during a browser task lands with `agent_task_id: null`, and the cross-workflow guard has nothing to guard on in the browser path. (b) Sessions still die at 20 minutes idle with no checkpoint. |
| Ask only when genuinely stuck | **Works** | The `ask` action. |
| Pause before consequential submission | **GAP** | `ready_for_payment` is the only pause, and it is order-shaped. A non-order goal has no "stop before you press Submit" gate. |

## What this means for Pass 2

Three of the five gaps are one thing wearing different clothes: **there is no durable workflow
object that the browser session, the documents and the review gate all point at.** That is
precisely the Pass 2 primitive. Concretely it must:

1. **Own `agentTaskId` and bind it to the browser session**, so downloads attach to the work
   that caused them and the workflow guard becomes real rather than vacuous.
2. **Checkpoint objective / current step / required documents / completed actions / blockers /
   next action** durably, so a dead session reopens the site and reconstructs, per the
   standing instruction that the durable thing is the workflow and not the tab.
3. **Generalize the pause.** `ready_for_payment` becomes one case of a general
   "awaiting_review before a consequential act" — submissions and declarations included.

The remaining two are a separate, smaller piece worth doing inside Pass 2 rather than
deferring:

4. **Document authoring** — produce a DOCX/PDF from text so a tailored CV can exist. DOCX is
   reachable with `fflate` alone (a DOCX is a zip of XML, and the extractor already proves
   the shape), so this needs no new dependency.
5. **Page-as-evidence** — store a screenshot or page snapshot as a `generated` document, which
   is a few lines given the loop already captures JPEGs every step.

Nothing here needs a new integration, and nothing needs the phone. The ordering holds.

---

# Addendum 2 — Pass 2 complete: what the workflow primitive unlocks

**Date:** 2026-08-10, after `b39dd03e`, `407e5f29`, `a06d4142`, `2eee215e`.

## The three blockers from Addendum 1 are closed

| Blocker | State | How |
|---|---|---|
| Nothing can author a file | **Closed** | `document-authoring.js` builds real DOCX via `fflate` (no new dependency). A tailored CV is a new *version* derived from the original; the original survives untouched. Round-trip verified against the independent extractor. |
| `session.agentTaskId` set nowhere → guard was vacuous | **Closed** | `workflow_id` threaded through `storeDocument`, `captureDownload`, `uploadDocument`, `createDerivedDocument`, `findDocuments`. A download now carries its workflow; a document from one responsibility cannot be uploaded into another. Both asserted. |
| No checkpoint/resume, no general pre-submission pause | **Closed** | `workflows.browser_state` holds objective / currentUrl / lastObservation / completedActions / nextIntendedAction, checkpointed on pause, on completion, and every 5 steps. `workflow_checkpoints` generalises `ready_for_payment` into six types. |
| *(minor)* No page-as-evidence | **Closed** | `capturePageAsEvidence` stores the page **with its URL**, which is what makes it evidence rather than a picture. |

## Re-running the "apply for a job" chain

| Step | Before Pass 2 | Now |
|---|---|---|
| Identify what's needed | weak | weak — unchanged, and adequate |
| Find the CV | works | works, now scoped to the responsibility + loose personal files |
| Create a tailored version | **blocked** | **works** — new version, original intact |
| Download a form | works | works, now attached to the work |
| Upload the CV | works | works, now guarded by workflow rather than nothing |
| Save application evidence | **gap** | **works** |
| Remember status / resume later | **blocked** | **works** — survives session death, days, and waiting |
| Ask only when stuck | works | works |
| Pause before submitting | **gap** | **works** — `approval` checkpoint, any goal shape |

**The chain is complete end to end.** What remains is not capability but wiring: the pieces exist and are proven individually, and nothing yet *creates* a workflow from a chat turn. That is the next small step, not a new primitive.

## What is now possible that was not

The point of a primitive is leverage, so measured against the 14 outcomes in the original audit:

- **Applications (#3), insurance renewal (#1), claims (#2)** — all three Tier-1 outcomes now have every mechanical piece: documents in and out, authoring, durable state, a general pause, evidence, and a timeline explaining what happened. They were blocked on the same three things and are unblocked by the same three commits.
- **Returns (#5), bills (#8), household admin (#4), job search (#13)** — same shape, same unlock, no further work.
- **Travel (#6) and purchases** — gain the checkpoint and the timeline. `ready_for_payment` no longer needs to be a special case, though it still is one in `browser-task.js` and can now be folded into `payment_confirmation` whenever that file is next touched.
- **Subscriptions (#7), appointments (#9), warranty (#11)** — still voice-blocked. Unchanged, as expected.

## Honest limits

1. **Nothing creates a workflow yet.** No chat path, no action contract. The primitive is proven by tests, not by a user sentence. Deliberate — a `create_workflow` contract is trivial, and doing it blind before the primitive settled would have been the wrong order.
2. **`ready_for_payment` still exists** in the order loop. Checkpoints supersede the *idea*; the code path is untouched because rewriting the payment flow was not worth the regression risk in this pass.
3. **The 20-minute session TTL is unchanged**, and now doesn't matter — the durable state is on the workflow. Removing it would be churn.
4. **`summarizeForUser` has no UI.** The data behind "Adam is handling…" exists and is jargon-free (asserted); nothing renders it.
5. **Vision extraction for images is injected but never wired** to a real model. `extractImage` fails softly with "no vision extractor configured", which is honest but means scanned documents are not yet readable.

## Next

Phone identity (Pass 3) is genuinely unblocked: a workflow can now hold `awaiting_verification` as an `authentication_required` checkpoint with an expiry, which was the stated dependency for the OTP design. Before that, two hours of wiring — `create_workflow` / `update_workflow` actions and the home summary — would turn a proven primitive into a usable one.

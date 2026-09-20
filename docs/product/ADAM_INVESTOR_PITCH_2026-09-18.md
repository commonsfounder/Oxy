# Adam — Investor Pitch (10 slides)

*Source-grounded: `PRODUCT.md`, `DESIGN.md`, `docs/NORTH_STAR.md` (6 Aug 2026 status), `docs/AMBIENT_DEVICE_CONTRACT.md`, `AGENTS.md`. Status notes are graded on what a person can do today, not what exists in code.*

---

## 1 — Title

**Adam: give it the outcome, it does the legwork.**

A general-purpose personal-AI worker for the household. You state the intended outcome and grant access; Adam composes browser use, connected services, memory, communication, files, long-running work, and verification inside deterministic safety boundaries.

Companion control surface: iPhone app (Home / Ask Adam / Activity / Services / Settings).

---

## 2 — Problem

Busy households drown in routine digital legwork: shopping, booking, forms, account admin, reminders, subscriptions.

Current options fail:
- Chatbot shells hide every capability behind a composer.
- Task-manager dashboards make you operate the queue.
- Integration catalogues connect accounts but do no work.
- Smart-home demos fake rooms, presence, and sensors.

Nobody wants to operate computers step by step. They want to delegate.

---

## 3 — Product

Adam's iPhone app answers four questions immediately:

1. What does Adam know about home right now?
2. Does anything need me?
3. What is Adam doing?
4. What changed?

Surfaces:
- **Home:** household state, approvals with real context, live work, watches, recent outcomes.
- **Ask Adam:** voice + text for new outcomes and follow-up. Chat is a mode, not the identity.
- **Activity:** conversations, work history, receipts, verification.
- **Services / Settings:** explicit account access, home context, initiative, privacy, trust.

Product character: calm, capable, discreet, concrete. Warm through judgment and timing, not chatty copy.

---

## 4 — How it works (the asset)

One runtime, not domain agents. Shopping, booking, forms, and account admin are applications of the same primitives in a different order.

- `agent-orchestrator` — think → act → observe → adapt, with checkpointing and approval parking.
- `action-execution` — the one execution boundary: validate → review gate → invoke → log.
- `browser-session` / `browser-environment` — the browser as an environment (open, observe, act, fill, checkout).
- `money-guard` / `transaction` — spend caps and review-gated payment with live-page amount re-read.
- Connectors (Google, Microsoft, Telegram, GitHub, weather, flights, hotels, stocks, etc.): real API actions or handoff deep-links.

Architecture rule: adding a new kind of task never means adding a new subsystem.

---

## 5 — Live proof (verified in prod, not demos)

Most mature area: **browser agent** — persistent sessions, login management, real checkout. Live purchases completed in production.

Also proven live in the signed-in app:
- General appointment-booking flow: choices offered, explicit approval, one booking made, calendar entry added, confirmation on Home (sandbox, no real practice contacted yet).
- Explicit-approval-before-action backed by durable `agent_runtime_approvals` table.
- Durable per-goal execution sessions (`agent_runtime_sessions`) live with real writes.
- Voice input/output runs (TTS/STT); core promise proven via typed chat so far, not spoken end-to-end.

Honest gaps: some sites blocked by bot walls (Magento/BigCommerce class, some Nike-class flows) with no viable path yet.

---

## 6 — Safety and truth (why this is investable)

Reasoning is probabilistic; authority is deterministic.

- Payments, destructive ops, identity changes, and irreversible external actions stay gated at the execution boundary regardless of interface preferences.
- "Tool invoked" is not an outcome. Success is shown only after resulting state is verified (re-read, confirmation number).
- Unknown, unavailable, and not configured are first-class designed states — never faked with invented rooms, occupants, or sensors.
- Row-level security closed on credential vault and other tables (verified both directions); credential/token handling and audit history are explicit product states.

---

## 7 — Why now / wedge

The wedge is the phone + the shipped transacting capability (basket, guest checkout, card fill, reauth walls, honest outcome reporting) — not a device.

Per project history (Aug 2026): a home-device pivot was pressure-tested and rejected. Phone/app is the actual wedge; hardware is an earned move once software demand is undeniable, not an opening one.

Design language is locked (Sep 2026): graphite structure + electric-blue energy, calm domestic technology, terse factual copy, Home-first hierarchy. No aesthetic archaeology.

---

## 8 — Hardware vision (north star, deferred by choice)

North-star scope lists a physical device as item 1 of 12: always-available hardware, far-field mic array, speaker, wake/low-friction activation, physical privacy control, premium home design, low power, secure identity, encryption, OTA updates.

Current status (6 Aug 2026): **Physical Device — missing, by choice. Multi-device presence — iPhone app only.**

Canonical path today (`AMBIENT_DEVICE_CONTRACT.md`): runtime → bounded display event → authenticated paired browser (phone, tablet, laptop, Pi) → text render or explicit voice mode → acknowledgement. Pairing is explicit and revocable; pairing is not consent to speak private state aloud.

Experimental inputs exist but are not frozen: XIAO nRF52840 BLE control-command prototype and a separate continuous-PCM-over-BLE experiment are not interchangeable; ESP32 presence beacon is connection-only. No mic/radio/touch/battery/enclosure/PCB contract is frozen.

Custom-hardware build gates (all must be measured/decided): canonical input transport + vocabulary; pairing/revocation/reconnect/offline; mic ownership + end-to-end latency; battery/charging/thermal/standby; controls + accessibility; enclosure/BOM/schematic/antenna/tolerances; update + recovery; privacy for local audio; one repeatable household behaviour + one fun behaviour used for a month where removal is noticed.

Until then: commodity-device validation only.

---

## 9 — Business shape

Model implied by what is built (not a forecast):

- Personal household worker doing transacting work others only connect to.
- Connector ecosystem across communication, productivity, everyday life (shopping, travel, banking visibility, smart home, subscriptions — partly built).
- Real payments rails with spend caps and review gates (Stripe-backed card flow, manual bank-transfer top-up shipped; Stripe Issuing Phase 2 blocked on external approval).
- Trust surfaces (permissions, approvals, audit) as the retention moat.

Traction framing for investors: early — proven live behaviours in prod, not scaled usage. The next proof is dependable week-long follow-through (watches, notifications, repeat bookings/orders) with real households.

---

## 10 — Ask and next bets

Next bets to make Home feel right:

1. Prove dependable everyday help: watches → Home cards → verified outcomes across a full week of real use.
2. Widen tool ecosystem where it is real (email/calendar context + reminders exist; banking visibility, smart home, subscriptions not started).
3. Harden permission coverage across every action type + audit-log surface.
4. Prove voice end-to-end (say one sentence, get it handled) — currently typed-chat proven.
5. Graduate one commodity ambient output (paired display voice mode) before any custom PCB.

The ask: capital to turn verified single behaviours into dependable household coverage — with hardware earned, not opened.

---
*Teams working in this repo: see `AGENTS.md` (capabilities + safety boundaries, never human-task subsystems).*

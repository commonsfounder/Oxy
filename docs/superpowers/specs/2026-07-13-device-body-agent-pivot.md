# Device-body agent: a real/virtual dedicated device instead of a browser

**Status:** idea, not started. Strategic pivot candidate, not an incremental fix to `browser-task.js`.
**Origin:** user-driven redirect, 2026-07-13, after a long browser-bot-wall fighting session (see
[browser-task-reliability](../../../../.claude memory) for the browser-side history this replaces).

## The idea

Stop automating websites through a browser. Give the agent its own dedicated device — real
hardware or a cloud-hosted virtual one, owned by Oxy, **not the user's personal phone** — with
real native apps installed (Amazon, Uber, Deliveroo, Gmail, banking, etc.), logged into the user's
accounts with their permission. The agent operates the device the way a person operates their own
phone: look at the screen, decide what to tap, tap it. Same computer-use loop the browser agent
already runs, pointed at a real app on a real device instead of a DOM in Chromium.

**Why this dissolves the current problem instead of patching it:** the entire `browser-task.js`
saga (CAPTCHA, Cloudflare, datacenter-IP bot-walls, Nike's add-to-cart fingerprinting, the
`/products.json` 429s from this week) is a fight against detection that exists specifically
because a *browser* automating a *website* is a known, well-fingerprinted signal
(`navigator.webdriver`, CDP traces, Playwright fingerprint, proxy/IP reputation). A real device
doing real touches on a real, unmodified retail app produces none of that signature — there is no
simulation to detect, because nothing is being simulated.

## Why it's NOT the same as "automate the user's own phone" (a wrong turn this session took)

If the device is shared with a real end user, the OS's inter-app sandboxing model kicks in
(Android AccessibilityService, iOS's total lack of a cross-app automation API) — and those
protections exist specifically to stop one app from spying on/controlling another on someone's
personal device. That's why AccessibilityService abuse detection (the #1 Android banking-trojan
technique) and iOS's jailbreak requirement look like hard walls.

**None of that applies to a dedicated device Oxy owns outright.** There's no other real user's
privacy to protect on it. That reframes the mechanism entirely:

- **Android:** drive it via **ADB** (`adb shell input tap`, `adb shell screencap`) — a legitimate
  developer-debug interface. No root. No AccessibilityService. This is exactly how Appium /
  BrowserStack App Automate / Sauce Labs / AWS Device Farm already automate real, unmodified retail
  apps at scale today, in production, for QA.
- **iOS:** **Appium + WebDriverAgent** (built on Apple's own XCUITest), installed via a developer
  profile on that dedicated device, drives the real App Store binary. No jailbreak. Same
  industry-standard mobile-QA category, used against real banking/retail apps constantly.

## What genuinely still applies (the honest remainder)

1. **Backend fraud/rate-limiting is account-and-behavior based, server-side.** It doesn't care what
   client hit it. Ordering repeatedly from the same account still trips the same velocity checks.
2. **App-attestation APIs (Play Integrity / App Attest) exist and are called by some apps at
   sensitive moments** (login, payment) — but a genuine, unrooted device with debugging enabled
   generally passes; this is a much smaller risk than the rooted/jailbroken case.
3. **App UI still shifts under updates** — same maintenance category as the current web recipes,
   just a different UI tree to track (mobile screen hierarchy instead of DOM).
4. **At scale, a shared device pool logging into MANY different users' accounts could itself become
   a farm-shaped signal** (concentrated IP/device reputation across many accounts) — smaller and
   less mature a detection vector than the browser case today, but not provably zero, especially if
   volume gets large on a small number of devices/IPs. Flag, don't ignore.

## Is it a business, and how

**Yes, plausibly — but the moat is NOT the automation technique** (ADB/Appium are public tooling;
anyone can copy the mechanism). The real, defensible layers:

1. **Reliability/orchestration engineering** — the mobile equivalent of everything already built for
   the web loop (recipe hit-rate, self-healing selectors, progress detection, per-app UI maps) —
   this compounds with usage and is genuinely hard to replicate well.
2. **Trusted credential/session custody at scale.** Being the custodian of many users' live sessions
   across Amazon/Uber/banking apps is a fintech-grade security and liability surface — a breach here
   is catastrophic (every connected account, every user). Doing this credibly (encryption at rest,
   strict access control, audit trail, incident response) IS a moat, because it's expensive and slow
   to build trust in, not because the mechanism is secret.
3. **"Knows the user" data.** Oxy already has the user's calendar, email, preferences — deciding
   *what* to buy/book across life domains is a different, harder moat than *how* to tap a screen.
   The device farm is infra; the personal-assistant layer on top is the actual product.

**Business model shape:**
- **B2C now** — ship as the flagship differentiator of the existing Oxy consumer app: "your
  assistant actually gets things done" vs. every competitor stuck fighting browser bot-walls.
- **B2B/platform later** — if the orchestration layer gets good, license the device-body
  infrastructure to other agent builders (a "Browserbase, but for real native apps" play). Bigger,
  slower, not the place to start.

**Cost/ops reality:**
- Start with **cloud-hosted virtual/managed devices** (AWS Device Farm, Genymotion Cloud for
  Android; Corellium-style virtualized iOS), not owned physical hardware — avoids CapEx, physical
  security, SIM/device-replacement ops until the model is validated.
- Pool devices (warm, on-demand provisioning per task, like the existing browser warm-pool), not one
  permanent device per user — controls cost, since actions are occasional, not continuous.
- **Android first.** Cheaper, cloud-emulator-friendly, no jailbreak-equivalent drama. Treat iOS
  (Appium+WebDriverAgent, generally needs real hardware, no true iOS virtualization outside
  specialized vendors) as phase 2.

**Named risk to go in eyes-open:** **Rabbit (the R1 device)** pitched something that sounded
adjacent ("AI operates apps for you") and executed it badly (turned out to be a thin Android
wrapper, no real device-body advantage, heavy backlash). Expect this comparison from press/
investors; the differentiator here is the *orchestration reliability + trust/custody layer*, not
the "give it a phone" headline — that headline alone is not the pitch.

**Regulatory flag:** using this specifically against **banking apps** risks wandering into payment-
services regulation (PSD2/open-banking-style rules) regardless of mechanism — regulators look at
substance (are you effectively acting as an account-information/payment-initiation service), not
whether you dressed it up as "just a phone." Treat banking as an explicitly separate, harder,
later phase — not part of an initial narrow launch.

## Credential security — the load-bearing constraint, not a detail

This is arguably harder than the automation mechanism itself, and has to be a hard architectural
rule, not a "handle carefully": **the moment Oxy's own servers can decrypt a plaintext password for
Amazon/Uber/banking, a single breach compromises every connected account for every user.**
Encrypted-at-rest-with-a-key-we-hold is NOT good enough — that's still centrally recoverable, by us
or by whoever gets the key. The bar has to be zero-knowledge: Oxy's backend never holds a plaintext
credential, full stop.

**Layered design:**

1. **Device-local, hardware-backed credential storage — not Oxy's database.** The dedicated device
   has a real iOS Keychain / Android Keystore (Secure Enclave / StrongBox on real hardware). The
   user logs in **once**, directly on that device; the credential is encrypted with a key that never
   leaves silicon. The agent's role at login time is "tap the field, trigger system autofill" — it
   never sees or handles the raw string. Not recoverable centrally even under breach or compulsion,
   because it was never stored centrally.
2. **Persist the resulting SESSION after that one-time login, not the password** — cookies/tokens,
   exactly the pattern `browser-task.js` already uses (`storage_state`). Re-authenticate rarely, not
   per task. Fewer times the credential is ever touched, fewer chances to leak it.
3. **Prefer real delegated auth wherever a service offers it** — OAuth / "Sign in with X", or (the
   real prize) agentic-commerce-protocol rails (Stripe/Shopify agent checkout, Google's AP2) where
   the merchant issues a scoped token for an agent to act. No password ever enters the picture.
   Strictly better than anything password-based when available — prefer it over device-credential
   automation, not just as a fallback.
4. **Live step-up confirmation at the moment money moves, always** — biometric or push approval on
   the actual purchase, regardless of how login happened. Caps blast radius: even a compromised
   upstream credential can't complete a real purchase without the real user approving it live.
5. **Banking gets a hard exception: no password automation, period.** Route through actual regulated
   Open Banking rails (Plaid/TrueLayer/PSD2-style consented APIs) instead. Automating a bank's own
   login screen with a stored password is a security anti-pattern, likely trips app-attestation
   blocking anyway (see remainder list above), and edges into unlicensed payment-services territory
   — don't harden around this, avoid it entirely.
6. **Highest-trust setup flow: live "connect this account," never through Oxy's backend.** The user
   types the credential directly on the target device in a live view during onboarding — the
   credential transits the user's own eyes and fingers to the device's keychain, never Oxy's
   servers, not even transiently. Reuse the thinking already scoped in
   `docs/superpowers/specs/2026-07-01-connect-site-login-design.md` (the connect-a-site
   login-capture flow) rather than starting fresh — same problem, same answer, different substrate.

**Rule of thumb for anything added later:** if a design requires Oxy's backend to hold, transmit, or
reconstruct a plaintext third-party password at any point — even briefly, even encrypted with a key
Oxy also holds — that design is wrong. Route around it (device-local keychain, session-only
persistence, delegated auth, or regulated financial APIs) rather than hardening it.

## Recommended narrow first step (if this gets picked up)

Same "narrow scope, do it well" lesson as the browser pivot: pick 2-3 high-value, well-scoped
actions (e.g. order from Amazon, book an Uber) on Android only, on a small cloud device pool, before
expanding to more apps, iOS, or owned hardware. Validate real unit economics (device-hour cost vs.
value delivered) before over-investing in infra.

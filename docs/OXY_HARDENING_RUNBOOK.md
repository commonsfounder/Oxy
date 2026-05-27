# Oxy Hardening Runbook

This is the working checklist for making Oxy usable as a serious personal assistant, not just a demo.

## 1. Brain And Context Evals

Required baseline before every release:

- Run `npm run smoke`.
- Run `npm run brain:evals`.
- Add a regression test for every bad screenshot or user report before shipping the fix.
- Cover at least these categories: contextual references, corrections, memory, current facts, local actions, travel, messaging, calendar, media, connector failures, and empty model responses.

Acceptance:

- A vague follow-up is never routed by keyword alone.
- A current factual answer either uses search grounding or clearly says it cannot verify.
- A failed action gives a recovery path.

## 2. Deployment Verification

Backend proof:

- `GET /version` returns `gitCommit`, `gitBranch`, `packageVersion`, `buildTime`, `nodeVersion`, and `environment`.
- `GET /health` returns `status`, `missingEnv`, and the same version payload.
- Every backend response includes `X-Oxy-Commit`.
- iOS Settings shows the backend commit under Diagnostics.

Manual check after each push:

```bash
curl -s https://oxy-151340634966.europe-west2.run.app/version
```

Acceptance:

- The commit shown in Settings matches the commit pushed to `main`.

## 3. Observability

Every chat request must leave enough logs to explain a bad answer:

- request start with short message preview
- search decision and reason
- context brain decision and resolved context
- deterministic router decision
- Gemini first token and completion
- action start/completion
- action failure recovery metadata
- final request duration

Do not log secrets, full auth tokens, connector tokens, or full private message bodies.

## 4. Memory Quality

Memory rules:

- Save stable user facts only.
- Do not save transient actions, guesses, or current factual answers as memory.
- If the user asks “do you remember…”, answer from memory/conversation first.
- If memory is missing, say so plainly.
- If the user corrects memory, the newer correction wins.

Acceptance prompts:

- “remember my usual station is Birmingham New Street”
- “do you remember what my usual station is”
- “no my usual station is Solihull”
- “what is my usual station”

## 5. Current Facts

Use search grounding for anything that could have changed:

- news, charts, rankings, weather, prices, schedules, company facts, product recommendations, public figures, availability.

Rules:

- Do not answer with old model memory for current facts.
- If challenged, re-check instead of defending the previous answer.
- If no source is available, say what is missing.

## 6. Connector Failure UX

Every connector failure must map to one of:

- needs reconnect
- missing permission
- backend config missing
- temporary provider failure
- no result found
- native app handoff required

The UI card must say what the user can do next.

## 7. Onboarding And Permissions

First-run onboarding must explain:

- Oxy needs network access for the brain.
- Location powers near-me, maps, Uber, travel.
- Contacts powers message/call/email recipients.
- Calendar/reminders power scheduling.
- Music powers native playback.
- HealthKit powers health questions/briefings.
- Notifications power proactive briefings.
- Connectors are optional and can be disconnected.

Acceptance:

- Denying any permission does not make Oxy look broken.
- Each denied permission has a clear recovery path in Settings.

## 8. Privacy, Support, And Legal

Before public release:

- Publish privacy policy.
- Publish terms.
- Publish support contact.
- Publish data deletion path.
- Explain memory controls.
- Explain connector OAuth/token storage.
- Explain location, contacts, calendar, reminders, notifications, HealthKit, audio, and chat history usage.
- State subscription price cap: maximum £15/month unless changed intentionally.

## 9. Device Test Matrix

Run on physical iPhone, not only simulator:

- fresh install
- existing user upgrade
- no network
- slow network
- denied location
- denied contacts
- denied music
- denied notifications
- signed-out session
- stale backend deploy
- Cloud Run cold start

## 10. Release Checklist

Before a release is allowed:

```bash
npm run release:check
xcodebuild -project OxyApp/OxyApp.xcodeproj -scheme OxyApp -configuration Release -sdk iphoneos build
```

Manual prompts:

- “what’s the most popular song on the billboard hot 100 right now”
- “play it”
- “is that right”
- “get me an uber to the nearest Aldi”
- “do you remember what my usual station is”
- “what about tomorrow”
- “send it to Josh”

Acceptance:

- Backend commit visible in Settings.
- Cloud Run `/version` matches Git.
- No dead-end failures.
- No hallucinated current facts.
- No vague follow-up gets hijacked by the wrong native tool.

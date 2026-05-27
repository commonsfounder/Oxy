# Onboarding And Permission Matrix

Oxy should ask for permissions when the user understands the value, not all at once.

| Capability | When To Ask | User Value Copy | Denied-State Recovery |
| --- | --- | --- | --- |
| Location | First near-me, maps, Uber, travel, or proactive location feature | Find nearby places, routes, pickup/drop-off, and useful local nudges. | Show location-needed card and Settings path. |
| Contacts | First message, call, FaceTime, or recipient lookup | Match names like “Josh” to the right phone/email. | Ask for the number/email or enable Contacts. |
| Music | First native playback/add-to-library request | Play exact songs through Apple Music. | Open Apple Music search link and show enable Music access. |
| Calendar | First calendar creation/read request | Add or check events when asked. | Ask to enable Calendar or continue with a text draft. |
| Reminders | First reminder request | Create reminders directly on device. | Ask to enable Reminders. |
| Microphone | First voice message | Let Oxy hear the prompt. | Keep text input fully usable. |
| Notifications | First proactive briefing setup | Send useful briefings and follow-ups. | Keep Today tab available without pushes. |
| HealthKit | First health question/health alert enable | Answer health questions from local Health data. | Say Health access is unavailable and show Settings path. |
| Connectors | When user opens Connectors or requests connector action | Connect Google, Telegram, Trainline, Netflix, etc. | Show reconnect/permission card. |

## Required First-Run Flow

1. Account sign-in.
2. One-screen value explanation: Oxy is useful only with user-approved context.
3. Ask for no sensitive permission until a feature needs it.
4. Show Settings controls for memory, proactive behavior, permissions, and connectors.
5. Include support/privacy links before payment.

## Acceptance Tests

- Fresh install can chat without granting optional permissions.
- Every permission-denied path has useful copy and no dead-end “failed”.
- Every connector failure says reconnect, permission, unavailable, or not configured.
- User can disable proactive/health/location nudges from Settings.

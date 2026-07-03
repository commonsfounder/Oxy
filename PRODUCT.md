# Product

## Register

product

## Users
Busy individuals who want to talk (text or voice) to a capable assistant that actually does things across the services they already use (email, calendar, messaging, rides, trains, music, home, etc.). They value natural conversation, personal memory across sessions, and reliable real-world action execution without opening multiple apps or dealing with fragmented interfaces.

Primary contexts: on the go (mobile/PWA), multitasking, or when voice input is preferable. Users expect the assistant to remember personal facts ("Works at KPMG", preferences) and use them intelligently.

## Product Purpose
Oxy is the conversational and action-taking layer over the user's digital life. It listens (text/voice), remembers context, reasons about intent, and executes real actions via a pluggable connector system (Google, Telegram, Uber, Trainline, Spotify, etc.). 

It also includes proactive capabilities (briefings, scheduled jobs) and bridges to native platforms (Apple Shortcuts, iOS app integrations for location, contacts, HealthKit, Reminders, etc.).

Success looks like: users can issue high-level natural requests and have them reliably fulfilled, with clear feedback, history, and improving personalization over time. The product reduces context switching and cognitive load for routine + cross-app tasks.

## Brand Personality
Friendly, capable, natural — like talking to a trusted, proactive friend who is efficient and discreet.

- Tone: warm but not cutesy or overly casual; confident without arrogance; helpful and anticipatory without being creepy or salesy.
- Voice: natural spoken language via Gemini TTS; the interface should feel like an extension of a real conversation.
- Overall: trustworthy, competent, low-friction, privacy-respecting.

## Anti-references
- Stiff, corporate, or robotic assistant language ("How may I assist you today?")
- Generic SaaS aesthetics (glassmorphism, heavy gradients, hero metrics, identical card grids, tiny uppercase eyebrows on every section)
- Overly playful or toy-like designs that undermine the seriousness of real actions (booking rides, sending messages, managing life)
- Excessive proactivity that feels intrusive rather than helpful
- Cold terminal-like or purely utilitarian UIs that ignore the "talk to it like a friend" promise
- Dark patterns around data use or actions

## Design Principles
- **Conversation first**: The core experience is chat (text + voice). Traditional UI (connectors, memory, history, settings) supports and augments the conversation rather than replacing it.
- **Action transparency and control**: Every time an action will be taken on behalf of the user, make the intent, data involved, and outcome crystal clear. Provide easy review, confirmation, cancellation, and history.
- **Memory as a graceful superpower**: Surface relevant remembered facts at the right time. Make memory visible and editable without feeling like surveillance.
- **Cross-surface consistency**: The web PWA and native iOS app must feel like the same assistant. Shared patterns for chat, actions, connectors, proactive content.
- **Trust through feedback**: Excellent real-time status (streaming, action progress), clear error states, and undo/revise paths.
- **Voice parity**: Voice and text are first-class and equivalent citizens. Visual UI must not assume a keyboard.
- **Respect the user's time and attention**: Fast, minimal chrome when in flow. Intentional motion only for state communication.

## Accessibility & Inclusion
- High-quality voice pipeline (STT accuracy, natural TTS, low latency).
- Full keyboard navigation and screen reader support for all text-based UI (chat, forms, lists).
- Strong visual contrast (currently dark theme with #0C0C0C base).
- Support for reduced motion / prefers-reduced-motion.
- Clear focus states, error messaging, and loading states.
- Privacy-first defaults for memory and connector data; explicit controls.
- WCAG AA as baseline (target higher for key flows).
- Consider diverse users: different accents for voice, varying tech comfort, accessibility needs for motor/visual/cognitive.

## Notes
- Primary surfaces: Chat (main), Connectors management, Memory view, Action/briefing history, Settings, Proactive briefings.
- Tech notes for designers: React (CDN + Babel standalone, no build step for the PWA shell), SSE for streaming, service worker for PWA, Express backend. iOS app is SwiftUI with similar flows.
- The design must feel premium yet approachable and reliable for daily use.

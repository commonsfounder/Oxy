# Oxy north star (locked)

**UI generated for the job. Alive. Nice to use. Stuff you love.**

Reference: Gleb Kuznetsov agentic gen UI concept (soft home + mission cards + chat as mode).

## Product rules

1. **Home is the product** — greeting + living mission cards + composer.
2. **Chat is a mode** — open from composer or a card CTA; not the whole identity.
3. **Cards are outcomes** — rides, mail, orders, confirmations land on Home and stay scannable.
4. **One fat primary CTA** per card when something needs you.
5. **No aesthetic archaeology** — soft glass + soft wash. Not silent luxury / Didot / multi-theme thrash.

## Product scope checklist

This is the full product scope. Physical hardware is part of the north star, but
software work comes first.

1. **Physical Device**
   - Always-available hardware.
   - Far-field microphone array.
   - Speaker and audio output.
   - Wake word or low-friction activation.
   - Physical privacy control, such as a mute switch or shutter indicator.
   - Premium design that belongs in the home.
   - Low power use for always-on operation.
   - Secure hardware identity.
   - Device-level encryption.
   - Over-the-air firmware updates.

2. **Agent Operating System**
   - Persistent agent identity: Millie.
   - Long-term memory.
   - User profile and preferences.
   - Goals.
   - Relationships and context.
   - Understanding of the person's life.

3. **Personal AI Workspace**
   - Dedicated storage.
   - Filesystem.
   - Browser environment.
   - Project folders.
   - Task history.
   - Working memory.
   - Persistent sessions.

4. **Model Independence**
   - Supported connections to ChatGPT, Claude, Gemini, and local models.
   - Model routing.
   - The user owns the relationship with their chosen AI services.

5. **AI Account Migration and Continuity**
   - Connect existing AI accounts where supported.
   - Import conversations, projects, instructions, and documents.
   - Convert imported history into memory.
   - Preserve the user's relationship with AI without making them start again.

6. **Tool Ecosystem**
   - Communication: email, messages, eventual phone calls, and contacts.
   - Productivity: calendar, notes, documents, tasks, and reminders.
   - Development: GitHub, IDE environments, code execution, and deployment tools.
   - Everyday life: shopping, travel booking, careful banking visibility, smart home, and subscriptions.

7. **Browser Agent**
   - Its own browser.
   - Persistent sessions.
   - Login management.
   - Website understanding.
   - Form completion.
   - Checkout capability.
   - Research ability.

8. **Permission System**
   - Read permissions.
   - Write permissions.
   - Approval requirements.
   - Action history.
   - Undo capability.
   - Audit logs.

9. **Agent Execution Engine**
   - Multi-step planning.
   - Background tasks.
   - Scheduling.
   - Monitoring.
   - Follow-ups.
   - Notifications.
   - Example: Millie checks flight prices on a schedule and alerts the user when she finds a better option.

10. **Voice Intelligence**
    - Natural conversation.
    - Interruptions.
    - Retained context.
    - Fast responses.
    - Multiple voices and personality options.
    - Ability to whisper or speak quietly.
    - Optional understanding of the surroundings.

11. **Multi-device Presence**
    - Home device.
    - Phone app.
    - Laptop companion.
    - Car integration.
    - Wearable.
    - The same Millie identity everywhere.

12. **Security and Trust**
    - Encryption.
    - User-owned data.
    - Clear history and transparent logs.
    - Data export.
    - A delete-everything option.
    - Local processing where possible.
    - Secure authentication.

## Core outcome

The user can ask Millie, “What matters?” She knows their emails, calendar,
projects, goals, and ongoing tasks. The user can ask her to handle a request,
negotiate with someone, and create follow-up tasks while they carry on with life.

The deeper thesis is that computers should be delegated to, not operated by
people step by step. The device is the physical presence of that shift.

## The mum test

Every screen must pass this test:

- A normal person can understand what it does in a few seconds.
- A normal person can see why it matters.
- A normal person can see the next action.

Use human outcomes as the main language:

- “Millie is watching this.”
- “Millie handled this.”
- “This needs your OK.”
- “Here is what matters today.”

Keep runtimes, artifacts, project references, diffs, schedulers, and background jobs
hidden unless the person needs that detail. Developer work is a proving ground. It is
not the product identity.

## Out of scope until Home feels right

- Full generative 3D surfaces
- Orb memory graphs as primary UX
- More design-system rewrites

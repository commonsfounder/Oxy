# Privacy And Support Checklist

This is not legal advice. It is the product checklist Oxy must satisfy before public launch.

## Public Pages

- Privacy policy URL
- Terms URL
- Support email
- Data deletion instructions
- Subscription/cancellation instructions

## Data Disclosures

Explain clearly:

- Chat messages are sent to Oxy backend and Gemini for responses.
- Search grounding may be used for current facts.
- Memories store user-provided stable facts.
- Conversation history is saved unless vanish/private mode is active.
- Connector OAuth tokens are stored server-side for connected services.
- Location is used for near-me, maps, Uber, travel, and local recommendations.
- Contacts are used only to resolve requested recipients.
- Calendar/reminders are used only for requested scheduling tasks.
- HealthKit is used only for health summaries/briefings enabled by the user.
- Audio is used for transcription/voice interactions.
- Notifications are used for proactive briefings and action follow-ups.

## Controls

Required user controls:

- Sign out
- Delete account/data path
- View/edit/delete memory
- Disconnect connectors
- Toggle proactive briefings
- Toggle health alerts
- Toggle location reminders
- Disable voice output

## Support Playbook

Support responses must collect:

- App build/version
- Backend commit from Settings
- Approximate time of issue
- Prompt used
- Screenshot if available
- Connector/permission involved

Never request:

- Passwords
- OAuth tokens
- Full private contact lists
- Full message history unless explicitly needed and user-approved

## Pricing

Current planning constraint:

- Subscription maximum: £15/month.
- Any plan or copy mentioning a higher monthly price must be changed before launch.

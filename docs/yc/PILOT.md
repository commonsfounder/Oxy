# Household pilot kit

Goal: 5–10 households, two weeks, before 2 Nov. Answers one question with numbers: **do people keep Adam
switched on at home, and come back to it for real tasks?**

## Who to recruit

- Households where something can happen at home while you're elsewhere in the house or out: parents of babies
  or toddlers, people with a parent living with them, people who work from home.
- Owns an iPhone and has a spare one (old iPhone in a drawer is ideal; it must run iOS 17 or later, which
  means an iPhone XS/XR or newer).
- **Not** close friends or family. Friends of friends are fine. Politeness is not demand.

## Setup (≈15 minutes, in person or on a call)

1. Install Adam from TestFlight on **both** phones; sign in to the **same account** on both. Alerts go to every
   iPhone on the account.
2. On the spare phone, in Adam: Settings → Notifications → **Alarms and doorbells** on; allow the microphone.
3. On the spare phone, in iOS Settings: Display & Brightness → Auto-Lock → **Never**. Plug it in. Put it on a
   shelf in the main living space with Adam **open on screen**.
   *Why: the app has no background-audio mode yet, so listening stops when Adam isn't on screen or the phone
   locks. This is the first thing to fix if the pilot works (backlog: listening-station mode).*
4. Test it together: play a smoke-alarm recording near the spare phone (YouTube "smoke alarm T3 pattern").
   Confirm the alert arrives on their own phone. **Do not test with their real alarm.**
5. On their own phone: connect Google (Settings → Services) **before** asking about email or calendar. That's
   where August's users fell off.
6. Optional: turn on "keep a 5-second clip with each alert" so they can mark alerts right or wrong. Clips stay on
   that phone.

## What to say about safety (use these words)

> Adam is not a smoke alarm and doesn't replace one. It may miss sounds and may raise false alarms. It's an
> early test; tell us every time it gets something wrong.

## Consent (send in writing before setup)

> You're testing an early version of Adam. Adam stores your messages and the actions it takes so we can see what
> worked; sound clips, if you turn them on, never leave your phone unless you share them. You can delete your
> account and data at any time in Settings, or by emailing support@oxy.app. We'll check in with you twice a week
> for two weeks. You can stop whenever you want.

## What to measure

From the database every week — `OXY_TRACTION_EXCLUDE_USERS=<your ids> node scripts/traction-report.js`:
weekly actives, retained from last week, actions executed vs failed, tasks completed.

From each household, twice a week (5 minutes, written down the same day):

| Question | Why |
|---|---|
| Is the spare phone still on and listening? If not, why not? | Whether they keep it on is the whole question. |
| Any alerts? Right or wrong? | False alarms per day per home is the number that kills ambient products. |
| What did you ask Adam to do? Did it finish? Did you have to step in? | Follow-through, founder interventions. |
| What would you miss if we took it away tomorrow? | The YC "want" signal. Write their exact words. |
| Would you pay £X/month? Would you pay now? | Price signal; a real payment beats a "yes". |

## Decide at the end of week two

- ≥ half the homes still have the shelf phone on, unprompted → the presence wedge is real; build listening-station
  mode and background audio next.
- They use the agent but unplug the phone → the wedge is follow-through, not presence; say that in the application.
- Neither → write down why, in their words, before building anything else.

## Recruitment message (adapt; send yourself)

> Hi [name] — I'm building Adam, an AI that sits on a shelf at home (on an old iPhone for now), listens for
> things like the smoke alarm or the baby, tells you wherever you are, and handles digital chores when you ask.
> I'm looking for a few households to try it for two weeks and tell me honestly where it falls short.
> Setup is 15 minutes. Would you be up for it?

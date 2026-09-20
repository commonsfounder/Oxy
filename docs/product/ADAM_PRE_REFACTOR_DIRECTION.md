# Adam / Company Direction — Full Pre-Refactor Conversation Archive

> Recovered verbatim from the "Adam company direction pre-refactor" session, 2026-08-29.
> Only markdown heading markers were added — no wording was changed, added or removed.

## 1. The starting frustration: everything is becoming table stakes
The conversation started from a growing frustration that many of the things that once felt like differentiators for an AI product no longer felt special.
The feeling was essentially:

* “It can use your email” — okay, so can everyone else.
* “It can use a browser” — increasingly normal.
* “It can click around websites” — useful, but no longer enough to build a company thesis around.
* “It can use tools” — also becoming expected.
* “It can remember things” — increasingly part of the baseline.

The concern was that if Adam was simply:
a smart agent that could use email, browse the web, connect to apps, and act for you
then it risked becoming indistinguishable from what OpenAI, Anthropic, Google, Amazon, Apple and others were rapidly converging toward.
The important phrase was that the offering needed to feel like a step-change, not simply a better implementation of the same general-purpose agent idea.
That changed the frame of the discussion.
Instead of asking:
“How do I make Adam smarter?”
the more important question became:
“What is fundamentally different about the relationship between the user and Adam?”

## 2. First attempt at defining the step-change: Adam as the layer through which you operate your digital life
One direction was that Adam should not merely be another AI capable of interacting with software.
The more ambitious formulation was:
You stop operating software directly. You operate Adam, and Adam operates the software.
That differs from the standard interaction:
user → AI → task → tool → result
and instead starts to become:
user → Adam → persistent changes across the user’s digital environment
The difference is persistence and authority.
Examples discussed included things such as:

* “I don’t want companies emailing me marketing stuff anymore.”
* “Move everything related to my company onto this new email.”
* “I’m going away for three weeks. Sort everything out.”
* “Stop remembering anything about this person.”
* “Any purchase over £100 needs my approval.”
* “This app keeps annoying me with this setting. Fix it.”
* “I’m trying to save £10,000 by December. Start managing things around that.”
* “Use Claude for coding this week but keep GPT for everything else.”
* “You’ve been handling reminders badly. Change how you do it.”

The key distinction was that these should not just trigger answers.
They should alter persistent:

* policies,
* permissions,
* routines,
* memories,
* provider choices,
* settings,
* integrations,
* behavioural rules.

That led to the idea of Adam being something closer to a personal operating layer.

## 3. Adam should be able to operate Adam
One especially important idea was that today’s assistants still force the user to manually administer the assistant itself.
Even if the assistant is supposedly intelligent, the user still has to navigate:

* settings,
* permissions,
* memories,
* integrations,
* notifications,
* provider preferences,
* account connections,
* automation rules.

That feels conceptually wrong if conversational intelligence is supposed to become the main interface.
So one of the more interesting differentiators discussed was:
Adam should be able to inspect, explain and change Adam.
Examples:

* “Stop asking before adding things to my calendar unless money is involved.”
* “You’re remembering too much random stuff. Clean my memory.”
* “You keep using expensive models for easy tasks. Fix that.”
* “What standing rules have I given you?”
* “Delete the third rule.”
* “Always ask before doing anything involving money.”
* “Turn dark mode off.”
* “Forget that memory.”
* “Change this permission from ask-every-time to always allow.”

This was seen as more interesting than simply adding another browser integration.
The hierarchy discussed was roughly:
Level 1 — Chatbot
Answers questions.
Level 2 — Copilot
Helps the user operate software.
Level 3 — Agent
Operates software on the user’s behalf.
Level 4 — Personal operating layer
Coordinates apps, memory, policies, permissions, agents and routines around persistent user intent.
Level 5 — Self-administering personal intelligence
Can inspect and modify its own configuration conversationally.
The idea was that most companies were competing around Levels 2–3, while Adam might aim at 4–5.

## 4. Model intelligence itself should become replaceable
This connected to the earlier Adam thesis that Adam should not necessarily be the smartest model.
Instead, Adam might own the persistent user layer:

* identity,
* context,
* preferences,
* permissions,
* habits,
* history,
* routines,
* agent configuration,
* relationships with external services.

Then:

* GPT could be one underlying engine,
* Claude another,
* Gemini another,
* some future model another.

The model is interchangeable.
The user’s digital identity and accumulated context are not.
That produced an important formulation:
Adam is not an AI that can use your apps. Adam is the place from which you control your digital life.
At that point, however, another problem emerged.

## 5. The vision was too large to build
The user pushed back that this all still sounded enormous.
“How am I actually going to build a company if everything is this big?”
That led to separating:

* the long-term company vision, and
* the first product wedge.

The answer was not to build:

* memory,
* browser,
* email,
* payments,
* every connector,
* every app,
* smart home,
* agent routing,
* hardware,
* routines,
* permissions,
* everything else

simultaneously.
Instead, the company could start from a very small surface that already embodies the future architecture.
One proposed starting version was:
Adam as a personal control layer for your digital life.
Possibly beginning with only:

* Gmail,
* Calendar,
* Adam’s own memory/settings.

The experience might be:
“I’m going away next week. Clear anything non-essential, move anything important, tell people who need to know, and don’t schedule anything before 11 while I’m away.”
Adam could:

* inspect calendar,
* move permitted events,
* draft/send messages,
* change temporary notification rules,
* store an expiring rule,
* remember that the rule ends when the trip ends.

Then:
“Never move meetings with David without asking me.”
That becomes a standing policy.
Then:
“What rules have I given you?”
Adam can enumerate them.
Then:
“Delete the third one.”
The point was that memory, rules, permissions, connections and actions could become conversational objects.
The first magic moment suggested was something like:
“I found three actionable emails, two commitments that aren’t in your calendar, and one recurring message you always ignore. Want me to sort them?”
Then the user says:
“Yes. And stop bothering me about promotional email.”
Adam acts and also changes its standing behaviour.
This was seen as a more differentiated experience than simply “AI with Gmail.”

## 6. Then came the deeper objection: maybe none of this should be the company
The user then questioned the entire premise.
They said they did not think there was much point trying to make:

* a smart model,
* a smart agent,
* a smart system,
* or simply “those things, but better.”

The user wanted to ensure there was real need for whatever was being built.
That shifted the discussion from capability-first thinking to problem-first thinking.
Instead of:
“AI is powerful. What can we build?”
the suggested frame became:
“What problem is sufficiently painful that people are already trying to solve it badly?”
And then:
“Does modern AI suddenly make it possible to solve that problem dramatically better?”
The emphasis became finding ugly human problems involving:

* wasted money,
* wasted time,
* bureaucracy,
* repetitive work,
* things falling through cracks,
* fragmented information,
* bad customer service,
* manual workflows,
* avoidable operational risk.

The strongest signal would not be someone saying:
“Yeah, I’d use that.”
but behaviour like:

* already paying someone,
* maintaining spreadsheets,
* repeatedly chasing things,
* losing money,
* using multiple disconnected tools,
* manually stitching processes together.

A useful test suggested was simply:
“Show me how you do this today.”
If the person opens:

* six tabs,
* spreadsheets,
* Gmail,
* PDFs,
* a terrible old portal,

to do one task, that is potentially fertile territory.
The preferred discovery sequence became:
Problem → customer → existing workaround → economic pain → new capability → product
instead of:
Model → tools → agent → features → find customer

## 7. The user wanted something with almost no selling friction
The user clarified another requirement.
They wanted something:

* relatively easy to break into,
* where they did not have to painfully convince people to pay,
* where the value was so obvious that payment almost followed naturally.

They described wanting a business where people were effectively throwing money at them.
Obviously, no business literally has zero sales friction, but the underlying desire was:
The value should be obvious enough that the transaction does not require educating the customer about why the category matters.
That led to searching for businesses close to money.

## 8. The cash-recovery idea
One proposed direction was a company that recovers money businesses are already owed.
The concept was:
Give us your overdue B2B invoices. We recover them. If we recover nothing, you pay nothing.
The appeal was that this avoids asking a customer:
“Do you think our software is worth £50/month?”
Instead:
“You’re owed £20,000. We recovered £15,000. We take a percentage.”
That aligns incentives mechanically.
The underlying promise is cash, not software.
The discussion differentiated this from invoice-reminder SaaS.
There are already lots of products that automate:

* reminder emails,
* accounts receivable workflows,
* chasing,
* invoice notifications.

So the stronger proposition would be:
not “here is software that helps your finance team collect,” but “we collect it for you.”
Potential operation:
A company has:

* £74,000 receivable,
* £31,000 overdue,
* 11 customers,
* several overdue invoices.

The system could understand that:

* one customer normally pays late,
* one has a PO issue,
* one promised Friday and missed it,
* one has not replied,
* one actually paid but the payment has not been reconciled.

Instead of generic reminders, it could work the account:

* read correspondence,
* understand disputes,
* follow payment promises,
* contact the right person,
* retrieve supporting documents,
* track evidence,
* escalate where appropriate.

The business model proposed was some percentage of recovered funds.

## 9. The user immediately found the weakness
The user challenged the economics with a very simple example:
Someone owes a business £5,000. Why would they give me £500 to recover it if they can just keep chasing and eventually collect the full £5,000 themselves?
That objection exposed the flaw.
If a business believes:
“They’re going to pay eventually.”
then giving away 10% is irrational.
The real market only appears once the debt becomes uncertain enough that the business starts thinking:
“Maybe I’m not getting this money.”
But then the recovery company gets handed harder debt.
So the segments become:
1. They will probably pay
The company should chase itself and keep 100%.
2. They might pay
A third party may become attractive, but there are alternatives like legal letters or small claims.
3. The invoice is nearly written off
The company may gladly give away 10–20%, but now the recovery problem is far harder.
That produced an important realization:
Better customer economics can mean worse underlying work.
And although there is clearly a debt collection industry, it did not satisfy the user’s deeper desire for a category where the opportunity felt structurally compelling rather than simply established.
The concept was downgraded.
The more attractive shape became:
Find money the customer is currently leaving on the table without realizing it, or cannot economically retrieve themselves.
Then a percentage of recovered value becomes much easier to justify.
But this was not pursued further because another preference resurfaced.

## 10. The user came back to consumer hardware
The user said they thought they would rather build:
a consumer company
and more specifically:
a consumer hardware company.
This actually matched the direction they already liked.
The problem is that major consumer computing surfaces feel saturated.
People already have:

* phones,
* laptops,
* tablets,
* smartwatches,
* rings,
* headphones,
* wearables.

The user correctly observed that building:

* another phone,
* another laptop,
* another tablet

is unrealistic and strategically pointless.
Wearables were described as “okay-ish,” but also crowded:

* Apple Watch,
* Garmin,
* Oura,
* various rings,
* health wearables,
* earbuds,
* AI pins,
* glasses.

People are already being offered new wearable devices constantly.
This was one reason the home device / smart-speaker-like device remained compelling.

## 11. Why the home felt different
The user’s reasoning was:
A home device does not compete directly with the customer’s:

* phone,
* laptop,
* tablet,
* wearable.

Instead, the obvious incumbent competition is mainly:

* Amazon Alexa,
* Google Home,
* possibly Apple/HomePod.

And the user did not believe people had especially strong emotional attachment to Alexa or Google Home.
The theory was:
If a new device is genuinely more useful, intelligent, proactive and helpful, switching is plausible.
There is less “I am an Alexa person forever” attachment than there is with, say:

* iPhone,
* Mac,
* Apple Watch,
* Windows,
* Android.

The user believed a home device that did genuinely important, proactive things could become an important company because it might take real cognitive burden away from people.
That became a much stronger product thesis.

## 12. But the opportunity is not “smart speaker, except smarter”
A critical distinction was made.
The opportunity could not simply be:
Alexa, but now it has an LLM.
Because Amazon and Google are obviously moving in that direction.
The more interesting framing was:
The home itself remains an underdeveloped computing surface.
Phones have colonized the pocket.
Laptops colonized the desk.
Smartwatches the wrist.
Rings the finger.
Televisions have their own platforms.
But the home as a persistent shared environment still does not really have a computer whose job is:
Take care of the people who live here.
Smart speakers were supposed to become more than speakers, but in practice many people mostly use them for:

* music,
* radio,
* alarms,
* timers,
* weather,
* simple facts,
* smart-home commands.

In other words:
millions of always-available computers with microphones were placed inside homes and largely became radios with timers.
That was seen as the possible opening.

## 13. “Do not build a smart speaker. Build a home computer.”
That phrase captured the next version of the idea.
A smart speaker is mentally:
“Alexa, do X.”
A home computer might be mentally:
“I’ve got the house.”
The product’s responsibility would be household logistics, not merely responding to commands.
An imagined morning interaction:
“Your train is delayed by 18 minutes, so you don’t need to leave until 8:22. Your delivery is arriving between 10:40 and 11:40. Nobody else will be here, so I moved your reminder to 10:30. You also left £62 of groceries in your basket yesterday. Want me to order them?”
User:
“Yeah, but take the ice cream off.”
Adam:
“Done.”
Later:
“Mum said she’s getting home late tonight, so I moved dinner on the household plan. Also, you said yesterday you needed to take that parcel to work. It’s still by the door.”
That feels different from a phone assistant because it is rooted in the home environment.

## 14. Hardware must earn its existence
A major rule emerged:
If deleting the physical device and replacing it with an iPhone app leaves the experience basically unchanged, do not manufacture hardware.
The hardware has to provide something meaningfully different.
Potential advantages discussed:
Presence
The device can know that the person is actually physically in the room.
That is different from GPS saying someone is near home.
Immediate availability
No:

* unlock,
* open app,
* start chat,
* press microphone.

You just speak.
Sharedness
The device is not strictly one person’s possession in the way a phone is.
It can serve a:

* couple,
* family,
* flat,
* shared household.

Environmental context
Potential sensors could eventually understand:

* presence,
* movement,
* temperature,
* sound events,
* household state.

Physical continuity
The device is always in the same place.
This lets habits form around it.
Proactivity
Perhaps the most important one.
Phones already send endless notifications.
A home device could wait until the right physical moment.
Example:
A phone knows:
“Remember to take the parcel.”
A home device might know:
“You are moving toward the front door, and the parcel you said you need is still by the door.”
That is a fundamentally different type of intervention.

## 15. Adam’s domain became clearer: take care of the home and life around it
Instead of:
Adam is an omniscient AI assistant
the stronger framing became:
Adam takes care of your home and the life that happens around it.
That gives the system a clear domain without making it narrow in capability.
Potential knowledge included:

* who lives there,
* who is currently there,
* household schedules,
* deliveries,
* things running out,
* shopping needs,
* reminders,
* commitments,
* routines,
* visitors,
* meals,
* shared tasks,
* home maintenance,
* bills,
* subscriptions,
* smart-home devices,
* preferences of different household members,
* safety signals,
* household messages.

The underlying agent could still be general-purpose.
But the product responsibility becomes much easier to understand.

## 16. The proposed first home-device test
The advice was not to manufacture custom hardware immediately.
Instead:

* use existing/off-the-shelf microphone/speaker hardware,
* put Adam into a small number of homes,
* test a handful of deeply useful behaviours.

Possible initial abilities:
Household memory
“Remember that we’re out of washing-up liquid.”
Contextual commitments
“Remind Tom when he gets home that he needs to call Grandma.”
Deliveries
Know what is arriving and surface it at useful moments.
Household calendar
Understand who is doing what and detect conflicts.
Things that need doing
Not merely a to-do list, but contextually surface tasks at the right time.
The important metric should not merely be:
prompts per day
but something like:
how often did Adam do something useful without the person having to remember to ask?
And perhaps the strongest product test:
After four weeks, do users want the device taken away?
If they say:
“Yeah, whatever.”
kill it.
If they say:
“No. Can I keep it?”
then custom hardware becomes more justified.

## 17. Then the conversation turned to the software capability underneath the hardware
The user then made an important clarification.
Yes, the product might be a home device.
But Adam still needs deep software capability underneath it.
The key frustration was that developers or coding agents seemed to interpret each activity as a separate feature.
Shopping was the main example.
The user said, essentially:
“Learning to shop” sounds strange.
Humans do not think:
“Shopping is one of my installed capabilities.”
Shopping is just something a competent person can do.
Likewise:

* filling forms,
* replying,
* buying things,
* using websites,
* changing settings.

These should feel like consequences of general competence, not individual hand-engineered modules.
The user had become worried because the existing codebase apparently contained so much shopping-specific logic that when another model generated a README, it described the project as:
a shopping automation agent.
That was seen as evidence that the architecture had drifted badly.
The concern was:
Is Adam accumulating code around specific behaviours instead of becoming generally capable?

## 18. The central distinction: hardcode primitives, not human tasks
The conversation then focused on what should actually be hardcoded.
There will always be lots of engineered machinery.
The fact that the consumer experiences:
“It just does it”
does not mean the implementation is simple.
But the complexity should be organized at the right level.
A problematic architecture might look like:
shopping request → shopping planner → product finder → shopping state → cart logic → checkout logic
then separately:
form request → form workflow
then:
email request → email workflow
then:
booking request → booking workflow
until the system becomes a huge set of miniature applications.
The alternative is to create lower-level, general capabilities.
For example:

* observe,
* retrieve,
* search,
* navigate,
* click,
* type,
* select,
* upload,
* download,
* create,
* edit,
* send,
* reply,
* call APIs,
* wait,
* monitor,
* remember,
* inspect state,
* modify state,
* verify.

Then shopping emerges from composition.

## 19. Example: “Buy me toothpaste”
Under the more general architecture, Adam would not necessarily invoke a giant shopping-specific system.
Instead it reasons:

1. The user wants toothpaste.
2. Determine relevant preference, if known.
3. Search appropriate retailers.
4. Compare options.
5. Navigate to the selected product.
6. Add it.
7. Inspect quantity, price, seller and delivery.
8. Ask for payment authorization if required.
9. Commit transaction.
10. Verify successful order.
11. Store useful resulting information such as delivery date.

Most of those capabilities also apply to unrelated tasks.

## 20. Example: tenancy application
For:
“Complete this tenancy application.”
Adam might use:

* inspect page,
* retrieve known details,
* navigate,
* type,
* upload documents,
* ask for genuinely unknown information,
* submit,
* verify.

No special “tenancy-application agent” is conceptually required.

## 21. Example: changing Adam itself
For:
“Change Adam to light mode.”
the same generality applies:

* inspect intended state,
* discover configuration,
* modify state,
* verify.

Again, no giant bespoke feature is necessary.

## 22. Large AI agents probably still have lots of engineered infrastructure
There was also an important correction to avoid over-romanticizing how systems like Claude or Codex work.
The intuition was probably right that they are not backed by thousands of totally separate workflows for every possible user activity.
But that does not mean the model just “figures everything out magically.”
A coding agent still needs engineered primitives such as:

* read file,
* search file,
* edit file,
* run command,
* inspect output,
* use browser.

The intelligence comes from composition.
A simplified mental model is:

```
goal = understand desired state

while not complete:
    observe environment
    choose useful next action
    execute available capability
    inspect result
    update understanding

verify desired state
```

The real implementation is of course more complicated, but the architecture is general.
The model does not need:

```
if fixing React bug:
    run special React bug workflow
```

for every possible human task.

## 23. Skills/playbooks can still exist
The discussion did not conclude that all domain knowledge should disappear.
Humans also build habits and procedural knowledge.
Someone who shops frequently knows concepts like:

* cart,
* checkout,
* delivery,
* returns,
* seller,
* payment method.

So Adam can have playbooks.
Example shopping guidance:

* respect known user preferences,
* consider total delivered cost,
* verify seller,
* verify quantity,
* avoid accidental subscriptions,
* respect financial approval policy,
* confirm outcome.

The crucial test:
If the shopping playbook disappeared, could Adam still theoretically buy something using its general capabilities?
If yes, the architecture is healthy.
If no, shopping is probably too deeply hardcoded.
The playbook should make the system better at shopping, not make shopping possible at all.

## 24. Proposed three-layer architecture
A rough architecture was outlined.
Layer 1 — General reasoning / orchestration
The model determines:
What does the user want the world to look like when I am finished?
Responsibilities include:

* understanding intent,
* decomposing goals,
* adapting plans,
* dealing with ambiguity,
* deciding what action comes next,
* determining completion.

This should remain relatively domain-independent.
Layer 2 — General action substrate
Adam receives primitives for interacting with the world.
Browser/computer examples:

* see,
* click,
* type,
* scroll,
* navigate,
* upload,
* download.

Service/API examples:

* discover actions,
* invoke actions,
* inspect results.

Internal Adam examples:

* inspect memory,
* modify memory,
* inspect permissions,
* change permitted settings,
* inspect connections,
* configure policies.

Temporal examples:

* wait,
* retry,
* monitor,
* resume later.

Verification should also be first-class.
Layer 3 — Domain knowledge / playbooks
Optional guidance for domains such as:

* shopping,
* travel,
* scheduling,
* customer support,
* deliveries,
* subscriptions.

These improve reliability.
They should not define the system’s core capabilities.

## 25. Capability discovery
Another important point was avoiding an enormous static tool namespace.
Bad direction:

* `amazon_add_to_cart`
* `amazon_checkout`
* `amazon_choose_delivery`
* `john_lewis_add_to_cart`
* `ebay_buy_item`
* `booking_book_restaurant`
* etc.

As the number of services grows, that becomes difficult to manage.
Instead, Adam should ideally be able to reason:
“I need to accomplish X. What capabilities and connected services are available?”
Then discover the relevant tools.
Example:
Goal:
“Book dinner tomorrow.”
Adam might discover/use:

* calendar to inspect availability,
* maps/search to find options,
* reservation provider to check tables,
* messaging to coordinate with someone else.

The procedure is assembled based on the goal.
That is closer to:
Adam can do things.
rather than:
Adam has 147 features.

## 26. The important exception: hardcode authority and boundaries
The conversation explicitly did not advocate putting everything under model discretion.
Some things should be deterministic.
Examples:

* financial authorization,
* destructive operations,
* account deletion,
* security changes,
* identity changes,
* permission escalation,
* revealing private data,
* irreversible commitments,
* signing agreements,
* sending large amounts of money.

The model might decide:
“Buying this would satisfy the goal.”
But the policy layer should decide:
“This transaction requires explicit approval.”
The model should not be able to reason around hard safety or authority rules.
A concise principle emerged:
Hardcode constraints; don’t hardcode intelligence.
And an even more precise version:
Reasoning can be probabilistic. Authority should not be.

## 27. The README problem became an architectural signal
The fact that a model inspecting the repository concluded:
“This is a shopping automation agent”
was treated as significant.
It might not mean the code was badly written.
But it suggested that shopping-specific concepts had become prominent enough to define the apparent identity of the system.
For the intended product, an engineer looking at the architecture should instead conclude:
“This is a general-purpose agent runtime that can operate connected digital environments.”
Shopping should appear as an application of the runtime.
Not the runtime itself.

## 28. The product and technical theses finally converged
This was perhaps the most important point before the conversation moved into actual codebase refactoring.
The consumer-facing product vision and the internal architecture began to align.
The consumer experience should be:
“Adam can just do that.”
The implementation can be incredibly complicated.
But every piece of complexity should ideally compound into more general capability.
An improvement to browser reliability should improve:

* shopping,
* booking,
* form filling,
* account management,
* research,
* configuration,
* other future tasks.

An improvement to memory should improve the whole system.
An improvement to permissions should apply everywhere.
An improvement to verification should benefit every action.
The wrong architecture creates a new pile of code every time a new human task is introduced.
The right architecture creates a smaller number of reusable primitives whose combinations produce more and more behaviour.
The principle became:
Maximum general capability from the smallest coherent set of reusable primitives, reasoning systems and deterministic boundaries.

## 29. How this relates back to the home hardware company
This architecture mattered because of the home-device vision.
If Adam is supposed to become something physically present in the home, it cannot realistically be built as:

* shopping feature,
* reminder feature,
* form feature,
* email feature,
* delivery feature,
* settings feature,
* calendar feature,
* etc.

The household will ask unpredictable things.
Examples could include:

* “Order more detergent.”
* “Tell Dad I’ve left.”
* “Change the thermostat.”
* “Cancel that subscription.”
* “Fill that form in.”
* “Move my dentist appointment.”
* “Remind me when Sarah gets home.”
* “Find where that delivery went.”
* “Change my permission settings.”
* “Delete that memory.”
* “Book dinner.”
* “Send this back.”
* “Call them.”
* “Find out why I was charged.”
* “Don’t let me spend more than £100 this week.”
* “Sort this out.”

You cannot predict all of those and build one feature per activity.
The home product therefore practically requires the general agent architecture.
That is why the software work still matters even if the company ultimately presents itself as a consumer hardware company.
The software is not the product thesis.
It is the capability foundation that allows the physical product to feel alive and broadly competent.

## 30. The deeper company thesis at this point
By the end of the pre-refactor discussion, the company was no longer simply:
“AI assistant hardware.”
Nor merely:
“a better Alexa.”
Nor:
“a general agent.”
The emerging thesis was closer to:
Build a persistent home computer whose purpose is to take genuine cognitive and logistical weight off the people living there.
The device should:

* be always available,
* understand context,
* act proactively,
* operate software,
* interact with services,
* understand the household,
* remember useful things,
* manage recurring responsibilities,
* coordinate people,
* surface the right information at the right moment,
* and be capable of doing ordinary digital tasks without those tasks each needing to exist as bespoke product features.

The underlying intelligence can come from different providers.
The important asset is the layer that turns intelligence into reliable household agency.

## 31. What the company should not become
A recurring negative definition also became clear.
Adam should not become:
Another chatbot
Even if it is very smart.
Another browser agent
Browser use is infrastructure.
Another connector platform
Email/calendar access alone is increasingly ordinary.
Another shopping agent
Shopping should simply be one thing Adam can do.
Another smart speaker
Music, timers and voice Q&A are insufficient.
Another general-purpose “AI companion”
Too vague.
Another model company
The user does not want to compete on foundational intelligence.
A giant collection of workflows
That would become impossible to maintain and would miss the conceptual goal.

## 32. The preferred emotional experience
A strong recurring intuition throughout the conversation was that the user should not think in terms of features.
They should not think:
“Does Adam have a feature for this?”
The ideal reaction is:
“I’ll ask Adam.”
Or eventually:
“Adam, deal with this.”
That is a very different product relationship.
The system becomes less like software that offers a menu and more like an entity entrusted with responsibility.
For that to work, though, it needs:

* broad competence,
* persistence,
* reliability,
* boundaries,
* transparency,
* verification.

Without those, “just deal with it” becomes dangerous or frustrating.

## 33. The importance of proactivity
Proactivity was repeatedly highlighted as one of the few areas where the home device could genuinely differ from phones and standard assistants.
But “proactive” does not mean randomly interrupting users.
It means recognizing when:

* a previously stated intention is relevant,
* the physical context is appropriate,
* a commitment is about to be missed,
* a household event has changed,
* someone has arrived,
* something is about to run out,
* a delivery needs attention,
* a deadline is approaching,
* an action can now proceed.

The best proactive moment is one where the user thinks:
“I’m glad it caught that.”
not:
“Why is this thing talking to me?”
That implies Adam needs both:

* long-running state,
* context-sensitive judgement.


## 34. Shared household intelligence versus personal assistant
The home-device idea also naturally broadened from a purely personal assistant.
A phone is personal.
A household computer can mediate between multiple people.
Potential concepts include:

* individual identities,
* household context,
* shared commitments,
* person-specific privacy,
* shared shopping,
* household rules,
* shared routines,
* person-specific preferences,
* presence detection.

For example:
“Remind Tom when he gets back.”
This is naturally a home-level action.
Or:
“If Mum gets home before me, tell her the delivery is in the porch.”
Again, the device exists inside the relevant shared environment.
This could become one of the strongest reasons the hardware should exist.

## 35. Why the user kept returning to hardware despite the difficulty
The user was aware that hardware is harder.
It involves:

* manufacturing,
* supply chain,
* capital,
* industrial design,
* certification,
* margins,
* support,
* inventory,
* logistics.

But it still appealed because hardware creates a distinct physical surface.
Rather than fighting for attention inside:

* a phone,
* a browser,
* an app store,
* a notification tray,

Adam can occupy its own place in the home.
That creates the possibility of becoming habitual and ambient rather than another application users need to remember to open.
The preference for consumer hardware was not really about liking gadgets.
It was about wanting a product with a tangible, independent place in someone’s life.

## 36. The concern about competition remained unresolved
None of this removed competitive pressure.
Amazon and Google obviously have:

* hardware,
* distribution,
* smart-home ecosystems,
* voice infrastructure,
* cloud scale,
* installed bases.

Apple has a strong device ecosystem.
OpenAI and Anthropic have stronger model access and rapidly improving agent capabilities.
So the company cannot win merely because:
“We have a voice assistant in a speaker.”
The hoped-for wedge is that incumbents may continue thinking in terms of:

* assistants,
* smart-home controls,
* music,
* Q&A,
* ecosystem integration.

Whereas Adam could be designed around:
household responsibility and agency from day one.
Whether that distinction is sufficiently large remains something that would need to be proven through actual usage.

## 37. What would constitute proof
The conversation became more skeptical of hypothetical enthusiasm.
The user repeatedly wanted proof of need, not just persuasive narratives.
For the home product, meaningful evidence would include behaviour such as:

* people using it every day,
* people delegating genuinely important tasks,
* the system preventing missed commitments,
* households adding more responsibilities over time,
* people becoming annoyed if it stops working,
* users refusing to give the device back after a trial.

A strong signal is dependency.
Not unhealthy dependency, but the same mundane infrastructural dependency people have on:

* maps,
* phones,
* calendars,
* washing machines,
* broadband.

Something where after adoption the user thinks:
“I don’t want to go back to doing that myself.”
That remains the ultimate product target.

## 38. The philosophical distinction between capability and feature
This might be the most important technical/product insight in the entire conversation.
A feature is something a product designer anticipates.
A capability is something that lets the system handle cases the designer did not individually anticipate.
For example:
Feature thinking
“Users may want to order toothpaste. Build toothpaste ordering.”
Then:
“Users may want groceries. Build grocery ordering.”
Then:
“Users may want returns. Build returns.”
Then:
“Users may want restaurant bookings. Build restaurant booking.”
Capability thinking
Give Adam the ability to:

* understand goals,
* navigate environments,
* perceive state,
* manipulate interfaces,
* retrieve information,
* communicate,
* transact,
* ask for authorization,
* verify outcomes.

Then many specific behaviours become combinations of the same substrate.
That is why the user’s reaction to “shopping skill” was important.
From a human perspective, shopping is not a discrete software feature.
It is an activity enabled by general abilities.
Adam should aspire to the same conceptual structure.

## 39. But reliability may still justify specialized optimization
The conversation did not fully resolve the tension between:

* generality,
* reliability.

A fully general agent might theoretically be able to navigate any website.
But a specialized implementation may be:

* faster,
* safer,
* more predictable,
* cheaper,
* more robust.

So domain-specific optimization is not inherently bad.
The issue is whether specialized logic becomes the only path.
The healthier model is:
general ability first, optimized playbooks/recipes second.
For example, if Adam knows a retailer very well, it may use a reliable fast path.
But if that path disappears, Adam should still be able to reason from the webpage and complete the task more slowly.
That gives both:

* generality,
* performance.


## 40. The ideal abstraction boundary
A concise abstraction boundary emerged:
Intelligence asks:
“What needs to happen?”
Capability layer answers:
“What actions can I perform?”
Environment says:
“What is currently true?”
Policy layer says:
“What am I allowed to do?”
Verification says:
“Did the desired state actually happen?”
This avoids mixing:

* reasoning,
* authority,
* UI manipulation,
* persistence,
* domain assumptions.

That architecture naturally supports both:

* consumer-facing flexibility,
* safety.


## 41. Why verification matters
One subtle but important point was that an agent should not confuse:
“I tried”
with:
“It happened.”
For example:

* Clicking “submit” does not mean the application was submitted.
* Sending a command does not mean the smart device changed state.
* Clicking checkout does not mean payment succeeded.
* Typing into a form does not mean the data saved.
* Sending an email does not necessarily mean it was accepted if an API failed.
* Changing a setting should be followed by checking that the setting really changed.

Verification therefore belongs in the general agent model.
The system should repeatedly move toward a desired world state, not merely execute actions.

## 42. The emerging product language
Several formulations emerged across the discussion.
Earlier:
Adam is the place from which you control your digital life.
Later, after the home pivot:
Adam takes care of your home and the life that happens around it.
Another implicit promise:
Adam can just do things.
And perhaps the clearest end-state interaction:
“Adam, deal with this.”
All point toward the same philosophy:
The user should state:

* outcomes,
* preferences,
* constraints.

Adam should handle the operational middle.

## 43. What remained uncertain before code refactoring
Even by the end of the discussion, several things were not settled.
Exact first customer
Would Adam initially target:

* solo users,
* couples,
* families,
* busy professionals,
* elderly households,
* parents,
* flatmates?

Not resolved.
Exact first hardware shape
Possibilities might include:

* smart-speaker-like object,
* small screen,
* display-less speaker,
* room hub,
* multiple distributed nodes.

Not resolved.
Exact sensor set
Potential:

* microphones,
* speakers,
* presence detection,
* mmWave,
* temperature,
* cameras perhaps not desirable,
* other environmental sensors.

Not resolved.
Pricing
Possible numbers like:

* £99,
* £149,
* £199,

were floated conceptually, but not validated.
Subscription
The broader preference remained that hardware should remain useful without forcing a mandatory ongoing subscription, while premium intelligence could potentially be optional.
Distribution
Not solved.
The killer behaviour
The broader category was getting clearer, but the single behaviour that makes people immediately buy Adam remained to be discovered.
This is still a critical open question.

## 44. What had become much clearer
Despite those open questions, several things were substantially clearer.
Adam is not primarily a model company
Do not compete on raw intelligence.
Adam is not primarily a software assistant company
Software is the enabling layer.
Adam is a consumer hardware ambition
The physical product matters.
The home is the preferred surface
Because it is less saturated and uniquely supports shared ambient context.
The device must earn its physical existence
Presence, sharedness, ambient access, contextual proactivity.
The system should be broadly capable
Not a feature catalogue.
Domain logic should be optional knowledge
Not the foundation.
Authority must remain deterministic
Especially around money and irreversible actions.
The product should take responsibility
Not simply answer questions.
Real demand must be proven experimentally
Not assumed from AI enthusiasm.

## 45. The point immediately before codebase refactoring
The conversation finally reached a practical engineering question:
If Adam is meant to be generally capable, does the current code reflect that?
The user suspected:
“There is so much code that needs to be ripped out.”
They believed there might be a way to retain all existing capability with dramatically less code because the current system may have accumulated special-purpose implementations.
The concern was especially strong around shopping.
The desired engineering direction became:
Preserve capability while replacing domain-specific execution paths with reusable primitives and a general agent runtime.
That is the exact point where the conversation moved from:

* company direction,
* consumer hardware,
* product thesis,
* general agency philosophy,

into:

* repository architecture,
* auditing modules,
* deleting code,
* moving browser primitives,
* payment gates,
* routing,
* capability tests.

Everything after that belongs to the codebase-refactoring chapter rather than this pre-refactor product discussion.

## 46. Condensed thesis from the entire discussion
If the whole conversation before refactoring had to be compressed into one coherent view, it would be:
Adam should probably remain a consumer hardware company, with the home as its first and most natural computing surface.
The goal is not to make another smart speaker, another chatbot, another AI model, or another agent with browser/email access.
The product should become a home computer whose responsibility is to take useful cognitive and logistical weight off the people who live there.
It should be:

* persistent,
* ambient,
* proactive,
* shared when appropriate,
* aware of context,
* capable of interacting with digital services,
* able to remember,
* able to coordinate,
* able to act,
* able to wait,
* able to verify outcomes.

The underlying agent should not be built as a collection of hardcoded human tasks.
Shopping, form filling, booking, replying, account management and future activities should ideally arise from general reusable capabilities.
Domain-specific knowledge may improve execution, but should not define the architecture.
The model handles reasoning.
The capability layer provides actions.
The environment provides state.
The policy layer enforces authority.
Verification confirms outcomes.
The consumer should never care about any of this.
They should simply experience:
“Adam can deal with things for me.”
And the ultimate proof that the company matters will not be benchmark scores or number of integrations.
It will be whether, after living with Adam, people genuinely feel that running their home and their life becomes harder when it is removed.
That was the core direction reached before the conversation turned into actual codebase refactoring.

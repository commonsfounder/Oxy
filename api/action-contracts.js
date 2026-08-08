// Default identity selection for outbound messaging — not a UI mode, purely which tool the
// model reaches for. Millie has her own persistent email/phone identity (send_millie_email/
// send_millie_sms); the user also has their own connected mailbox/device (send_email/
// send_outlook_email/send_message). Nothing distinguished these before, so the model
// defaulted to whichever tool it already knew best (send_email), even for messages that were
// clearly Millie acting as the user's representative to a third party. Live-verified
// 2026-08-07: explicit steering, not just tool availability, is what actually changes which
// one gets picked.
const MILLIE_IDENTITY_GUIDANCE = 'Use this by default whenever Millie is contacting a business, support line, restaurant or booking, delivery or vendor service, or any external organization or stranger on the user\'s behalf — this is the normal case for requests like "email/text the restaurant and ask if they can move us to 8." Do not use this for the user\'s own personal correspondence — friends, family, work or school contacts, job applications, or anything where the sender should clearly be the user, not Millie — use the user\'s own connected mailbox/device for that instead. Millie signs as herself; never impersonate the user.';
const PERSONAL_IDENTITY_GUIDANCE = 'Use this only when the user is personally corresponding as themselves — friends, family, work or school contacts, job applications, or any personal correspondence where the sender should clearly be the user. If the user is contacting a business, support line, restaurant, vendor, delivery service, or any external organization or stranger with Millie acting on their behalf, use send_millie_email instead, unless the user explicitly says to send it from their own account.';
const PERSONAL_SMS_IDENTITY_GUIDANCE = 'This sends from the user\'s own phone via their device\'s Messages app — always their own identity, never Millie\'s. Fine for personal contacts (friends, family, colleagues). If the user is contacting a business, support line, restaurant, vendor, or any external organization or stranger with Millie acting on their behalf, use send_millie_sms instead so it comes from Millie\'s own number.';

// Shared messaging-register guidance for conversational channels (iMessage/WhatsApp/Telegram).
// Moved out of the numbered prompt rules — this is squarely about how to construct THIS
// argument, not general behaviour, so it belongs on the tool, not in the static prompt.
const CONVERSATIONAL_MESSAGE_GUIDANCE = 'Keep the message brief, natural, and text-like: rewrite the requested content into an actual first-person message addressed to the contact, matching the register of any recent messages with them. Never paste a "saying X" clause verbatim as the message body — e.g. "saying how much I miss her" must become something like "I miss you so much", not "how much i miss her".';

// Shared email tone/quality guidance, appended to both the user's-own-account and
// Millie's-own-identity email contracts.
const EMAIL_TONE_GUIDANCE = 'Draft the body as 1-3 short paragraphs. Default tone is warm, clear, and human — most email is professional or corporate, so use polished business language when the thread calls for it, but avoid empty cliches like "I hope this email finds you well", "I am writing to", "please do not hesitate", and "kindly" unless the thread or user specifically warrants that formality. If the user specifies a tone (casual, friendly, firm, apologetic, confident, less desperate, short, professional), make the draft visibly follow it. If the user gives no real content (e.g. only "say hello" or "introduce myself"), ask for the actual substance before sending — never send a placeholder or generic template body; it must contain specific content from the user, the conversation, memory, or tool results.';

const ACTION_CONTRACTS = {
  send_message: {
    risk: 'medium',
    required: ['contact', 'message'],
    aliases: { message: ['body', 'text', 'content'] },
    inputExample: { contact: 'name', message: 'text' },
    guidance: `${PERSONAL_SMS_IDENTITY_GUIDANCE} ${CONVERSATIONAL_MESSAGE_GUIDANCE}`,
    successSummary: 'Message ready',
    failureSummary: 'Message failed',
    confirmation: 'none',
    executionMode: 'direct'
  },
  make_call: {
    risk: 'high',
    required: ['contact'],
    inputExample: { contact: 'name' },
    successSummary: 'Call opened',
    failureSummary: 'Call failed',
    confirmation: 'review_required',
    executionMode: 'review'
  },
  create_reminder: {
    risk: 'medium',
    required: ['title', 'due_date'],
    inputExample: { title: 'reminder', due_date: 'ISO date' },
    paramHints: { due_date: 'ISO date' },
    successSummary: 'Reminder created',
    failureSummary: 'Reminder failed',
    confirmation: 'none'
  },
  play_music: {
    risk: 'low',
    required: ['query'],
    inputExample: { query: 'search term' },
    guidance: 'For requests that depend on current facts, charts, rankings, popularity, or trends ("most popular song", "top song", "right now", "Billboard Hot 100"), first resolve the exact title/artist via search grounding — never pass a vague query like "most popular song" directly. If you cannot verify the current result, say you need to check instead of guessing.',
    successSummary: 'Music opened',
    failureSummary: 'Music failed',
    confirmation: 'none'
  },
  add_to_music_playlist: {
    risk: 'medium',
    required: ['query'],
    optional: ['playlist'],
    aliases: { playlist: ['playlistName', 'list'] },
    inputExample: { query: 'song or album', playlist: 'optional playlist name' },
    guidance: 'Use when the user asks to add a song or album to their music library or playlist — use play_music instead for immediate playback.',
    successSummary: 'Music added',
    failureSummary: 'Music add failed',
    confirmation: 'none'
  },
  create_calendar_event: {
    risk: 'medium',
    required: ['title', 'start_date', 'end_date'],
    inputExample: { title: 'event', start_date: 'ISO date', end_date: 'ISO date' },
    paramHints: { start_date: 'ISO date', end_date: 'ISO date' },
    successSummary: 'Calendar updated',
    failureSummary: 'Calendar failed',
    confirmation: 'review_required',
    executionMode: 'review',
    guidance: 'Use only when the user explicitly asks to add, create, schedule, book, put, make, or set up a calendar event. Never use for read-only calendar language such as check, read, show, look at, what is on, or tell me. Calendar beats music: if the user says calendar, schedule, or event, do not use play_music or add_to_music_playlist just because the phrase contains "add".'
  },
  get_calendar_events: {
    risk: 'low',
    required: [],
    inputExample: { max_results: 5 },
    successSummary: 'Calendar checked',
    failureSummary: 'Calendar failed',
    confirmation: 'none'
  },
  find_appointment_options: {
    risk: 'low',
    required: ['request'],
    optional: ['task_id'],
    inputExample: { request: 'dentist appointment next week after work' },
    guidance: 'This only works when a real appointment-booking connection is configured — today that is not the normal case, so expect it to fail with a "not connected" error. Do not repeat this call after that error and do not tell the user booking is impossible. Instead use run_browser_task to book directly through the business\'s own real website: find the business first if you don\'t have it, then treat the booking as a normal multi-step order (find the slot, fill the form, confirm through the same review-before-payment flow).',
    successSummary: 'Appointment options found',
    failureSummary: 'Appointment search paused',
    confirmation: 'none',
    executionMode: 'direct'
  },
  book_appointment: {
    risk: 'high',
    required: ['task_id', 'choice_id'],
    optional: ['choice_label'],
    inputExample: { task_id: 'saved appointment task', choice_id: 'chosen slot', choice_label: 'Tue 11 Aug at 6:00 pm' },
    successSummary: 'Appointment confirmed',
    failureSummary: 'Appointment not confirmed',
    confirmation: 'review_required',
    executionMode: 'review'
  },
  send_email: {
    risk: 'high',
    required: ['to', 'body'],
    optional: ['subject', 'tone', 'context', 'thread_id', 'in_reply_to', 'references', 'sender_name', 'sender_address'],
    aliases: { to: ['email', 'recipient'], body: ['message', 'content', 'text'] },
    inputExample: {
      to: 'email',
      subject: 'optional subject inferred from the body if omitted',
      body: 'polished complete email draft based on the user intent, not a terse literal fragment',
      tone: 'optional requested tone such as casual, warm, professional, apologetic, direct',
      thread_id: 'optional Gmail thread ID for replies'
    },
    // These two travel on the PARAMETER itself, not only the tool-level guidance below: a
    // function-calling model weighs a per-argument description more heavily when constructing
    // that argument than prose several fields away, and "terse literal fragment" is the exact
    // failure mode this guards against (turning "email him saying running late" into a body
    // that literally reads "running late").
    paramHints: {
      body: 'a polished, complete email draft — never a terse literal fragment of what the user said',
      tone: 'e.g. casual, warm, professional, apologetic, direct'
    },
    guidance: `If the user gives enough substance, draft the full email body with an appropriate greeting, natural structure, and sign-off. Match any requested tone. Do not ask for a subject. Do not use stiff cliches. For Gmail replies, use the provided full thread context, sender details, memory about the sender, and user communication preferences; include thread_id/in_reply_to/references when available. Match both the user tone and the thread formality: professional for business threads, casual for casual threads. Do not add fake warmth or unnecessary pleasantries, and stop when the point is made. ${EMAIL_TONE_GUIDANCE} ${PERSONAL_IDENTITY_GUIDANCE}`,
    successSummary: 'Email sent',
    failureSummary: 'Email failed',
    confirmation: 'review_required',
    executionMode: 'review'
  },
  send_millie_email: {
    risk: 'medium',
    required: ['to', 'body'],
    optional: ['subject', 'request_task_id'],
    aliases: { to: ['email', 'recipient'], body: ['message', 'content', 'text'] },
    inputExample: {
      to: 'business or contact email address',
      subject: 'optional subject inferred from the body if omitted',
      body: 'the message to send, on the user\'s behalf',
      request_task_id: 'optional id of the ongoing request this belongs to'
    },
    guidance: MILLIE_IDENTITY_GUIDANCE,
    successSummary: 'Message sent from Millie',
    failureSummary: 'Message failed to send',
    confirmation: 'review_required',
    executionMode: 'review'
  },
  send_millie_sms: {
    risk: 'medium',
    required: ['to', 'body'],
    optional: ['request_task_id'],
    aliases: { to: ['phone', 'recipient'], body: ['message', 'content', 'text'] },
    inputExample: {
      to: 'business or contact phone number, e.g. +447700900123',
      body: 'the message to send, on the user\'s behalf',
      request_task_id: 'optional id of the ongoing request this belongs to'
    },
    guidance: MILLIE_IDENTITY_GUIDANCE,
    successSummary: 'Message sent from Millie',
    failureSummary: 'Message failed to send',
    confirmation: 'review_required',
    executionMode: 'review'
  },
  get_emails: {
    risk: 'low',
    required: [],
    optional: ['max_results', 'label', 'labels'],
    inputExample: { max_results: 5, label: 'INBOX' },
    successSummary: 'Emails checked',
    failureSummary: 'Email check failed',
    confirmation: 'none'
  },
  search_emails: {
    risk: 'low',
    required: ['query'],
    inputExample: { query: 'search term', max_results: 5 },
    successSummary: 'Emails searched',
    failureSummary: 'Email search failed',
    confirmation: 'none'
  },
  // Real Gmail mutation: archiving removes the INBOX label — the message still exists and
  // stays searchable, it just isn't in the inbox view. Reversible, low-risk; never trashes
  // or permanently deletes. No confirmation needed for the same reason "search" doesn't:
  // the risk is low and the action is exactly what was asked for.
  archive_emails: {
    risk: 'low',
    required: ['message_ids'],
    inputExample: { message_ids: ['18abc123', '18abc456'] },
    guidance: 'Bulk-archives real Gmail messages by removing the INBOX label — reversible, not deletion. Pass every message id you want archived in one call rather than calling this once per message.',
    successSummary: 'Emails archived',
    failureSummary: 'Archive failed',
    confirmation: 'none',
    executionMode: 'direct'
  },
  // Also how mark-read/unread works (UNREAD is just another label) — no separate action
  // needed for that.
  label_emails: {
    risk: 'low',
    required: ['message_ids'],
    optional: ['add_labels', 'remove_labels'],
    inputExample: { message_ids: ['18abc123'], add_labels: ['RECEIPTS'], remove_labels: ['UNREAD'] },
    guidance: 'Bulk add/remove real Gmail labels. To mark read, remove_labels:["UNREAD"]; to mark unread, add_labels:["UNREAD"]. Low-risk and reversible — safe to do directly.',
    successSummary: 'Labels updated',
    failureSummary: 'Label update failed',
    confirmation: 'none',
    executionMode: 'direct'
  },
  unsubscribe_email: {
    risk: 'low',
    required: ['message_id'],
    inputExample: { message_id: '18abc123' },
    guidance: 'Real, tiered unsubscribe for one message\'s mailing list: a genuine RFC 8058 one-click POST when the provider declares support, or a real email sent to a mailto: unsubscribe address. Only ever reports success for one of those two things actually completing — never for merely finding or opening a link. If the result has needsBrowser:true, the unsubscribe link needs a real page visit to finish: follow up with run_browser_task on the given url and confirm the page shows an actual success message before telling the user it worked. Prefer clean_inbox over calling this directly for a broad request ("unsubscribe from X", "clean my inbox") — it already finds every matching message and handles unsubscribing per distinct sender.',
    successSummary: 'Unsubscribed',
    failureSummary: 'Unsubscribe failed',
    confirmation: 'none',
    executionMode: 'direct'
  },
  // The natural-language entry point for "clean my inbox" / "archive this junk" /
  // "unsubscribe me from X and clear the old emails" — orchestrates a real Gmail search, the
  // EXISTING shared triage classifier (not a second one), real bulk archive, and real
  // per-sender unsubscribe attempts in one call, so a 200-email cleanup doesn't need 200
  // conversational turns.
  clean_inbox: {
    risk: 'low',
    required: [],
    optional: ['sender', 'since', 'before', 'unsubscribe_senders', 'query', 'max_results'],
    inputExample: {
      sender: 'optional — e.g. "temu.com" or "Temu" to scope to one sender',
      since: 'optional ISO date — only mail after this date',
      before: 'optional ISO date — only mail before this date (e.g. "older than a month")',
      unsubscribe_senders: 'optional boolean, default true — also attempt to unsubscribe from matched mailing lists',
      max_results: 300
    },
    paramHints: { since: 'ISO date', before: 'ISO date' },
    guidance: 'Use for any broad cleanup request — "clean my inbox", "archive all this junk", "get rid of these promotional emails", "archive newsletters older than a month", "unsubscribe from X and clear the old emails". Classifies every matched message individually (a sender is never treated as globally junk — one promotional email from a retailer does not mean their receipts get archived too) and only touches what is clearly promotional/bulk; anything that looks like it needs attention is left alone. Never guesses required fields into existence — call it with whatever scope the user actually gave (sender/date range) or no scope at all for a general cleanup, do not ask for a full spec before doing it. Report the real counts back (archived/preserved/unsubscribed/failed) — never a generic "done, inbox cleaned".',
    successSummary: 'Inbox cleaned up',
    failureSummary: 'Inbox cleanup failed',
    confirmation: 'none',
    executionMode: 'direct'
  },
  // Thread-level "does this need something from the user" judgment — deliberately not the
  // same question as email triage (is this message urgent/promotional). Unread does not mean
  // needs-reply; read does not mean handled.
  find_reply_needed: {
    risk: 'low',
    required: [],
    optional: ['max_threads'],
    inputExample: { max_threads: 20 },
    guidance: 'Use for "who\'s waiting on me?", "is anyone waiting on me?", "what have I ignored?", "catch me up on what I need to answer", or a recurring "every morning tell me who I owe a reply to". Judges each thread on whether ITS CURRENT STATE needs a reply or a small concrete action from the user — not on unread/read status, and not on a fixed "older than N days" rule. A thread the user already substantively answered is excluded even if the other person hasn\'t replied again; a thread where the user\'s own last message was an unfulfilled commitment ("I\'ll send this over") still counts, because the user is the blocker. Newsletters, receipts, and automated notifications never count, even unread. When the result includes multiple items and the user asks to draft replies "to all of them" (or similar), call send_email once per thread that needs a REPLY (not one that needs a non-reply action) — each draft grounded ONLY in that thread\'s own content (never blend context between threads). Attempt a real draft for every such thread using what the thread already contains: acknowledging receipt, confirming a detail the sender already stated, or answering a question the thread itself answers all count as "enough to draft" — do not decline an entire batch, or an individual thread, just because one fact you don\'t have yet (a decision, a number, a date) would make it more complete; write the best honest draft around that gap instead (e.g. leave a placeholder or a short bracketed note for the missing piece) and only ask the user outright when a thread\'s reply cannot be written in any real form without a specific fact only they have (e.g. proposing a time when none was suggested). One thread needing a quick question back is never a reason to skip drafting the others. Sends stay review-gated per send_email\'s own guidance; that review is expected, not a problem to route around. For a recurring version, pair this with create_scheduled_task (recurrence:\'daily\', no condition needed — every run re-judges the real current inbox state, it does not replay a stored list).',
    successSummary: 'Checked who needs a response',
    failureSummary: 'Could not check who needs a response',
    confirmation: 'none',
    executionMode: 'direct'
  },
  // Real trip planning: a grounded web search feeds itinerary-engine.js's generation, so
  // opening hours/prices/closures/travel-time claims come from an actual current search, not
  // model recall. Deliberately does not touch search_flights/search_hotels (see their own
  // guidance) or itinerary-engine.js's dormant hotels/activities/flights fields — nothing real
  // populates those today.
  // Named plan_itinerary, not plan_trip: plan_trip already exists (below, near search_trains)
  // as a train/route planner between two points — a different, unrelated capability. Do not
  // rename either without checking both.
  plan_itinerary: {
    risk: 'low',
    required: ['destination'],
    optional: ['origin', 'start_date', 'end_date', 'duration_days', 'party_size', 'budget', 'budget_currency', 'transport_mode', 'interests', 'dietary', 'accessibility', 'pace', 'already_done', 'notes'],
    inputExample: { destination: 'Bath', start_date: 'Saturday', duration_days: 2, party_size: 2, budget: 200, budget_currency: '£', interests: ['culture', 'food'] },
    paramHints: {
      interests: 'array of interest keywords, e.g. ["culture","food","outdoors"]',
      dietary: 'array of dietary requirements, e.g. ["vegetarian"]',
      already_done: 'anything the user says they have already done/seen, so it is not repeated',
      pace: 'e.g. "relaxed, do not want to rush" or "pack in as much as possible"'
    },
    guidance: 'Use for "plan me a trip to X", "plan Saturday in X", a weekend/day trip, or any request for a real day-by-day plan — not for a single fact lookup (use web_search for that), and not the same thing as plan_trip (that is a point-to-point route/train planner, not a day-by-day itinerary). Always call this tool for that, even if you could piece a plan together yourself from your own web_search calls first — a hand-written itinerary in chat prose cannot be saved or edited later; only the structured itinerary this action returns can. Extract every constraint the user actually stated (dates, arrival/departure times, starting location, budget, who is going, transport limits, interests, food preferences, things already booked or already done, accessibility, "keep it walkable", "do not want to rush") into the matching parameter; do not invent constraints the user never gave. The result is a real, time-aware plan grounded in an actual web search done inside this call — do not also call search_flights/search_hotels to "fill in" the itinerary, they only build a browser link and return no real prices or availability. If the user then asks to save it, call workspace_write with a path like trips/<destination>-<date>.json and the CONTENT SET TO THE FULL ITINERARY JSON THIS ACTION RETURNED (not a prose summary) — that is what makes it editable later via modify_itinerary. If asked to add it to the calendar, call create_calendar_event a small number of times for the genuinely meaningful blocks (e.g. one per day or per booked/timed item), never one event per itinerary line. Planning and booking are separate: if the user asks to actually book a hotel, buy tickets, or reserve something from the plan, use run_browser_task against the real site — never say something was booked unless that flow actually confirmed it.',
    successSummary: 'Itinerary planned',
    failureSummary: 'Could not plan that trip',
    confirmation: 'none',
    executionMode: 'direct'
  },
  modify_itinerary: {
    risk: 'low',
    required: ['instruction'],
    optional: ['itinerary', 'workspace_path'],
    inputExample: { instruction: 'swap the museum for something outdoors', itinerary: '{...the itinerary object plan_itinerary returned...}' },
    paramHints: {
      itinerary: 'the exact itinerary JSON object returned by the most recent plan_itinerary call in this conversation — pass it back as-is, do not retype it from memory',
      workspace_path: 'path of a previously saved itinerary (from workspace_write) to load and edit instead, when the itinerary is not already in this conversation'
    },
    guidance: 'Use for incremental edits to a real itinerary — "swap the museum for something outdoors", "move dinner later", "we actually arrive at 12", "cut £30 from the budget" — never for building a new trip from scratch (use plan_itinerary for that). Prefer passing the itinerary you already have from a recent plan_itinerary result; only use workspace_path when the trip was saved earlier and is not already in view. This updates only what the instruction asks for and leaves the rest of the plan intact, unlike calling plan_itinerary again which would regenerate everything.',
    successSummary: 'Itinerary updated',
    failureSummary: 'Could not update the itinerary',
    confirmation: 'none',
    executionMode: 'direct'
  },
  // Durable occasion data (occasions table) — NOT the memories table, which is free-text
  // only and can't reliably answer "whose birthday is coming up?" without re-parsing prose.
  save_occasion: {
    risk: 'low',
    required: ['person_name', 'month', 'day'],
    optional: ['occasion_type', 'year', 'relationship', 'notes', 'remind_days_before', 'remind_on_day'],
    inputExample: { person_name: 'Alisa', occasion_type: 'birthday', month: 7, day: 12, remind_days_before: 14 },
    paramHints: {
      month: 'integer 1-12',
      day: 'integer, valid for that month',
      year: 'birth year, only if the user actually stated it — never guess an age',
      relationship: 'e.g. "mum", "sister", "friend" — only if stated',
      remind_days_before: 'integer number of days before the date to send a reminder, e.g. 14 for "a couple weeks before"',
      remind_on_day: 'true only for "remind me on the day" with no lead time — do not combine with remind_days_before'
    },
    guidance: 'Use whenever the user states a birthday/anniversary ("Mum\'s birthday is October 8", "Alisa\'s birthday is 12 July") or explicitly asks you to remember one — this is what makes "whose birthday is coming up?" answerable later, so call it immediately when the date is stated, not just when asked to set a reminder. Only capture what was actually said: never invent a year/age from a guess, and do not aggressively ask everyone for their birthday — capture naturally when it comes up, or in bulk if the user offers a list. Re-saving the same person/occasion updates the existing entry rather than duplicating it, so correcting a mistake ("actually it\'s the 9th") is just calling this again. If the user gives a reminder preference ("remind me a couple weeks before", "remind me every year", "remind me on the day"), set remind_days_before (or remind_on_day) in THIS SAME call — it schedules the real reminder via create_scheduled_task internally and keeps re-arming itself yearly; do not call create_scheduled_task separately for this. If no reminder preference is given, still save the occasion but do not invent one.',
    successSummary: 'Occasion saved',
    failureSummary: 'Could not save that occasion',
    confirmation: 'none',
    executionMode: 'direct'
  },
  find_occasions: {
    risk: 'low',
    required: [],
    optional: ['person_name'],
    inputExample: { person_name: 'Mum' },
    guidance: 'Use for "whose birthday is coming up?", "when is X\'s birthday?", or before helping with a gift so you have the real relationship/notes on file rather than guessing. Always call this rather than answering from memory of the conversation — it is the only way to get a genuinely current, sorted answer. If a gift is then discussed ("what should I get her?", "find something under £50"), use the relationship/notes this returns plus web_search for real, current product options — never invent stock, price, or availability — and hand off to run_browser_task for an actual purchase; never say something was bought until that flow confirms it. Honest when nothing is saved rather than inventing a plausible-sounding answer.',
    successSummary: 'Checked occasions',
    failureSummary: 'Could not check occasions',
    confirmation: 'none',
    executionMode: 'direct'
  },
  // ── People layer ───────────────────────────────────────────────────────────────────
  // Durable answers to "who is this person to me, how do I reach them, what matters about
  // them" — so tone, gift context, recipient selection and "her"/"my manager" stop being
  // rediscovered from scratch each conversation.
  remember_person: {
    risk: 'low',
    required: [],
    optional: ['person_name', 'relationship', 'email', 'phone', 'facts', 'replaces', 'fact_kind', 'business_name', 'different_person'],
    inputExample: { person_name: 'Alisa', relationship: 'girlfriend', facts: 'prefers gold jewellery' },
    paramHints: {
      person_name: 'the name the user actually calls them ("Mum", "Alisa", "James Whitfield")',
      relationship: 'their relationship TO THE USER — e.g. "girlfriend", "manager", "tutor", "mum". Only if stated',
      facts: 'one or more short things worth remembering, separated by semicolons — only what the user actually said or what an assistant task genuinely needs',
      replaces: 'the outdated fact this corrects, e.g. "silver" when the user says she prefers gold — removes it in the same call so the two never both sit on file',
      fact_kind: 'note (default) | preference',
      different_person: 'true only when the user says this is NOT the person you matched, e.g. "that\'s a different James" — forces a new record instead of updating the existing one'
    },
    guidance: 'Use when the user states who someone is or something durable about them — "Alisa is my girlfriend", "Ben is my manager", "Mum likes gardening", "James is my tutor, keep it formal with him" — and when a correction lands ("Alisa prefers gold, not silver" is ONE call with facts:"prefers gold" and replaces:"silver"). Capture naturally when it comes up; never interrogate the user for contact details or hoover up private facts just because they appeared in an email. Store what the user explicitly said, or what an actual assistant task needs (how to address someone, how to reach them, what to buy them) — not everything that could be extracted. An email address or phone number is the strong identity signal: pass it whenever you have one, because that is what makes "Alisa", her address and her saved birthday resolve to one person instead of three. If the name matches more than one saved person, this refuses and returns the candidates rather than guessing — ask which one, and pass different_person:true only if the user says it is someone new. For "Ben isn\'t my manager anymore" or "forget that preference", use forget_person_detail instead.',
    successSummary: 'Noted',
    failureSummary: 'Could not save that',
    confirmation: 'none',
    executionMode: 'direct'
  },
  find_people: {
    risk: 'low',
    required: [],
    optional: ['query', 'relationship', 'email', 'phone'],
    inputExample: { query: 'Mia' },
    paramHints: {
      query: 'a name, or the word the user used for them',
      relationship: 'use this for relationship references — "my manager", "my tutor" — rather than putting them in query'
    },
    guidance: 'Use before acting on a person, not only when asked about them directly: "who is Mia again?", "email my manager" (resolve the real address first — never guess a recipient), "what do I normally get Alisa?", "reply to James more formally, he\'s my tutor", and any "her"/"him"/"them" that refers to a person you do not already have in this conversation. It returns the relationship, known email/phone handles, saved notes/preferences and linked birthdays/anniversaries, so use it to pick the right recipient, match the right tone, and ground gift suggestions in what you actually know rather than a generic guess. If it comes back ambiguous, ask which person rather than picking one. If it returns nothing, say so and ask — do not invent a relationship or an address.',
    successSummary: 'Found',
    failureSummary: 'Could not look that up',
    confirmation: 'none',
    executionMode: 'direct'
  },
  forget_person_detail: {
    risk: 'low',
    required: [],
    optional: ['person_name', 'facts', 'clear_relationship', 'delete_person', 'email', 'phone'],
    inputExample: { person_name: 'Ben', clear_relationship: true },
    paramHints: {
      facts: 'the specific thing(s) to forget — "forget that preference" means the preference, not the person',
      clear_relationship: 'true for "Ben isn\'t my manager anymore"',
      delete_person: 'true only when the user wants the whole person forgotten'
    },
    guidance: 'Use for "Ben isn\'t my manager anymore" (clear_relationship), "forget that preference" / "she doesn\'t like that anymore" (facts), and "forget about X entirely" (delete_person). Remove the narrowest thing the user asked to remove — never delete a whole person to drop one fact. For a correction that replaces one fact with another ("prefers gold, not silver"), use remember_person with replaces instead, so the new fact and the removal happen together.',
    successSummary: 'Forgotten',
    failureSummary: 'Could not forget that',
    confirmation: 'none',
    executionMode: 'direct'
  },
  // The composed "what's on my plate" answer. Not a wrapper around get_calendar_events:
  // it re-reads reply-needed threads, saved occasions, due/overdue reminders, background
  // watch state changes, calendar and pending approvals, and ranks them together.
  daily_digest: {
    risk: 'low',
    required: [],
    optional: ['focus'],
    inputExample: { focus: 'all' },
    paramHints: {
      focus: 'all (default) | urgent — only what needs them now | can_wait — only the low-priority tail'
    },
    guidance: 'Use for "what do I need to know today?", "what\'s on my plate?", "give me my morning brief", "anything I\'m forgetting?", "anything urgent?" and "what can wait?" (focus:"urgent" / focus:"can_wait" for the last two). Always call this rather than separately calling get_calendar_events, find_reply_needed and find_occasions and stitching them together yourself — it already composes all of those plus due/overdue reminders and real background-watch state changes, and it ranks them against each other so the user does not have to triage the answer. Relay the items in the order given and keep it short; do not pad it with things it deliberately left out, and do not invent urgency the result does not claim. Each item carries a ref (threadId, scheduledTaskId, personName, briefingId) — use it for the obvious follow-up rather than re-searching: "draft the reply to Mia" is send_email with that item\'s thread_id, "move that reminder" is create_scheduled_task/cancel_scheduled_task with that scheduledTaskId, "what\'s happening with the parcel?" is a fresh check of that watch. If coverage reports a source it could not check, say so plainly instead of implying the digest is complete. For "every morning tell me what I need to deal with", call create_scheduled_task with recurrence "daily", a morning time, and an instruction that says to call daily_digest and relay the result — never store a copy of today\'s digest text as the instruction, because each morning must be recomputed from that morning\'s real state.',
    successSummary: 'Digest ready',
    failureSummary: 'Could not build your digest',
    confirmation: 'none',
    executionMode: 'direct'
  },
  // Outlook/Microsoft 365 — same risk shape as their Gmail/Calendar counterparts above.
  send_outlook_email: {
    risk: 'high',
    required: ['to', 'body'],
    optional: ['subject'],
    aliases: { to: ['email', 'recipient'], body: ['message', 'content', 'text'] },
    inputExample: { to: 'email', subject: 'optional subject inferred from the body if omitted', body: 'polished complete email draft' },
    guidance: `${EMAIL_TONE_GUIDANCE} ${PERSONAL_IDENTITY_GUIDANCE}`,
    successSummary: 'Email sent',
    failureSummary: 'Email failed',
    confirmation: 'review_required',
    executionMode: 'review'
  },
  get_outlook_emails: {
    risk: 'low',
    required: [],
    optional: ['max'],
    inputExample: { max: 10 },
    successSummary: 'Emails checked',
    failureSummary: 'Email check failed',
    confirmation: 'none'
  },
  search_outlook_emails: {
    risk: 'low',
    required: ['query'],
    inputExample: { query: 'search term' },
    successSummary: 'Emails searched',
    failureSummary: 'Email search failed',
    confirmation: 'none'
  },
  create_outlook_event: {
    risk: 'medium',
    required: ['title', 'start_date', 'end_date'],
    inputExample: { title: 'event', start_date: 'ISO date', end_date: 'ISO date' },
    paramHints: { start_date: 'ISO date', end_date: 'ISO date' },
    successSummary: 'Calendar updated',
    failureSummary: 'Calendar failed',
    confirmation: 'review_required',
    executionMode: 'review',
    guidance: 'Use only when the user explicitly asks to add, create, schedule, book, put, make, or set up a calendar event. Never use for read-only calendar language such as check, read, show, look at, what is on, or tell me. Calendar beats music: if the user says calendar, schedule, or event, do not use play_music or add_to_music_playlist just because the phrase contains "add".'
  },
  get_outlook_events: {
    risk: 'low',
    required: [],
    inputExample: {},
    successSummary: 'Calendar checked',
    failureSummary: 'Calendar failed',
    confirmation: 'none'
  },
  book_uber: {
    risk: 'low',
    required: ['destination'],
    aliases: { destination: ['query', 'place', 'address'] },
    inputExample: { destination: 'natural place or address phrase' },
    guidance: 'Pass the user\'s natural destination phrase (e.g. "get me an Uber to the nearest gym") — never invent a branch address.',
    successSummary: 'Uber opened',
    failureSummary: 'Uber needs attention',
    confirmation: 'none',
    executionMode: 'direct'
  },
  find_place: {
    risk: 'low',
    required: ['query'],
    aliases: { query: ['destination', 'place', 'address'] },
    inputExample: { query: 'natural place or address phrase' },
    guidance: 'For plain local place requests like "nearest gym", "closest McDonald\'s", or "coffee near me", pass the user\'s natural phrase as query — do not ask for a full address or branch details. Never use this for product searches, price lookups, or online shopping, even if the request names a retailer like "John Lewis", "ASOS", or "Amazon" — this is only for physical locations to visit (buildings, stores as places, restaurants). "Find me grey jeans on John Lewis" is a shopping task for run_browser_task, not a place lookup.',
    successSummary: 'Place found',
    failureSummary: 'Place search failed',
    confirmation: 'none'
  },
  get_directions: {
    risk: 'low',
    required: ['destination'],
    optional: ['origin', 'mode', 'arrival_time', 'departure_time'],
    aliases: { destination: ['query', 'place', 'address'], origin: ['from'] },
    inputExample: { origin: 'optional start place or station', destination: 'natural place or address phrase', mode: 'driving|walking|transit', arrival_time: 'optional arrive-by time', departure_time: 'optional leave-at/around time' },
    paramHints: { mode: 'driving|walking|transit' },
    guidance: 'Use only when the user explicitly asks to open a route, navigation, or a ride handoff, or for generic local directions, walking, driving, and bus questions where a route summary is useful. Never pretend a route opened if all you have is a text answer. For live train times, platforms, or journey options, prefer a grounded search answer instead — this tool is not the source of truth for that.',
    successSummary: 'Directions ready',
    failureSummary: 'Directions failed',
    confirmation: 'none'
  },
  plan_trip: {
    risk: 'low',
    required: ['destination'],
    optional: ['origin', 'departure_time', 'arrival_time', 'preference'],
    aliases: { destination: ['query', 'place', 'address', 'to'], origin: ['from'] },
    inputExample: { destination: 'London Euston', origin: 'optional start place or station', departure_time: 'optional leave-at/around time', arrival_time: 'optional arrive-by time', preference: 'balanced|fastest|fewest_changes' },
    paramHints: { preference: 'balanced|fastest|fewest_changes' },
    guidance: 'Use only when the user explicitly asks to open a route, navigation, or a ride handoff for a rail trip. Prefer a grounded search answer over this for live train times, platforms, or journey options — this tool is not the source of truth for that.',
    successSummary: 'Trip planned',
    failureSummary: 'Trip failed',
    confirmation: 'none'
  },
  send_telegram: {
    risk: 'high',
    required: ['contact', 'message'],
    aliases: { message: ['body', 'text', 'content'] },
    inputExample: { contact: 'contact name', message: 'message text' },
    guidance: CONVERSATIONAL_MESSAGE_GUIDANCE,
    successSummary: 'Telegram sent',
    failureSummary: 'Telegram failed',
    confirmation: 'review_required',
    executionMode: 'review'
  },
  get_telegram_contacts: {
    risk: 'low',
    required: [],
    inputExample: {},
    successSummary: 'Telegram contacts checked',
    failureSummary: 'Telegram contacts failed',
    confirmation: 'none'
  },
  search_trains: {
    risk: 'low',
    required: ['origin', 'destination'],
    aliases: { origin: ['from'], destination: ['to'] },
    inputExample: { origin: 'station name or CRS code', destination: 'station name or CRS code' },
    guidance: 'Prefer a grounded search answer over this for live train times, platforms, or journey options — this connector is not the source of truth for that. Use it only when the user explicitly wants a formal train search result.',
    successSummary: 'Train route checked',
    failureSummary: 'Train search failed',
    confirmation: 'none'
  },
  station_board: {
    risk: 'low',
    required: ['station'],
    aliases: { station: ['origin', 'from'] },
    inputExample: { station: 'station name or CRS code' },
    guidance: 'Prefer a grounded search answer over this for live departures, arrivals, or platforms — this connector is not the source of truth for that. Use it only when the user explicitly wants a live station board.',
    successSummary: 'Station board ready',
    failureSummary: 'Station board failed',
    confirmation: 'none'
  },
  forget_memory: {
    risk: 'medium',
    required: ['scope'],
    inputExample: { scope: 'recent|all', query: 'optional memory topic to forget' },
    paramHints: { scope: 'recent|all' },
    guidance: 'Use whenever the user asks to forget, delete, wipe, or remove something from memory — never just say you will do it without calling this. For "forget that" or "delete that from memory", use scope "recent" unless they clearly mean all memory.',
    successSummary: 'Memory updated',
    failureSummary: 'Memory update failed',
    confirmation: 'none'
  },
  generate_visual: {
    risk: 'low',
    required: ['brief'],
    aliases: { brief: ['prompt', 'topic'] },
    inputExample: { brief: 'what to create', style: 'optional style', usage: 'where this visual will be used' },
    successSummary: 'Visual generated',
    failureSummary: 'Visual failed',
    confirmation: 'none'
  },
  create_diagram: {
    risk: 'low',
    required: ['topic'],
    aliases: { topic: ['brief'] },
    inputExample: { topic: 'what to explain', goal: 'what the diagram should help with' },
    successSummary: 'Diagram created',
    failureSummary: 'Diagram failed',
    confirmation: 'none'
  },
  create_presentation: {
    risk: 'low',
    required: ['topic'],
    inputExample: { topic: 'subject', audience: 'who it is for', objective: 'what the deck should achieve', slide_count: 6 },
    successSummary: 'Presentation built',
    failureSummary: 'Presentation failed',
    confirmation: 'none'
  },
  // New agentic + general tools
  web_browse: {
    risk: 'low',
    required: ['url'],
    optional: ['query'],
    inputExample: { url: 'https://...', query: 'what you need from the page' },
    successSummary: 'Page browsed and relevant info extracted',
    failureSummary: 'Browse failed',
    confirmation: 'none'
  },
  web_search: {
    risk: 'low',
    required: ['query'],
    optional: ['num_results'],
    inputExample: { query: 'best pizza near me', num_results: 5 },
    successSummary: 'Search results',
    failureSummary: 'Search failed',
    confirmation: 'none'
  },
  calculate: {
    risk: 'low',
    required: ['expression'],
    inputExample: { expression: '2 + 2 * 3 or natural math question' },
    successSummary: 'Calculated',
    failureSummary: 'Calculation failed',
    confirmation: 'none'
  },
  // The agent's own scratch space. Without these the workspace is storage the user can
  // browse and the agent can never touch — notes, drafts and findings die with the turn
  // that produced them.
  workspace_write: {
    risk: 'low',
    required: ['path', 'content'],
    optional: ['kind'],
    inputExample: { path: 'notes/laptop-research.md', content: 'what I found so far', kind: 'file' },
    guidance: 'Save working notes, drafts, research or findings that should outlive this turn. Use a descriptive path with folders, e.g. research/laptops.md. Overwrites the file at that path.',
    successSummary: 'Saved to workspace',
    failureSummary: 'Workspace save failed',
    confirmation: 'none',
    executionMode: 'direct'
  },
  workspace_read: {
    risk: 'low',
    required: ['path'],
    inputExample: { path: 'notes/laptop-research.md' },
    guidance: 'Read back something previously saved to the workspace. Use workspace_list first if unsure of the exact path.',
    successSummary: 'Read from workspace',
    failureSummary: 'Workspace file not found',
    confirmation: 'none',
    executionMode: 'direct'
  },
  workspace_list: {
    risk: 'low',
    required: [],
    optional: ['prefix'],
    inputExample: { prefix: 'research/' },
    guidance: 'List what is already in the workspace. Cheap — prefer this over guessing a path.',
    successSummary: 'Listed workspace',
    failureSummary: 'Workspace list failed',
    confirmation: 'none',
    executionMode: 'direct'
  },
  project_status: {
    risk: 'low',
    required: ['project_ref'],
    inputExample: { project_ref: 'milgrain' },
    guidance: 'Inspect the configured isolated project for the current durable task. Use before editing or reporting project progress.',
    successSummary: 'Project status loaded',
    failureSummary: 'Project status unavailable',
    confirmation: 'none',
    executionMode: 'direct'
  },
  project_diff: {
    risk: 'low',
    required: ['project_ref'],
    inputExample: { project_ref: 'milgrain' },
    guidance: 'Inspect the current uncommitted diff in the isolated project. Never claim code changed without checking this.',
    successSummary: 'Project changes loaded',
    failureSummary: 'Project changes unavailable',
    confirmation: 'none',
    executionMode: 'direct'
  },
  project_write: {
    risk: 'low',
    required: ['project_ref', 'path', 'content'],
    inputExample: { project_ref: 'milgrain', path: 'src/feature.js', content: 'code' },
    guidance: 'Write text into the isolated task project only. The project reference must be configured by the user; never invent a project or use an absolute path.',
    successSummary: 'Project file saved',
    failureSummary: 'Project file save failed',
    confirmation: 'none',
    executionMode: 'direct'
  },
  project_check: {
    risk: 'low',
    required: ['project_ref'],
    optional: ['check'],
    inputExample: { project_ref: 'milgrain', check: 'test|release' },
    paramHints: { check: 'test|release' },
    guidance: 'Run only the configured project check in the isolated task project. Use check=test by default and report failures honestly.',
    successSummary: 'Project check finished',
    failureSummary: 'Project check failed',
    confirmation: 'none',
    executionMode: 'direct'
  },
  project_commit: {
    risk: 'low',
    required: ['project_ref', 'message'],
    inputExample: { project_ref: 'milgrain', message: 'Add referral credit flow' },
    guidance: 'Save the current isolated task changes as a local changeset after checking the diff. This does not publish or merge anything.',
    successSummary: 'Project changeset saved',
    failureSummary: 'Project changeset failed',
    confirmation: 'none',
    executionMode: 'direct'
  },
  project_rollback: {
    risk: 'medium',
    required: ['project_ref'],
    inputExample: { project_ref: 'milgrain' },
    guidance: 'Discard only uncommitted changes in the isolated task branch. This is destructive and requires explicit approval.',
    successSummary: 'Project changes rolled back',
    failureSummary: 'Project rollback failed',
    confirmation: 'review_required',
    executionMode: 'review'
  },
  project_sync: {
    risk: 'high',
    required: ['project_ref'],
    inputExample: { project_ref: 'milgrain' },
    guidance: 'Publish a clean, committed isolated task branch to its configured remote. Never merge or push the default branch; always show the branch and require approval.',
    successSummary: 'Project branch synchronized',
    failureSummary: 'Project synchronization failed',
    confirmation: 'review_required',
    executionMode: 'review'
  },
  create_agent_task: {
    risk: 'medium',
    required: ['goal'],
    optional: ['autonomy', 'plan'],
    inputExample: { goal: 'the long term goal', autonomy: 'Active|High', plan: 'optional initial plan json' },
    paramHints: { autonomy: 'Active|High' },
    guidance: 'This is the ownership mechanism: use it for a genuine outcome that will take more than this turn to reach — something to keep working on, checking on, or driving toward completion without the user re-prompting every step. Do not use it for a single tool call that already finishes the request, for ordinary conversation, or for musing/thinking-aloud — the same carve-out that keeps a tool call from firing on a half-formed thought applies here too.',
    successSummary: 'Task created for background execution',
    failureSummary: 'Task creation failed',
    confirmation: 'none'
  },
  create_scheduled_task: {
    risk: 'low',
    required: ['title', 'instruction'],
    optional: ['recurrence', 'time', 'day_of_week', 'date', 'due_date', 'condition', 'interval_minutes', 'expires_at', 'budget_cap'],
    inputExample: { title: 'Watch flight prices', instruction: 'Check every week and tell me if the price drops', recurrence: 'poll', interval_minutes: 10080 },
    guidance: 'Create durable background work only when the user explicitly asks to remind, schedule, watch, monitor, or check again. A condition such as "when the price drops" becomes a bounded poll with an expiry. Never invent a schedule or silently turn an ordinary task into recurring work. ' +
      'For a delivery/tracking watch ("tell me when this arrives", "keep an eye on this parcel"): resolve the tracking URL/number yourself first — from what the user gave you, or by searching recent order/shipping emails (search_emails) for an unambiguous match — before asking them to find something you can already access. Each check should use run_browser_task to read the REAL current page; never invent a status. Normalize whatever the carrier\'s own wording says to one of: label created, awaiting carrier, collected, in transit, at depot, customs, delayed, delivery attempted, out for delivery, delivered, returned to sender, exception. Before comparing, workspace_read the last state you saved for this shipment (workspace_write it after every check, keyed by tracking number/order); only [WATCH_TRIGGERED] when the CURRENT normalized state differs from that saved state in a way that matches what the user actually asked for — never on every poll just because a timestamp on the page moved. Match the condition to their actual phrasing: "tell me when it arrives" only triggers on delivered; "tell me if it\'s delayed" only triggers on a delay/exception; "tell me when it\'s out for delivery" only triggers at that stage; "keep me updated" triggers on any meaningful transition. For an ongoing "keep me updated" watch, when a non-terminal transition triggers, ALSO call create_scheduled_task again in the same run before finishing (same tracking info) so the next stage still gets checked — do not do this after a terminal state (delivered, returned to sender) ends the watch on its own; never keep checking a delivered parcel forever. If the carrier\'s page can\'t be read (login wall, CAPTCHA, blocked), say exactly that — never report an invented or stale status.',
    successSummary: 'Watch saved',
    failureSummary: 'Watch failed',
    confirmation: 'none',
    executionMode: 'direct'
  },
  list_scheduled_tasks: {
    risk: 'low',
    required: [],
    inputExample: {},
    successSummary: 'Watches loaded',
    failureSummary: 'Watches unavailable',
    confirmation: 'none',
    executionMode: 'direct'
  },
  cancel_scheduled_task: {
    risk: 'low',
    required: [],
    optional: ['id', 'title'],
    inputExample: { title: 'flight prices' },
    guidance: 'Cancel only the matching background watch. Ask for clarification if there is no id or title.',
    successSummary: 'Watch stopped',
    failureSummary: 'Watch could not be stopped',
    confirmation: 'none',
    executionMode: 'direct'
  },
  simulate_actions: {
    risk: 'low',
    required: ['goal'],
    optional: ['actions'],
    inputExample: { goal: 'what to simulate', actions: 'optional list of candidate actions' },
    successSummary: 'Simulation complete',
    failureSummary: 'Simulation failed',
    confirmation: 'none'
  },
  log_health: { risk: 'low', required: ['metric'], optional: ['value'], inputExample: { metric: 'steps|heart_rate', value: 'number or note' }, paramHints: { metric: 'steps|heart_rate' }, successSummary: 'Health logged', failureSummary: 'Log failed', confirmation: 'none' },
  control_smart_home: { risk: 'medium', required: ['device', 'command'], inputExample: { device: 'lights|thermostat', command: 'on|off|set 22' }, paramHints: { device: 'lights|thermostat', command: 'on|off|set 22' }, successSummary: 'Smart home updated', failureSummary: 'Control failed', confirmation: 'none' },
  save_to_notion: { risk: 'low', required: ['content'], inputExample: { content: 'note or task' }, successSummary: 'Saved to Notion', failureSummary: 'Save failed', confirmation: 'none' },
  // Google Docs — implemented in connectors/google.js but had no contract at all, so the
  // agent's tool-calling interface could never reach them. Same low-risk/no-confirmation
  // shape as save_to_notion: creating/appending a doc is non-destructive and easily undone.
  create_google_doc: { risk: 'low', required: ['title'], optional: ['content'], inputExample: { title: 'doc title', content: 'optional initial text' }, successSummary: 'Doc created', failureSummary: 'Create failed', confirmation: 'none' },
  search_google_docs: { risk: 'low', required: [], optional: ['query', 'max_results'], inputExample: { query: 'search term' }, successSummary: 'Docs found', failureSummary: 'Search failed', confirmation: 'none' },
  append_google_doc: { risk: 'low', required: ['content'], optional: ['document_id', 'title'], inputExample: { title: 'doc title', content: 'text to add' }, successSummary: 'Doc updated', failureSummary: 'Append failed', confirmation: 'none' },
  get_google_doc: { risk: 'low', required: [], optional: ['document_id', 'title'], inputExample: { title: 'doc title' }, successSummary: 'Doc fetched', failureSummary: 'Fetch failed', confirmation: 'none' },
  github_action: { risk: 'medium', required: ['repo', 'action'], inputExample: { repo: 'owner/repo', action: 'status|create_issue' }, paramHints: { action: 'status|create_issue' }, successSummary: 'GitHub action done', failureSummary: 'GitHub failed', confirmation: 'review_required', executionMode: 'review' },
  create_github_issue: { risk: 'medium', required: ['repo', 'title'], optional: ['body'], inputExample: { repo: 'owner/repo', title: 'Issue title', body: 'Details' }, successSummary: 'GitHub issue created', failureSummary: 'GitHub issue failed', confirmation: 'review_required', executionMode: 'review' },
  get_github_prs: { risk: 'low', required: ['repo'], inputExample: { repo: 'owner/repo' }, successSummary: 'GitHub pull requests loaded', failureSummary: 'GitHub pull requests failed', confirmation: 'none' },
  track_flight: { risk: 'low', required: ['flight'], inputExample: { flight: 'flight number or query' }, successSummary: 'Flight tracked', failureSummary: 'Track failed', confirmation: 'none' },
  edit_photo: { risk: 'low', required: ['brief'], inputExample: { brief: 'enhance|crop|filter' }, paramHints: { brief: 'enhance|crop|filter' }, successSummary: 'Photo edit ready', failureSummary: 'Edit failed', confirmation: 'none' },
  analyze_image: {
    risk: 'low',
    required: ['prompt'],
    optional: ['image_url'],
    inputExample: { prompt: 'describe this or extract text', image_url: 'optional' },
    successSummary: 'Image analyzed',
    failureSummary: 'Analysis failed',
    confirmation: 'none'
  },
  mcp_tool: {
    risk: 'medium',
    required: ['name'],
    optional: ['arguments'],
    inputExample: { name: 'home_assistant_action', arguments: { entity: 'light.living', action: 'turn_on' } },
    successSummary: 'MCP tool executed',
    failureSummary: 'MCP tool failed',
    confirmation: 'none'
  },
  // Concierge account / virtual card - like giving a real concierge a company card
  check_concierge_balance: {
    risk: 'low',
    required: [],
    inputExample: {},
    successSummary: 'Balance checked',
    failureSummary: 'Check failed',
    confirmation: 'none'
  },
  spend_from_concierge_account: {
    risk: 'high',
    required: ['amount', 'description'],
    optional: ['merchant'],
    inputExample: { amount: 25.5, description: 'book table at restaurant', merchant: 'OpenTable' },
    successSummary: 'Spent from account',
    failureSummary: 'Spend failed',
    confirmation: 'review'
  },
  top_up_concierge_account: {
    risk: 'medium',
    required: ['amount'],
    optional: ['source'],
    inputExample: { amount: 100, source: 'user bank' },
    successSummary: 'Account topped up',
    failureSummary: 'Top up failed',
    confirmation: 'review'
  },
  receive_to_concierge_account: {
    // Was 'none' — inconsistent with top_up_concierge_account (same effect: inflates the
    // spendable virtual balance with no real-money verification) which already required
    // review. An unreviewed action that credits spendable balance is exactly the shape of bug
    // this pass is fixing elsewhere (fabricated/ungated money entering the ledger).
    risk: 'medium',
    required: ['amount', 'description'],
    optional: ['source'],
    inputExample: { amount: 50, description: 'payment for freelance gig', source: 'client' },
    successSummary: 'Received to account',
    failureSummary: 'Receive failed',
    confirmation: 'review'
  },
  // For broad money-making: use account to fund opportunities
  fund_opportunity: {
    risk: 'high',
    required: ['amount', 'opportunity'],
    inputExample: { amount: 25, opportunity: 'boost gig listing on platform' },
    successSummary: 'Opportunity funded from concierge account',
    failureSummary: 'Funding failed',
    confirmation: 'review'
  },
  // New integrations
  stripe_charge: { risk: 'high', required: ['amount'], inputExample: { amount: 1000, description: 'payment' }, successSummary: 'Charged via Stripe', failureSummary: 'Failed', confirmation: 'review', executionMode: 'review' },
  // These move (or purport to move) real money and previously had NO contract at all, so the
  // runner treated them as direct-execute. Register them high-risk + review so they can't.
  stripe_payout_to_user: { risk: 'high', required: ['amount'], inputExample: { amount: 50, description: 'payout', destination: 'acct_...' }, successSummary: 'Payout initiated', failureSummary: 'Payout failed', confirmation: 'review', executionMode: 'review' },
  spend_from_concierge_via_stripe: { risk: 'high', required: ['amount'], inputExample: { amount: 25, description: 'concierge spend' }, successSummary: 'Spent via Stripe', failureSummary: 'Failed', confirmation: 'review', executionMode: 'review' },
  get_weather: { risk: 'low', required: ['city'], inputExample: { city: 'London' }, successSummary: 'Weather', failureSummary: 'Failed', confirmation: 'none' },
  search_amazon: { risk: 'low', required: ['query'], inputExample: { query: 'headphones' }, successSummary: 'Amazon search', failureSummary: 'Failed', confirmation: 'none' },
  send_slack_message: { risk: 'medium', required: ['channel', 'message'], inputExample: { channel: '#general', message: 'hi' }, successSummary: 'Slack sent', failureSummary: 'Failed', confirmation: 'none' },
  book_lyft: { risk: 'low', required: ['destination'], inputExample: { destination: 'airport' }, successSummary: 'Lyft opened', failureSummary: 'Failed', confirmation: 'none' },
  get_strava_activities: { risk: 'low', required: [], inputExample: {}, successSummary: 'Strava activities', failureSummary: 'Failed', confirmation: 'none' },
  search_flights: { risk: 'low', required: ['from', 'to'], inputExample: { from: 'LHR', to: 'JFK' }, successSummary: 'Flights found', failureSummary: 'Failed', confirmation: 'none', guidance: 'This only opens a flight-search page as a link — it does not return real prices, availability, or results. Never use it as a data source for plan_itinerary or to answer "how much would flights cost". Use web_search for a real current estimate, or run_browser_task if the user wants to actually look at and book real flights.' },
  search_hotels: { risk: 'low', required: ['location'], inputExample: { location: 'Paris' }, successSummary: 'Hotels found', failureSummary: 'Failed', confirmation: 'none', guidance: 'This only opens a hotel-search page as a link — it does not return real prices, availability, or results. Never use it as a data source for plan_itinerary or to answer "how much would a hotel cost". Use web_search for a real current estimate, or run_browser_task if the user wants to actually look at and book a real hotel.' },
  get_stock_price: { risk: 'low', required: ['symbol'], inputExample: { symbol: 'AAPL' }, successSummary: 'Stock price', failureSummary: 'Failed', confirmation: 'none' },
  // Real browser ordering (api/services/browser-task.js) — was built across many sessions
  // but never actually registered here, so it was unreachable from live chat. High risk
  // (it can reach a real checkout), but deliberately executionMode: 'direct' — it MUST
  // actually browse to find out what's being bought and for how much before a review makes
  // sense; gating the whole call behind upfront review (like stripe_charge) would mean
  // nothing ever runs. The review gate is applied inside executeAction's 'run_browser_task'
  // case instead, at the moment the loop reaches ready_for_payment, using the same
  // guardConciergeSpend cap check every other money action goes through. Never place an
  // order without this making it to a `confirmation: 'review_required'` result first.
  run_browser_task: {
    risk: 'high',
    // goal is OPTIONAL, not required: a continuation call for an already-open order
    // legitimately passes an empty goal, and runOrderingTurn itself resolves that from
    // the live session (or persisted resume context) — see the case handler in
    // api/index.js. Putting 'goal' in `required` here would make the generic contract
    // validator reject that empty-goal continuation before the handler ever runs,
    // breaking auto-continue (regression test: browser-ordering-loop.test.js).
    required: [],
    optional: ['goal', 'url', 'credentialSites'],
    inputExample: { goal: 'order a medium black t-shirt from Rothys', url: 'https://www.rothys.com' },
    // credentialSites has no entry in inputExample above (it's a rare param), so without this
    // the native schema would only say "credentialSites (optional)" — giving no hint that it
    // must be an ARRAY of domains. The guidance below states the same rule in prose, but a
    // wrongly-shaped argument (a bare string instead of an array) is exactly the kind of
    // mistake a per-parameter format hint prevents that prose elsewhere does not.
    paramHints: { credentialSites: 'array of site domains to offer a saved credential for, e.g. ["delta.com"]' },
    successSummary: 'Order progressed',
    failureSummary: 'Order task failed',
    confirmation: 'none',
    executionMode: 'direct',
    guidance: 'Call again with the same goal (or no goal, to continue an in-progress order) for a multi-step order. NEVER call confirm_browser_payment yourself — only after the user explicitly agrees to the price shown in a review_required result. If the user asks you to sign in to a specific site using a saved credential, pass credentialSites as an array of that site\'s domain (e.g. ["delta.com"]) — without it, no stored credential will ever be offered, even if one exists. If the user says "wrong price", "that\'s wrong", or gives any price correction, always re-check the exact same retailer/site that produced the previous price — never drift to the brand\'s own website or a different retailer. Also use this for booking a real appointment through a business\'s own website (a dentist, salon, restaurant, or anywhere with an online booking page) — treat finding and confirming a slot the same way as finding and confirming an order, including the same review-before-payment step. find_appointment_options is not a working alternative for this today. Also use this to read a REAL courier tracking page for a delivery watch (see create_scheduled_task\'s guidance for the full pattern) — read what the page actually says, never invent a shipment status.'
  },
  // The second half of the two-phase flow above — only ever called on a turn AFTER the user
  // has explicitly approved a review_required result from run_browser_task. executionMode:
  // 'direct' is correct here too: the human review already happened, this is the user's own
  // "yes" being carried out, not a fresh unreviewed spend.
  confirm_browser_payment: {
    risk: 'high',
    required: [],
    inputExample: {},
    successSummary: 'Order placed',
    failureSummary: 'Payment confirmation failed',
    confirmation: 'none',
    executionMode: 'direct',
    guidance: 'Only call this after the user has explicitly said yes to the price shown by run_browser_task on a prior turn.'
  },
  cancel_browser_payment: {
    risk: 'low',
    required: [],
    inputExample: {},
    successSummary: 'Order cancelled',
    failureSummary: 'Cancel failed',
    confirmation: 'none',
    executionMode: 'direct'
  },
  // The second half of the credential-use two-phase flow (Phase 2 of the aside-parity
  // roadmap) — only ever called on a turn AFTER the user has explicitly approved a
  // review_required result from run_browser_task's ready_for_credential_use branch.
  // executionMode: 'direct' is correct here for the same reason it is on
  // confirm_browser_payment: the human review already happened on the prior turn.
  confirm_credential_use: {
    risk: 'high',
    required: [],
    inputExample: {},
    successSummary: 'Signed in',
    failureSummary: 'Sign-in failed',
    confirmation: 'none',
    executionMode: 'direct',
    guidance: 'Only call this after the user has explicitly said yes to using their saved credential, offered by run_browser_task on a prior turn.'
  },
  cancel_credential_use: {
    risk: 'low',
    required: [],
    inputExample: {},
    successSummary: 'Sign-in cancelled',
    failureSummary: 'Cancel failed',
    confirmation: 'none',
    executionMode: 'direct'
  }
};

function getActionContract(type) {
  const contract = ACTION_CONTRACTS[type];
  if (!contract) return null;
  // Fail-safe review routing. The action-runner gates human review on `executionMode === 'review'`,
  // but the `confirmation`/`risk` fields are what authors actually set — and it's easy to add a new
  // spend action with `confirmation: 'review'` while forgetting `executionMode`, which silently ships
  // it as direct-execute (the concierge/Stripe money actions did exactly this). Derive the gate here
  // so anything marked for confirmation, or flagged high-risk, can never execute without review.
  if (!contract.executionMode) {
    const needsReview = contract.confirmation === 'review'
      || contract.confirmation === 'review_required'
      || contract.risk === 'high';
    if (needsReview) return { ...contract, executionMode: 'review' };
  }
  return contract;
}

function normalizeActionInput(type, input = {}) {
  const contract = getActionContract(type);
  const normalized = { ...(input || {}) };
  if (!contract?.aliases) return normalized;
  for (const [canonical, aliases] of Object.entries(contract.aliases)) {
    if (normalized[canonical]) continue;
    const alias = aliases.find(key => normalized[key]);
    if (alias) normalized[canonical] = normalized[alias];
  }
  return normalized;
}

function missingRequiredFields(type, input = {}) {
  const contract = getActionContract(type);
  if (!contract) return [];
  const normalized = normalizeActionInput(type, input);
  return (contract.required || []).filter(field => {
    const value = normalized[field];
    return value == null || String(value).trim() === '';
  });
}

function validateActionWithContract(action, originalMessage = '') {
  const type = action?.type || '';
  const contract = getActionContract(type);
  if (!contract) return null;

  action.input = normalizeActionInput(type, action.input || {});
  const missing = missingRequiredFields(type, action.input);
  if (missing.length) {
    return {
      success: false,
      error: `${type} needs ${missing.join(', ')}.`,
      cardText: `Missing ${missing.join(', ')}.`,
      retryable: true,
      risk: contract.risk,
      confirmation: contract.confirmation
    };
  }

  if (['send_message', 'send_telegram'].includes(type) && isLinkSendRequest(originalMessage) && !containsUrl(action.input.message)) {
    return {
      success: false,
      error: 'The user asked to send a link, but no actual URL was provided or found.',
      cardText: 'Needs the exact link.',
      retryable: true,
      risk: contract.risk,
      confirmation: contract.confirmation
    };
  }

  if (type === 'send_email' && isLinkSendRequest(originalMessage) && !containsUrl(`${action.input.subject || ''} ${action.input.body || ''}`)) {
    return {
      success: false,
      error: 'The user asked to send a link, but the email does not contain an actual URL.',
      cardText: 'Needs the exact link.',
      retryable: true,
      risk: contract.risk,
      confirmation: contract.confirmation
    };
  }

  return null;
}

function buildActionRecovery(action, result) {
  const type = action?.type || action?.action || '';
  const contract = getActionContract(type);
  const error = String(result?.error || '').trim();
  if (result?.success !== false) return {};

  if ((type === 'find_place' || type === 'book_uber') && /need your current location|enable location/i.test(error)) {
    return {
      cardText: "Turn location on and I'll try again.",
      retryable: true,
      retryAction: { type, input: action?.input || {} }
    };
  }

  if ((type === 'find_place' || type === 'book_uber') && /Places API|Google Places|PERMISSION_DENIED|REQUEST_DENIED/i.test(error)) {
    return {
      cardText: 'Nearby ranking needs Places setup.',
      retryable: false
    };
  }

  if (/No results found|couldn't find a nearby|Geocoding error/i.test(error)) {
    return {
      cardText: 'Try a different place name.',
      retryable: true,
      retryAction: { type, input: action?.input || {} }
    };
  }

  if (/not connected|not authorized|reconnect/i.test(error)) {
    return {
      cardText: 'Reconnect the connector in Settings.',
      retryable: true
    };
  }

  return contract?.failureSummary ? { cardText: contract.failureSummary } : {};
}

function applyActionContractResultMetadata(action, result = {}) {
  const contract = getActionContract(action?.type || action?.action);
  if (!contract) return result;
  return {
    ...result,
    risk: result.risk || contract.risk,
    confirmation: result.confirmation || contract.confirmation,
    executionMode: result.executionMode || contract.executionMode || 'direct',
    actionSummary: result.actionSummary || (result.success === false ? contract.failureSummary : contract.successSummary)
  };
}

function actionPromptList() {
  return Object.entries(ACTION_CONTRACTS).map(([type, contract]) => ({
    type,
    input: contract.inputExample,
    required: contract.required || [],
    optional: contract.optional || [],
    risk: contract.risk,
    confirmation: contract.confirmation,
    executionMode: contract.executionMode || 'direct',
    guidance: contract.guidance
  }));
}

function actionPromptBlock() {
  return `<action>\n${JSON.stringify({ actions: actionPromptList() }, null, 2)}\n</action>`;
}

function actionToFunctionDeclaration(type, contract) {
  const properties = {};
  const inputEx = contract.inputExample || {};
  const required = new Set(contract.required || []);
  const optional = new Set(contract.optional || []);
  const allParams = new Set([...Object.keys(inputEx), ...required, ...(contract.paramHints ? Object.keys(contract.paramHints) : []), ...optional]);
  const hints = contract.paramHints || {};

  for (const key of allParams) {
    const isRequired = required.has(key);
    const hint = hints[key];
    properties[key] = {
      type: 'string',
      description: `${key}${isRequired ? ' (required)' : ' (optional)'}${hint ? ` — ${hint}` : ''}`
    };
  }

  // Add common freeform for complex ones
  if (['send_email', 'send_message', 'send_telegram'].includes(type)) {
    properties.body = properties.body || { type: 'string', description: 'The full message or email body content' };
  }

  return {
    name: type,
    description: `${type} — ${contract.successSummary || type}. Risk level: ${contract.risk || 'medium'}. ${contract.guidance || 'Execute only when details are clear.'}`.trim(),
    parameters: {
      type: 'OBJECT',
      properties,
      required: Array.from(required)
    }
  };
}

function buildFunctionDeclarations() {
  return Object.entries(ACTION_CONTRACTS).map(([type, contract]) =>
    actionToFunctionDeclaration(type, contract)
  );
}

function buildToolsForGemini(includeSearch = false) {
  const decls = buildFunctionDeclarations();
  const tools = [{ functionDeclarations: decls }];
  if (includeSearch) {
    tools.push({ googleSearch: {} });
  }
  return tools;
}

function containsUrl(text) {
  return /\bhttps?:\/\/\S+/i.test(String(text || ''));
}

function isLinkSendRequest(message) {
  return /\b(send|text|message|telegram|whatsapp|imessage|email)\b/i.test(String(message || '')) &&
    /\blink\b/i.test(String(message || ''));
}

module.exports = {
  ACTION_CONTRACTS,
  getActionContract,
  validateActionWithContract,
  buildActionRecovery,
  applyActionContractResultMetadata,
  actionPromptBlock,
  buildFunctionDeclarations,
  buildToolsForGemini
};

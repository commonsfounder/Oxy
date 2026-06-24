const ACTION_CONTRACTS = {
  send_message: {
    risk: 'medium',
    required: ['contact', 'message'],
    aliases: { message: ['body', 'text', 'content'] },
    inputExample: { contact: 'name', message: 'text' },
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
    risk: 'low',
    required: ['title', 'due_date'],
    inputExample: { title: 'Call the dentist', due_date: 'ISO datetime' },
    guidance: 'One-off reminder delivered as a notification at due_date. due_date must be an ISO datetime worked out from the user\'s request and the current time (Europe/London) — never invent a date. For recurring requests ("every morning...", "every Monday...") use create_scheduled_task instead.',
    successSummary: 'Reminder created',
    failureSummary: 'Reminder failed',
    confirmation: 'none'
  },
  create_scheduled_task: {
    risk: 'low',
    required: ['title', 'instruction'],
    optional: ['recurrence', 'time', 'day_of_week', 'date'],
    inputExample: { title: 'Morning traffic check', instruction: "Check traffic for the user's commute and report it.", recurrence: 'daily', time: '07:30' },
    guidance: 'Use for recurring or scheduled future requests like "every morning at 7:30 check traffic", "every Monday tell me what\'s on my calendar", or "in two hours remind me to call back". recurrence is "daily", "weekly", or "once" — pick "once" only for a single future occurrence, otherwise infer "daily"/"weekly" from the phrasing. time is 24h HH:MM in Europe/London (default 09:00 if unspecified). For weekly, set day_of_week to the day name (e.g. "Monday"). For "once" tasks not due today, set date to an ISO date. instruction is a self-directed note describing what Oxy should do or say when this fires, e.g. "Check the weather and tell the user if they need an umbrella."',
    successSummary: 'Scheduled task created',
    failureSummary: 'Scheduling failed',
    confirmation: 'none'
  },
  list_scheduled_tasks: {
    risk: 'low',
    required: [],
    inputExample: {},
    guidance: 'Use when the user asks what reminders or scheduled tasks they have set up.',
    successSummary: 'Scheduled tasks checked',
    failureSummary: 'Could not check scheduled tasks',
    confirmation: 'none'
  },
  cancel_scheduled_task: {
    risk: 'low',
    required: ['title'],
    inputExample: { title: 'Morning traffic check' },
    guidance: 'Use to cancel or delete a previously created reminder or scheduled task. Match it by the title or description the user gives.',
    successSummary: 'Scheduled task cancelled',
    failureSummary: 'Could not cancel scheduled task',
    confirmation: 'none'
  },
  run_browser_task: {
    risk: 'low',
    // goal is required to START a task but optional to CONTINUE a live one (the
    // server's auto-continue sentinel deliberately omits it) — that's conditional on
    // session state, which this static list can't express. The real check lives in
    // the run_browser_task handler (api/index.js), which knows about live sessions.
    required: [],
    optional: ['goal', 'url', 'title'],
    inputExample: { url: 'https://deliveroo.co.uk (a delivery platform you can act on; only needed to start a new task)', goal: 'Order jerk chicken for delivery to B18 4HE, or find Marketplace listings under $1000, or the user\'s reply to a question you previously asked', title: 'short label for the briefing' },
    guidance: 'Use when the user wants you to browse a real website and DO something for them — including placing a food/grocery/shopping order ("order me a pizza", "get me some jerk chicken"), checking a marketplace, or logging into a site to check something. This is how you ORDER things; do not fall back to find_place or an Uber when the user says "order it". To START a delivery order, set url to a platform you can drive — https://www.ubereats.com, https://deliveroo.co.uk, or https://www.just-eat.co.uk — and put BOTH the items AND the user\'s delivery address/postcode in the goal (e.g. "Order jerk chicken for delivery to B18 4HE"). You do not need a perfect deep link: the loop reads each page and will enter the address, search, and build the cart itself. Delivery sites show nothing until a delivery address is entered, so the goal MUST carry one — but DEFAULT to the user\'s home/delivery address from memory or one they\'ve given before; do not make them retype it. Only ask for an address if you genuinely have none on record, or if they say to deliver somewhere specific ("send it to the office"). When they do give a new address, remember it so future orders don\'t ask again. Never type GPS coordinates or use a site\'s "current location" button — this runs on a server, so that resolves to the wrong place; always use a real postal address/postcode. For vague requests ("order me something") have a normal conversation first — ask what they\'re craving — before calling this. This runs across several turns: if you previously asked the user a question via this action, or it said it was still working, call it again with their reply as the goal and OMIT url — it resumes the same in-progress session. It pauses to ask you to confirm before any payment is finalized; never imply an order is placed until that confirmation completes. Do not use for anything a connector already covers (email, calendar, music, maps).',
    successSummary: 'Browser task ran',
    failureSummary: 'Browser task failed',
    confirmation: 'none'
  },
  play_music: {
    risk: 'low',
    required: ['query'],
    inputExample: { query: 'search term' },
    guidance: 'Use for "play X" / "listen to X" via the device\'s native music app. Pass the resolved exact song title and artist as query. If the request depends on current facts, charts, rankings, popularity, or "right now", resolve the exact track via search FIRST — never pass vague queries like "most popular song" or "top song". If there is no specific song and no safe way to ground one, ask what they want to hear instead of inventing a track (e.g. "play some music" is not a request to play a song called "Some"). If the user explicitly says "on Spotify" (or Spotify is their connected player), use play_spotify instead.',
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
    guidance: 'Use when the user asks to ADD a song or album to their library or a playlist — not to start playback. "Play X" is play_music, not this.',
    successSummary: 'Music added',
    failureSummary: 'Music add failed',
    confirmation: 'none'
  },
  create_calendar_event: {
    risk: 'medium',
    required: ['title', 'start_date', 'end_date'],
    inputExample: { title: 'event', start_date: 'ISO date', end_date: 'ISO date' },
    guidance: 'Use for "calendar", "schedule", "event", or "add to my calendar". Do not route to Apple Music just because the phrase contains the word "add". If the date or time is missing, ask for it instead of guessing. title is a short label (2-5 words: activity + key entity) — NEVER the user\'s full instruction. "im going to see my gf in apsley, add it to my calendar and find me the train" -> title "See gf in Apsley". Strip meta-instructions ("add it to my calendar", "and find me the train", "tell it to...") entirely — those are separate intents handled by other actions, not part of the event name.',
    successSummary: 'Calendar updated',
    failureSummary: 'Calendar failed',
    confirmation: 'none'
  },
  get_calendar_events: {
    risk: 'low',
    required: [],
    inputExample: { max_results: 5 },
    successSummary: 'Calendar checked',
    failureSummary: 'Calendar failed',
    confirmation: 'none'
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
    guidance: 'If the user gives enough substance, draft the full email body with an appropriate greeting, natural structure, and sign-off. Match any requested tone. Do not ask for a subject. Do not use stiff cliches. For Gmail replies, use the provided full thread context, sender details, memory about the sender, and user communication preferences; include thread_id/in_reply_to/references when available. Match both the user tone and the thread formality: professional for business threads, casual for casual threads. Do not add fake warmth or unnecessary pleasantries, and stop when the point is made.',
    successSummary: 'Email sent',
    failureSummary: 'Email failed',
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
    guidance: 'Search the user\'s own inbox for a specific email only. Never use to look up news or public information — that is a web search.',
    confirmation: 'none'
  },
  book_uber: {
    risk: 'low',
    required: ['destination'],
    aliases: { destination: ['query', 'place', 'address'] },
    inputExample: { destination: 'natural place or address phrase' },
    guidance: 'Pass the user\'s natural destination phrase as destination ("the nearest gym", "Kings Cross", "home"). Do not invent a branch name or full street address — resolution handles it from the phrase and device location.',
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
    guidance: 'Pass the user\'s natural phrase as query ("nearest gym", "coffee near me", "closest McDonald\'s"). Do not ask for a full address or a specific branch — device location resolves it. Use this ONLY to LOCATE a venue ("where is / find me / nearest X"). If the user wants to ORDER food or items for delivery ("order me jerk chicken", "get me some food"), use run_browser_task instead — find_place cannot place an order.',
    successSummary: 'Place found',
    failureSummary: 'Place search failed',
    confirmation: 'none'
  },
  get_directions: {
    risk: 'low',
    required: ['destination'],
    optional: ['origin', 'mode', 'arrival_time', 'departure_time'],
    aliases: { destination: ['query', 'place', 'address'], origin: ['from'] },
    inputExample: { origin: 'optional start place or station', destination: 'natural place or address phrase', mode: 'driving|walking|transit', arrival_time: 'optional arrive-by time e.g. "8am"', departure_time: 'optional leave-at time e.g. "9:30am"' },
    guidance: 'CRITICAL: Use arrival_time when the user needs to ARRIVE by a certain time ("I need to be there at 8am", "meeting at 9", "when should I leave for X at Y"). Maps uses arrival_time to calculate when to depart — this directly answers "when should I leave". Use departure_time only when the user says when they are LEAVING. Never use departure_time when the user specifies an arrival deadline.',
    successSummary: 'Directions ready',
    failureSummary: 'Directions failed',
    confirmation: 'none'
  },
  plan_trip: {
    risk: 'low',
    required: ['destination'],
    optional: ['origin', 'departure_time', 'arrival_time', 'preference'],
    aliases: { destination: ['query', 'place', 'address', 'to'], origin: ['from'] },
    inputExample: { destination: 'London Euston', origin: 'optional start place or station', departure_time: 'optional leave-at time e.g. "9:30am"', arrival_time: 'optional arrive-by time e.g. "8am"', preference: 'balanced|fastest|fewest_changes' },
    guidance: 'CRITICAL: Use arrival_time when the user needs to ARRIVE by a certain time ("I need to be there at 8am", "meeting at 9", "when should I leave for X at Y"). Maps uses arrival_time to calculate when to depart. Use departure_time only when the user says when they are LEAVING.',
    successSummary: 'Trip planned',
    failureSummary: 'Trip failed',
    confirmation: 'none'
  },
  send_telegram: {
    risk: 'high',
    required: ['contact', 'message'],
    aliases: { message: ['body', 'text', 'content'] },
    inputExample: { contact: 'contact name', message: 'message text' },
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
    successSummary: 'Train route checked',
    failureSummary: 'Train search failed',
    confirmation: 'none'
  },
  station_board: {
    risk: 'low',
    required: ['station'],
    aliases: { station: ['origin', 'from'] },
    inputExample: { station: 'station name or CRS code' },
    successSummary: 'Station board ready',
    failureSummary: 'Station board failed',
    confirmation: 'none'
  },
  forget_memory: {
    risk: 'medium',
    required: ['scope'],
    inputExample: { scope: 'recent|all', query: 'optional memory topic to forget' },
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
  search_github: {
    risk: 'low',
    required: ['query'],
    aliases: { query: ['q', 'search'] },
    inputExample: { query: 'GitHub search syntax, e.g. is:pr is:open author:@me' },
    guidance: 'Use for finding GitHub issues and pull requests. Build a GitHub search query — e.g. "is:open is:issue assignee:@me", "repo:owner/name is:pr review-requested:@me". "@me" resolves to the connected user.',
    successSummary: 'GitHub searched',
    failureSummary: 'GitHub search failed',
    confirmation: 'none'
  },
  get_github_notifications: {
    risk: 'low',
    required: [],
    inputExample: {},
    guidance: 'Use for "my GitHub notifications", "what needs my attention on GitHub". Returns unread notifications only.',
    successSummary: 'GitHub notifications checked',
    failureSummary: 'GitHub notifications failed',
    confirmation: 'none'
  },
  create_github_issue: {
    risk: 'high',
    required: ['repo', 'title'],
    optional: ['body'],
    aliases: { repo: ['repository'], title: ['name', 'subject'], body: ['description', 'content'] },
    inputExample: { repo: 'owner/name', title: 'issue title', body: 'optional issue body in markdown' },
    guidance: 'repo must be "owner/name". Write a clear title and, when the user gave substance, a complete markdown body. Confirm the repo if ambiguous.',
    successSummary: 'Issue created',
    failureSummary: 'Issue failed',
    confirmation: 'review_required',
    executionMode: 'review'
  },
  comment_github_issue: {
    risk: 'high',
    required: ['repo', 'issue_number', 'body'],
    aliases: { repo: ['repository'], issue_number: ['number', 'issue'], body: ['comment', 'message', 'content'] },
    inputExample: { repo: 'owner/name', issue_number: 123, body: 'comment text in markdown' },
    guidance: 'repo must be "owner/name". issue_number is the issue or PR number. Draft a complete, well-formed comment.',
    successSummary: 'Comment posted',
    failureSummary: 'Comment failed',
    confirmation: 'review_required',
    executionMode: 'review'
  },
  send_outlook_email: {
    risk: 'high',
    required: ['to', 'body'],
    optional: ['subject', 'tone'],
    aliases: { to: ['email', 'recipient'], body: ['message', 'content', 'text'] },
    inputExample: { to: 'email', subject: 'optional subject inferred from the body if omitted', body: 'polished complete email draft based on the user intent, not a terse literal fragment', tone: 'optional requested tone such as casual, warm, professional' },
    guidance: 'Outlook/Microsoft 365 email. If the user gives enough substance, draft the full email body with an appropriate greeting, natural structure, and sign-off. Match any requested tone. Do not ask for a subject. Use this only when the user is connected to Microsoft/Outlook rather than Google.',
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
    guidance: 'Outlook/Microsoft 365 calendar. Use for "add to my Outlook calendar" / "schedule" when the user is connected to Microsoft. If the date or time is missing, ask for it instead of guessing.',
    successSummary: 'Calendar updated',
    failureSummary: 'Calendar failed',
    confirmation: 'none'
  },
  get_outlook_events: {
    risk: 'low',
    required: [],
    inputExample: {},
    successSummary: 'Calendar checked',
    failureSummary: 'Calendar failed',
    confirmation: 'none'
  },
  search_youtube: {
    risk: 'low',
    required: ['query'],
    aliases: { query: ['q', 'search'] },
    inputExample: { query: 'search term' },
    guidance: 'Use for "find a video about X" / "play me a video on Y" on YouTube. Returns matching videos when YouTube search is configured, otherwise a search link. Never use to look up news, current events, or facts — that is a web search, not a video search.',
    successSummary: 'YouTube searched',
    failureSummary: 'YouTube search failed',
    confirmation: 'none'
  },
  search_indeed_jobs: {
    risk: 'low',
    required: ['query'],
    optional: ['location'],
    aliases: { query: ['role', 'title'], location: ['where'] },
    inputExample: { query: 'job title or keywords', location: 'optional city or area' },
    guidance: 'Use for "find me a job as X" / "search Indeed for Y". Opens an Indeed search — Indeed has no public results API.',
    successSummary: 'Indeed searched',
    failureSummary: 'Indeed search failed',
    confirmation: 'none'
  },
  search_linkedin_jobs: {
    risk: 'low',
    required: ['query'],
    optional: ['location'],
    aliases: { query: ['role', 'title'], location: ['where'] },
    inputExample: { query: 'job title or keywords', location: 'optional city or area' },
    guidance: 'Use for "find me a job on LinkedIn" type requests. Opens a LinkedIn jobs search.',
    successSummary: 'LinkedIn jobs searched',
    failureSummary: 'LinkedIn search failed',
    confirmation: 'none'
  },
  share_linkedin_post: {
    risk: 'low',
    required: ['url'],
    aliases: { url: ['link'] },
    inputExample: { url: 'https://...' },
    guidance: "Use for \"share this on LinkedIn\". Opens LinkedIn's share dialog with the link prefilled — the user still chooses to post.",
    successSummary: 'LinkedIn share opened',
    failureSummary: 'LinkedIn share failed',
    confirmation: 'none'
  },
  search_notion: {
    risk: 'low',
    required: ['query'],
    inputExample: { query: 'search term' },
    guidance: 'Use for "find my Notion page about X" / "search Notion for Y".',
    successSummary: 'Notion searched',
    failureSummary: 'Notion search failed',
    confirmation: 'none'
  },
  create_notion_page: {
    risk: 'medium',
    required: ['title'],
    optional: ['content', 'parent_title'],
    aliases: { content: ['body', 'text'], parent_title: ['parent'] },
    inputExample: { title: 'page title', content: 'optional body text', parent_title: 'optional name of the page or database to create it under' },
    guidance: 'Use for "create a Notion page/note about X". If parent_title is omitted, the most recently edited accessible page is used as the parent.',
    successSummary: 'Notion page created',
    failureSummary: 'Notion page failed',
    confirmation: 'none'
  },
  append_notion_page: {
    risk: 'medium',
    required: ['page_title', 'content'],
    aliases: { page_title: ['page', 'title'], content: ['body', 'text'] },
    inputExample: { page_title: 'name of an existing Notion page', content: 'text to add' },
    guidance: 'Use for "add this to my X note in Notion".',
    successSummary: 'Notion page updated',
    failureSummary: 'Notion update failed',
    confirmation: 'none'
  },
  create_google_doc: {
    risk: 'medium',
    required: ['title'],
    optional: ['content'],
    aliases: { content: ['body', 'text'] },
    inputExample: { title: 'document title', content: 'optional starting text' },
    guidance: 'Use for "create a Google Doc about X". Requires the user to be connected to Google with Docs access.',
    successSummary: 'Google Doc created',
    failureSummary: 'Google Doc failed',
    confirmation: 'none'
  },
  search_google_docs: {
    risk: 'low',
    required: [],
    optional: ['query'],
    inputExample: { query: 'optional search term' },
    guidance: 'Use for "find my Google Doc about X" / "what docs do I have".',
    successSummary: 'Google Docs searched',
    failureSummary: 'Google Docs search failed',
    confirmation: 'none'
  },
  append_google_doc: {
    risk: 'medium',
    required: ['title', 'content'],
    aliases: { title: ['document_title'], content: ['body', 'text'] },
    inputExample: { title: 'name of an existing Google Doc', content: 'text to add' },
    guidance: 'Use for "add this to my X doc".',
    successSummary: 'Google Doc updated',
    failureSummary: 'Google Doc update failed',
    confirmation: 'none'
  },
  get_google_doc: {
    risk: 'low',
    required: ['title'],
    inputExample: { title: 'name of an existing Google Doc' },
    guidance: 'Use for "read me my X doc" / "what does my X doc say".',
    successSummary: 'Google Doc read',
    failureSummary: 'Google Doc read failed',
    confirmation: 'none'
  },
  search_spotify: {
    risk: 'low',
    required: ['query'],
    optional: ['type'],
    inputExample: { query: 'song, artist, album, or playlist name', type: 'track' },
    guidance: 'Use for "search Spotify for X". type is one of track/album/artist/playlist (default track).',
    successSummary: 'Spotify searched',
    failureSummary: 'Spotify search failed',
    confirmation: 'none'
  },
  play_spotify: {
    risk: 'low',
    required: ['query'],
    optional: ['type'],
    inputExample: { query: 'song title and artist', type: 'track' },
    guidance: 'Use for "play X on Spotify" — only when the user explicitly says Spotify or Spotify is their connected player. Otherwise use play_music. type is one of track/album/artist/playlist (default track); resolve a specific item, never a vague query.',
    successSummary: 'Spotify playing',
    failureSummary: 'Spotify play failed',
    confirmation: 'none'
  },
  control_spotify_playback: {
    risk: 'low',
    required: ['command'],
    inputExample: { command: 'pause' },
    guidance: 'command is one of pause, resume, next, previous. Use for "pause/skip/resume Spotify" requests.',
    successSummary: 'Spotify playback updated',
    failureSummary: 'Spotify control failed',
    confirmation: 'none'
  },
  add_to_spotify_queue: {
    risk: 'low',
    required: ['query'],
    inputExample: { query: 'song title and artist' },
    guidance: 'Use for "queue X on Spotify" / "play X next on Spotify".',
    successSummary: 'Added to Spotify queue',
    failureSummary: 'Spotify queue failed',
    confirmation: 'none'
  },
  add_to_spotify_playlist: {
    risk: 'low',
    required: ['query', 'playlist'],
    inputExample: { query: 'song title and artist', playlist: 'playlist name' },
    guidance: 'Use for "add X to my Y playlist on Spotify".',
    successSummary: 'Added to Spotify playlist',
    failureSummary: 'Spotify playlist update failed',
    confirmation: 'none'
  },
  get_now_playing_spotify: {
    risk: 'low',
    required: [],
    inputExample: {},
    guidance: 'Use for "what\'s playing on Spotify" / "what song is this".',
    successSummary: 'Now playing checked',
    failureSummary: 'Now playing check failed',
    confirmation: 'none'
  },
  search_linear_issues: {
    risk: 'low',
    required: ['query'],
    inputExample: { query: 'search term' },
    guidance: 'Use for "find my Linear issue about X" / "search Linear for Y".',
    successSummary: 'Linear searched',
    failureSummary: 'Linear search failed',
    confirmation: 'none'
  },
  get_linear_issues: {
    risk: 'low',
    required: [],
    inputExample: {},
    guidance: 'Use for "what are my Linear issues" / "what\'s assigned to me on Linear".',
    successSummary: 'Linear issues checked',
    failureSummary: 'Linear check failed',
    confirmation: 'none'
  },
  create_linear_issue: {
    risk: 'high',
    required: ['title'],
    optional: ['team', 'description'],
    aliases: { title: ['name', 'subject'], description: ['body', 'content'] },
    inputExample: { title: 'issue title', team: 'optional team name', description: 'optional issue description in markdown' },
    guidance: "Use for \"create a Linear issue/ticket for X\". If team is omitted, the user's default team is used. Write a clear title and, when the user gave substance, a complete description.",
    successSummary: 'Linear issue created',
    failureSummary: 'Linear issue failed',
    confirmation: 'review_required',
    executionMode: 'review'
  },
  comment_linear_issue: {
    risk: 'high',
    required: ['issue', 'body'],
    aliases: { issue: ['issue_id', 'identifier'], body: ['comment', 'message', 'content'] },
    inputExample: { issue: 'ENG-123', body: 'comment text in markdown' },
    guidance: 'issue is the Linear issue identifier (e.g. ENG-123). Draft a complete, well-formed comment.',
    successSummary: 'Comment posted',
    failureSummary: 'Comment failed',
    confirmation: 'review_required',
    executionMode: 'review'
  },

  // --- Travel actions ---

  search_flights: {
    risk: 'low',
    required: ['origin', 'destination', 'date'],
    optional: ['returnDate', 'partySize', 'cabinClass', 'maxPrice'],
    aliases: { origin: ['from', 'departure'], destination: ['to', 'arrival'], date: ['departureDate'] },
    inputExample: { origin: 'London Heathrow', destination: 'Tokyo', date: '2027-04-10', returnDate: '2027-04-20', partySize: 2, cabinClass: 'economy', maxPrice: 800 },
    guidance: 'Use when the user wants to find or compare flights. origin and destination should be city names or IATA airport codes. date is the outbound departure date (ISO format preferred). Include returnDate for round trips. Do not invent prices or availability — results come from the flights connector.',
    successSummary: 'Flights found',
    failureSummary: 'Flight search failed',
    confirmation: 'none'
  },

  search_hotels: {
    risk: 'low',
    required: ['destination', 'checkIn', 'checkOut'],
    optional: ['guests', 'maxPrice', 'style', 'amenities'],
    aliases: { destination: ['city', 'location'], guests: ['partySize', 'people'] },
    inputExample: { destination: 'Tokyo', checkIn: '2027-04-10', checkOut: '2027-04-20', guests: 2, maxPrice: 200, style: 'boutique' },
    guidance: 'Use when the user wants to find accommodation. style is one of: budget | mid | luxury | boutique | apartment. maxPrice is per night. checkIn/checkOut should be ISO dates. Do not invent availability or prices — results come from the hotels connector.',
    successSummary: 'Hotels found',
    failureSummary: 'Hotel search failed',
    confirmation: 'none'
  },

  search_activities: {
    risk: 'low',
    required: ['destination'],
    optional: ['date', 'interests', 'budget', 'partySize', 'duration'],
    aliases: { destination: ['city', 'location'] },
    inputExample: { destination: 'Tokyo', date: '2027-04-12', interests: ['culture', 'food'], budget: 100, partySize: 2 },
    guidance: 'Use when the user wants to find things to do, tours, or experiences. interests maps to activity types: culture | adventure | food | nightlife | beach | nature | shopping | wellness. budget is per person. Do not invent availability — results come from the activities connector.',
    successSummary: 'Activities found',
    failureSummary: 'Activity search failed',
    confirmation: 'none'
  },

  get_destination_weather: {
    risk: 'low',
    required: ['destination'],
    optional: ['date'],
    aliases: { destination: ['city', 'location'] },
    inputExample: { destination: 'Tokyo', date: '2027-04-10' },
    guidance: 'Use when the user asks about weather at a travel destination, or when building an itinerary and weather context is relevant. date is the travel date (ISO preferred). Returns a forecast summary.',
    successSummary: 'Weather checked',
    failureSummary: 'Weather check failed',
    confirmation: 'none'
  },

  estimate_trip_budget: {
    risk: 'low',
    required: ['destination', 'duration', 'partySize'],
    optional: ['style', 'includeFlights', 'includeHotels', 'includeActivities', 'origin'],
    aliases: { destination: ['city', 'location'] },
    inputExample: { destination: 'Tokyo', duration: 10, partySize: 2, style: 'mid', includeFlights: true, origin: 'London' },
    guidance: 'Use when the user asks how much a trip might cost, or when a budget estimate would help planning. style is budget | mid | luxury. Returns a rough breakdown by category. This is an estimate — not a booking.',
    successSummary: 'Budget estimated',
    failureSummary: 'Budget estimation failed',
    confirmation: 'none'
  },

  save_trip: {
    risk: 'low',
    required: ['destination'],
    optional: ['title', 'requirements', 'itinerary', 'budget'],
    aliases: { destination: ['city', 'location'] },
    inputExample: { destination: 'Tokyo', title: 'Tokyo April 2027', requirements: {}, itinerary: {} },
    guidance: 'Use to save the current travel plan to the user\'s trips list. Call this when the user says "save this trip", "keep this plan", or when a plan is complete enough to persist. title is auto-generated from destination + date if not provided.',
    successSummary: 'Trip saved',
    failureSummary: 'Trip save failed',
    confirmation: 'none'
  },

  modify_trip: {
    risk: 'medium',
    required: ['tripId', 'instruction'],
    optional: ['aspect'],
    aliases: { instruction: ['change', 'request', 'modification'] },
    inputExample: { tripId: 'uuid', instruction: 'Make it cheaper and add more outdoor activities', aspect: 'budget' },
    guidance: 'Use when the user wants to change an existing saved trip. instruction is the natural language modification request ("make it cheaper", "add nightlife", "replace museums with outdoor activities"). aspect hints at the primary dimension: budget | accommodation | activities | pace | dining. The AI modifies the existing plan rather than regenerating from scratch.',
    successSummary: 'Trip updated',
    failureSummary: 'Trip modification failed',
    confirmation: 'none'
  }
};

function getActionContract(type) {
  return ACTION_CONTRACTS[type] || null;
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
      cardText: 'Enable location and try again.',
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
  normalizeActionInput,
  validateActionWithContract,
  buildActionRecovery,
  applyActionContractResultMetadata,
  actionPromptBlock
};

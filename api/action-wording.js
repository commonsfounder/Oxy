'use strict';

// Everything a person reads about an action, in one place per action. A missing field means that
// layer falls back to a generic phrase built from the action's contract or its name.
//   name         short noun for failures and approvals ("Directions")
//   progress     present tense, for the working pill: (input) => string
//   summary      past tense for history: (params) => { summary, kind, usedLocation }
//   feed         past tense for the activity feed: (input) => string
//   approval     title of the approval card
//   failureLead  opening of the "connection needs attention" failure

const MAX_DETAIL = 26;

function detail(value) {
  if (value == null || typeof value === 'object') return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text || /^https?:\/\//i.test(text) || /[_{}[\]]/.test(text) || /^\d{4}-\d{2}-\d{2}/.test(text)) return '';
  if (text.length <= MAX_DETAIL) return text;
  const cut = text.slice(0, MAX_DETAIL);
  const atWord = cut.lastIndexOf(' ') > 10 ? cut.slice(0, cut.lastIndexOf(' ')) : cut;
  return `${atWord.replace(/[\s,;:.-]+$/, '')}…`;
}

// A person, not an address or number.
function person(value) {
  const text = detail(value);
  return text && !/[@+]|\d{5,}/.test(text) ? text : '';
}

function site(value) {
  const match = String(value || '').match(/^(?:https?:\/\/)?(?:www\.)?([^/\s]+)/i);
  return match ? match[1] : '';
}

const pick = (specific, general) => (specific ? specific : general);

function clip(value, max = 60) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// First non-empty string among the named params.
function field(params, ...keys) {
  for (const key of keys) {
    const value = params?.[key];
    if (typeof value === 'string' && value.trim()) return clip(value);
  }
  return '';
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function clean(value, max = 140) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function quoted(text) {
  const value = clean(text, 60);
  return value ? `“${value}”` : '';
}

function whoOf(input) {
  return clean(input.contact || input.to || input.recipient || input.name, 40);
}

function withWho(input, verb, noun) {
  const who = whoOf(input);
  return who ? `${verb} ${noun} to ${who}` : `${verb} ${noun}`;
}

const ACTION_WORDING = Object.freeze({
  send_message: {
    name: 'Message',
    progress: (i) => pick(person(i.contact) && `Writing to ${person(i.contact)}`, 'Writing your message'),
    summary: (p) => ({ summary: `Messaged ${field(p, 'contact') || 'someone'}`, kind: 'sent' }),
    feed: (i) => withWho(i, 'Sent', 'a message'),
    approval: 'Message ready to send'
  },
  make_call: {
    name: 'Call',
    progress: (i) => pick(person(i.contact) && `Calling ${person(i.contact)}`, 'Placing the call'),
    summary: (p) => ({ summary: `Called ${field(p, 'contact') || 'someone'}`, kind: 'sent' }),
    feed: (i) => { const who = whoOf(i); return who ? `Opened a call to ${who}` : 'Opened a call'; },
    approval: 'Call ready to make'
  },
  create_reminder: {
    name: 'Reminder',
    progress: (i) => pick(detail(i.title) && `Setting a reminder: ${detail(i.title)}`, 'Setting a reminder'),
    summary: (p) => ({ summary: `Set a reminder${field(p, 'title') ? `: ${field(p, 'title')}` : ''}`, kind: 'did' })
  },
  play_music: {
    name: 'Music',
    progress: (i) => pick(detail(i.query) && `Playing ${detail(i.query)}`, 'Putting some music on'),
    summary: (p) => ({ summary: `Played ${field(p, 'query') || 'music'}`, kind: 'did' })
  },
  play_game: {
    progress: () => 'Setting up a game'
  },
  add_to_music_playlist: {
    name: 'Music',
    progress: (i) => pick(detail(i.playlist) && `Adding to ${detail(i.playlist)}`, 'Adding to your playlist')
  },

  create_calendar_event: {
    name: 'Calendar event',
    progress: (i) => pick(detail(i.title) && `Adding ${detail(i.title)} to your calendar`, 'Adding it to your calendar'),
    summary: (p) => ({ summary: `Added ${field(p, 'title') ? `“${field(p, 'title')}”` : 'an event'} to your calendar`, kind: 'did' }),
    feed: (i) => `Added ${quoted(i.title) || 'an event'} to your calendar`,
    approval: 'Calendar event ready'
  },
  get_calendar_events: {
    name: 'Calendar',
    progress: () => 'Checking your calendar',
    summary: () => ({ summary: 'Checked your calendar', kind: 'looked' }),
    feed: () => 'Checked your calendar',
    failureLead: "I couldn't check your calendar."
  },
  find_appointment_options: {
    progress: () => 'Looking for appointment times'
  },
  book_appointment: {
    name: 'Appointment',
    progress: (i) => pick(detail(i.choice_label) && `Booking ${detail(i.choice_label)}`, 'Booking the appointment'),
    summary: () => ({ summary: 'Booked an appointment', kind: 'did' }),
    feed: () => 'Booked an appointment',
    approval: 'Appointment ready to book'
  },
  find_free_time: {
    progress: () => 'Finding a free slot',
    summary: () => ({ summary: 'Looked for free time in your calendar', kind: 'looked' })
  },
  schedule_block: {
    progress: (i) => pick(detail(i.title) && `Blocking time for ${detail(i.title)}`, 'Blocking out the time'),
    summary: (p) => ({ summary: `Blocked out time${field(p, 'title') ? ` for ${field(p, 'title')}` : ''}`, kind: 'did' })
  },
  move_calendar_event: {
    progress: (i) => pick(detail(i.title) && `Moving ${detail(i.title)}`, 'Moving the event'),
    summary: () => ({ summary: 'Moved a calendar event', kind: 'did' })
  },
  cancel_calendar_event: {
    progress: (i) => pick(detail(i.title) && `Cancelling ${detail(i.title)}`, 'Cancelling the event'),
    summary: () => ({ summary: 'Cancelled a calendar event', kind: 'did' })
  },
  update_calendar_event: {
    progress: (i) => pick(detail(i.title) && `Updating ${detail(i.title)}`, 'Updating the event'),
    summary: () => ({ summary: 'Changed a calendar event', kind: 'did' })
  },
  delete_calendar_event: {
    progress: (i) => pick(detail(i.title) && `Removing ${detail(i.title)}`, 'Removing the event'),
    summary: () => ({ summary: 'Deleted a calendar event', kind: 'did' })
  },
  end_recurring_series: {
    progress: () => 'Ending the repeating event'
  },
  create_outlook_event: {
    progress: (i) => pick(detail(i.title) && `Adding ${detail(i.title)} to your calendar`, 'Adding it to your calendar'),
    summary: (p) => ({ summary: `Added ${field(p, 'title') ? `“${field(p, 'title')}”` : 'an event'} to your calendar`, kind: 'did' })
  },
  get_outlook_events: {
    progress: () => 'Checking your work calendar',
    summary: () => ({ summary: 'Checked your calendar', kind: 'looked' })
  },

  send_email: {
    name: 'Email',
    progress: (i) => pick(person(i.to) && `Emailing ${person(i.to)}`, 'Sending your email'),
    summary: (p) => ({ summary: `Emailed ${field(p, 'to', 'email', 'recipient') || 'someone'}`, kind: 'sent' }),
    feed: (i) => withWho(i, 'Sent', 'an email'),
    approval: 'Email ready to send'
  },
  send_outlook_email: {
    name: 'Email',
    progress: (i) => pick(person(i.to) && `Emailing ${person(i.to)}`, 'Sending your email'),
    summary: (p) => ({ summary: `Emailed ${field(p, 'to', 'email', 'recipient') || 'someone'}`, kind: 'sent' }),
    feed: (i) => withWho(i, 'Sent', 'an email'),
    approval: 'Email ready to send'
  },
  send_adam_email: {
    name: 'Message',
    progress: () => 'Sending the email',
    summary: (p) => ({ summary: `Emailed ${field(p, 'to') || 'someone'}`, kind: 'sent' }),
    feed: (i) => withWho(i, 'Sent', 'a message')
  },
  send_adam_sms: {
    name: 'Message',
    progress: () => 'Sending the text',
    summary: (p) => ({ summary: `Texted ${field(p, 'to', 'contact') || 'someone'}`, kind: 'sent' }),
    feed: (i) => withWho(i, 'Sent', 'a message')
  },
  get_emails: {
    name: 'Email',
    progress: () => 'Checking your email',
    summary: () => ({ summary: 'Checked your email', kind: 'looked' }),
    feed: () => 'Checked your email',
    failureLead: "I couldn't check your email."
  },
  get_outlook_emails: {
    name: 'Email',
    progress: () => 'Checking your work email',
    summary: () => ({ summary: 'Checked your email', kind: 'looked' }),
    failureLead: "I couldn't check your email."
  },
  search_emails: {
    name: 'Email',
    progress: (i) => pick(detail(i.query) && `Searching your email for ${detail(i.query)}`, 'Searching your email'),
    summary: (p) => ({ summary: `Searched your email for ${field(p, 'query') || 'something'}`, kind: 'looked' }),
    feed: () => 'Checked your email',
    failureLead: "I couldn't check your email."
  },
  search_outlook_emails: {
    name: 'Email',
    progress: (i) => pick(detail(i.query) && `Searching work email for ${detail(i.query)}`, 'Searching your work email'),
    summary: (p) => ({ summary: `Searched your email for ${field(p, 'query') || 'something'}`, kind: 'looked' }),
    failureLead: "I couldn't check your email."
  },
  archive_emails: {
    progress: () => 'Archiving those emails',
    summary: () => ({ summary: 'Tidied your inbox', kind: 'did' })
  },
  label_emails: {
    progress: () => 'Sorting those emails',
    summary: () => ({ summary: 'Sorted some emails', kind: 'did' })
  },
  unsubscribe_email: {
    progress: () => 'Unsubscribing you',
    summary: () => ({ summary: 'Unsubscribed you from an email list', kind: 'did' })
  },
  clean_inbox: {
    progress: (i) => pick(detail(i.sender) && `Clearing out ${detail(i.sender)} emails`, 'Tidying your inbox'),
    summary: () => ({ summary: 'Tidied your inbox', kind: 'did' })
  },
  find_reply_needed: {
    progress: () => 'Finding emails that need a reply'
  },

  plan_itinerary: {
    progress: (i) => pick(detail(i.destination) && `Planning your time in ${detail(i.destination)}`, 'Planning the itinerary')
  },
  modify_itinerary: {
    progress: () => 'Reworking the plan'
  },
  plan_trip: {
    name: 'Travel plan',
    progress: (i) => pick(detail(i.destination) && `Planning the trip to ${detail(i.destination)}`, 'Planning the trip'),
    summary: (p) => ({ summary: `Planned a trip to ${field(p, 'destination', 'query', 'place', 'to') || 'a place'}`, kind: 'looked', usedLocation: true }),
    feed: () => 'Planned a trip'
  },
  find_place: {
    name: 'Nearby place',
    progress: (i) => pick(detail(i.query) && `Finding ${detail(i.query)}`, 'Finding the place'),
    summary: (p) => ({ summary: `Looked for ${field(p, 'query', 'destination', 'place', 'address') || 'a place'}`, kind: 'looked', usedLocation: true }),
    feed: (i) => `Looked for ${quoted(i.query || i.place) || 'a place'}`,
    failureLead: "I couldn't find a nearby place."
  },
  get_directions: {
    name: 'Directions',
    progress: (i) => pick(detail(i.destination) && `Getting directions to ${detail(i.destination)}`, 'Getting directions'),
    summary: (p) => ({ summary: `Worked out the way to ${field(p, 'destination', 'query', 'place', 'address') || 'a place'}`, kind: 'looked', usedLocation: true }),
    feed: () => 'Looked up directions',
    failureLead: "I couldn't get directions."
  },
  search_trains: {
    name: 'Train times',
    progress: (i) => pick(detail(i.destination) && `Checking trains to ${detail(i.destination)}`, 'Checking train times'),
    summary: (p) => ({ summary: `Checked trains from ${field(p, 'origin', 'from') || 'here'} to ${field(p, 'destination', 'to') || 'there'}`, kind: 'looked' }),
    feed: () => 'Checked train times'
  },
  search_flights: {
    progress: (i) => pick(detail(i.to) && `Looking at flights to ${detail(i.to)}`, 'Looking at flights')
  },
  search_hotels: {
    progress: (i) => pick(detail(i.location) && `Looking at hotels in ${detail(i.location)}`, 'Looking at hotels')
  },
  track_flight: {
    progress: (i) => pick(detail(i.flight) && `Checking flight ${detail(i.flight)}`, 'Checking the flight')
  },
  book_uber: {
    name: 'Ride',
    progress: (i) => pick(detail(i.destination) && `Getting an Uber to ${detail(i.destination)}`, 'Getting you an Uber'),
    summary: (p) => ({ summary: `Opened an Uber to ${field(p, 'destination', 'query', 'place', 'address') || 'a place'}`, kind: 'did', usedLocation: true }),
    feed: () => 'Booked a ride',
    approval: 'Ride ready to book',
    failureLead: "I couldn't arrange the ride."
  },
  book_lyft: {
    name: 'Ride',
    progress: (i) => pick(detail(i.destination) && `Getting a Lyft to ${detail(i.destination)}`, 'Getting you a Lyft'),
    feed: () => 'Booked a ride',
    approval: 'Ride ready to book',
    failureLead: "I couldn't arrange the ride."
  },
  get_weather: {
    progress: (i) => pick(detail(i.city) && `Checking the weather in ${detail(i.city)}`, 'Checking the weather')
  },
  get_forecast: {
    progress: (i) => pick(detail(i.city) && `Checking the forecast for ${detail(i.city)}`, 'Checking the forecast')
  },

  save_occasion: {
    progress: (i) => pick(person(i.person_name) && `Saving ${person(i.person_name)}'s date`, 'Saving the date')
  },
  find_occasions: {
    progress: (i) => pick(person(i.person_name) && `Looking up ${person(i.person_name)}'s dates`, 'Checking upcoming dates')
  },
  remember_person: {
    progress: (i) => pick(person(i.person_name) && `Remembering that about ${person(i.person_name)}`, 'Remembering that'),
    summary: () => ({ summary: 'Remembered something about someone', kind: 'did' })
  },
  find_people: {
    progress: (i) => pick(person(i.query) && `Looking up ${person(i.query)}`, 'Looking them up')
  },
  forget_person_detail: {
    progress: (i) => pick(person(i.person_name) && `Forgetting that about ${person(i.person_name)}`, 'Forgetting that'),
    summary: () => ({ summary: 'Forgot something about someone', kind: 'did' })
  },
  forget_memory: {
    name: 'Memory',
    progress: () => 'Forgetting that',
    summary: () => ({ summary: 'Forgot something', kind: 'did' })
  },
  get_telegram_contacts: {
    progress: () => 'Checking your Telegram contacts'
  },
  send_telegram: {
    name: 'Message',
    progress: (i) => pick(person(i.contact) && `Messaging ${person(i.contact)} on Telegram`, 'Sending the Telegram message'),
    summary: (p) => ({ summary: `Messaged ${field(p, 'contact') || 'someone'} on Telegram`, kind: 'sent' }),
    feed: (i) => withWho(i, 'Sent', 'a Telegram message'),
    approval: 'Message ready to send'
  },
  search_photos: {
    name: 'Photos',
    progress: (i) => pick(detail(i.query) && `Looking through your photos for ${detail(i.query)}`, 'Looking through your photos'),
    summary: () => ({ summary: 'Looked through your photos', kind: 'found' })
  },
  connected_app_read: {
    name: 'App',
    progress: () => 'Checking one of your apps'
  },
  connected_app_act: {
    name: 'App update',
    progress: () => 'Updating one of your apps',
    approval: 'Change ready to make'
  },
  send_slack_message: {
    progress: (i) => pick(detail(i.channel) && `Posting in ${detail(i.channel)}`, 'Posting on Slack')
  },

  track_commitment: {
    progress: (i) => pick(detail(i.what) && `Keeping track: ${detail(i.what)}`, 'Keeping track of that')
  },
  find_commitments: {
    progress: () => 'Checking what you owe people'
  },
  resolve_commitment: {
    progress: () => 'Marking that as done'
  },
  start_responsibility: {
    progress: (i) => pick(detail(i.goal) && `Taking on: ${detail(i.goal)}`, 'Taking this on')
  },
  update_responsibility: {
    progress: (i) => pick(detail(i.current_step) && `Updating: ${detail(i.current_step)}`, 'Updating the plan')
  },
  list_responsibilities: {
    progress: () => 'Checking what I’m handling'
  },
  daily_digest: {
    progress: () => 'Pulling your day together',
    summary: () => ({ summary: 'Put together your daily check-in', kind: 'looked' })
  },
  set_notification_preference: {
    progress: () => 'Changing how I notify you'
  },
  find_spend: {
    progress: (i) => pick(detail(i.merchant) && `Adding up your ${detail(i.merchant)} spending`, 'Adding up your spending')
  },

  list_paired_displays: {
    progress: () => 'Finding your screens'
  },
  show_scene: {
    progress: (i) => pick(detail(i.title) && `Drawing ${detail(i.title)}`, 'Drawing it out'),
    summary: () => ({ summary: 'Showed something on a display', kind: 'did' })
  },
  get_display_scene: {
    progress: () => 'Checking the screen'
  },
  render_to_display: {
    progress: (i) => pick(detail(i.title) && `Putting ${detail(i.title)} on screen`, 'Putting it on screen'),
    summary: () => ({ summary: 'Showed something on a display', kind: 'did' })
  },

  generate_visual: {
    progress: () => 'Making the image',
    summary: () => ({ summary: 'Made a picture', kind: 'did' })
  },
  create_diagram: {
    progress: (i) => pick(detail(i.topic) && `Drawing a diagram of ${detail(i.topic)}`, 'Drawing a diagram'),
    summary: () => ({ summary: 'Made a diagram', kind: 'did' })
  },
  create_presentation: {
    progress: (i) => pick(detail(i.topic) && `Building slides on ${detail(i.topic)}`, 'Building the slides'),
    summary: () => ({ summary: 'Made a presentation', kind: 'did' })
  },
  edit_photo: {
    progress: () => 'Editing the photo'
  },
  analyze_image: {
    progress: () => 'Looking at the image'
  },

  web_browse: {
    progress: (i) => pick(site(i.url) && `Reading ${site(i.url)}`, 'Reading the page'),
    summary: (p) => ({ summary: hostOf(p?.url) ? `Read a page on ${hostOf(p.url)}` : 'Read a web page', kind: 'looked' })
  },
  web_search: {
    name: 'Search',
    progress: (i) => pick(detail(i.query) && `Looking up ${detail(i.query)}`, 'Looking it up'),
    summary: (p) => ({ summary: `Searched for ${field(p, 'query') || 'something'}`, kind: 'looked' }),
    feed: (i) => `Looked up ${quoted(i.query) || 'something online'}`,
    failureLead: "I couldn't search for that."
  },
  calculate: {
    progress: () => 'Working it out'
  },
  search_amazon: {
    progress: (i) => pick(detail(i.query) && `Looking for ${detail(i.query)} on Amazon`, 'Looking on Amazon')
  },
  get_stock_price: {
    progress: (i) => pick(detail(i.symbol) && `Checking ${detail(i.symbol)}`, 'Checking the price')
  },

  workspace_write: {
    name: 'Saved update',
    progress: () => 'Saving notes'
  },
  workspace_read: {
    name: 'Saved information',
    progress: () => 'Reading my notes'
  },
  workspace_list: {
    name: 'Saved information',
    progress: () => 'Checking my notes'
  },
  project_status: {
    name: 'Project update',
    progress: () => 'Checking the project'
  },
  project_diff: {
    name: 'Changes',
    progress: () => 'Reviewing the changes'
  },
  project_write: {
    name: 'Saved update',
    progress: () => 'Writing the code'
  },
  project_check: {
    name: 'Check',
    progress: () => 'Testing the changes'
  },
  project_commit: {
    name: 'Saved update',
    progress: () => 'Saving the changes'
  },
  project_rollback: {
    name: 'Reverted update',
    progress: () => 'Undoing the changes'
  },
  project_sync: {
    name: 'Published update',
    progress: () => 'Syncing the project'
  },
  github_action: {
    progress: () => 'Checking GitHub'
  },
  create_github_issue: {
    name: 'GitHub issue',
    progress: () => 'Filing the issue'
  },
  get_github_prs: {
    progress: () => 'Checking open pull requests'
  },

  create_agent_task: {
    progress: () => 'Setting up the job',
    feed: (i) => `Set up ${quoted(i.title || i.goal) || 'a task'}`
  },
  create_scheduled_task: {
    progress: (i) => pick(detail(i.title) && `Setting up: ${detail(i.title)}`, 'Setting up the routine'),
    summary: () => ({ summary: 'Set up something to run later', kind: 'did' }),
    feed: (i) => `Set up ${quoted(i.title || i.goal) || 'a task'}`
  },
  list_scheduled_tasks: {
    progress: () => 'Checking your routines'
  },
  update_scheduled_task: {
    progress: () => 'Updating the routine'
  },
  record_watch_observation: {
    progress: () => 'Noting the latest'
  },
  cancel_scheduled_task: {
    progress: () => 'Stopping the routine',
    summary: () => ({ summary: 'Cancelled something scheduled', kind: 'did' })
  },
  simulate_actions: {
    progress: () => 'Trying it out first'
  },

  log_health: {
    progress: () => 'Logging that'
  },
  get_strava_activities: {
    progress: () => 'Checking your workouts'
  },
  get_oura_sleep: {
    progress: () => 'Checking your sleep'
  },
  get_oura_readiness: {
    progress: () => 'Checking your readiness'
  },
  control_smart_home: {
    progress: () => 'Adjusting your home',
    summary: (p) => ({ summary: `Changed ${field(p, 'device') || 'a device'}${field(p, 'command') ? ` (${field(p, 'command')})` : ''}`, kind: 'did' })
  },

  save_to_notion: {
    progress: () => 'Saving to Notion',
    summary: () => ({ summary: 'Saved something to Notion', kind: 'did' })
  },
  create_google_doc: {
    progress: (i) => pick(detail(i.title) && `Creating ${detail(i.title)}`, 'Creating the doc'),
    summary: () => ({ summary: 'Created a document', kind: 'did' })
  },
  search_google_docs: {
    progress: (i) => pick(detail(i.query) && `Searching your docs for ${detail(i.query)}`, 'Searching your docs')
  },
  append_google_doc: {
    progress: (i) => pick(detail(i.title) && `Adding to ${detail(i.title)}`, 'Adding to the doc'),
    summary: () => ({ summary: 'Added to a document', kind: 'did' })
  },
  get_google_doc: {
    progress: (i) => pick(detail(i.title) && `Opening ${detail(i.title)}`, 'Opening the doc')
  },
  mcp_tool: {
    progress: () => 'Using a connected app'
  },

  check_concierge_balance: {
    progress: () => 'Checking the balance'
  },
  spend_from_concierge_account: {
    progress: (i) => pick(detail(i.merchant) && `Paying ${detail(i.merchant)}`, 'Making the payment')
  },
  top_up_concierge_account: {
    progress: () => 'Topping up'
  },
  receive_to_concierge_account: {
    progress: () => 'Recording the payment'
  },
  fund_opportunity: {
    progress: () => 'Making the payment'
  },
  stripe_charge: {
    progress: () => 'Taking the payment'
  },
  stripe_payout_to_user: {
    progress: () => 'Sending the payout'
  },
  spend_from_concierge_via_stripe: {
    progress: () => 'Making the payment'
  },

  browser_open: {
    progress: (i) => pick(site(i.url) && `Opening ${site(i.url)}`, 'Opening the website')
  },
  browser_observe: {
    progress: () => 'Looking at the page'
  },
  browser_act: {
    progress: () => 'Filling it in'
  },
  browser_upload: {
    progress: () => 'Adding the file'
  },
  browser_download: {
    progress: () => 'Downloading'
  },
  browser_continue_without_account: {
    progress: () => 'Continuing as a guest'
  },
  browser_sign_in: {
    progress: (i) => pick(detail(i.site) && `Signing in to ${detail(i.site)}`, 'Signing in')
  },
  browser_fill_known_details: {
    progress: () => 'Filling in your details'
  },
  browser_close: {
    progress: () => 'Finishing up'
  },
  transaction_prepare: {
    progress: () => 'Getting the total'
  },
  transaction_authorize: {
    progress: () => 'Waiting for your yes',
    feed: () => 'Placed an order'
  },
  transaction_status: {
    progress: () => 'Checking the order',
    feed: () => 'Checked an order'
  },

  check_health: {
    feed: () => 'Checked your health data'
  }
});

module.exports = { ACTION_WORDING };

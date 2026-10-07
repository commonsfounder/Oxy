'use strict';
// One plain line per action for the phone's working pill, specific when the input allows.
// Start and finish must produce the same line: the phone matches them by text.

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

const LINES = {
  send_message: (i) => pick(person(i.contact) && `Writing to ${person(i.contact)}`, 'Writing your message'),
  make_call: (i) => pick(person(i.contact) && `Calling ${person(i.contact)}`, 'Placing the call'),
  create_reminder: (i) => pick(detail(i.title) && `Setting a reminder: ${detail(i.title)}`, 'Setting a reminder'),
  play_music: (i) => pick(detail(i.query) && `Playing ${detail(i.query)}`, 'Putting some music on'),
  play_game: () => 'Setting up a game',
  add_to_music_playlist: (i) => pick(detail(i.playlist) && `Adding to ${detail(i.playlist)}`, 'Adding to your playlist'),

  create_calendar_event: (i) => pick(detail(i.title) && `Adding ${detail(i.title)} to your calendar`, 'Adding it to your calendar'),
  get_calendar_events: () => 'Checking your calendar',
  find_appointment_options: () => 'Looking for appointment times',
  book_appointment: (i) => pick(detail(i.choice_label) && `Booking ${detail(i.choice_label)}`, 'Booking the appointment'),
  find_free_time: () => 'Finding a free slot',
  schedule_block: (i) => pick(detail(i.title) && `Blocking time for ${detail(i.title)}`, 'Blocking out the time'),
  move_calendar_event: (i) => pick(detail(i.title) && `Moving ${detail(i.title)}`, 'Moving the event'),
  cancel_calendar_event: (i) => pick(detail(i.title) && `Cancelling ${detail(i.title)}`, 'Cancelling the event'),
  update_calendar_event: (i) => pick(detail(i.title) && `Updating ${detail(i.title)}`, 'Updating the event'),
  delete_calendar_event: (i) => pick(detail(i.title) && `Removing ${detail(i.title)}`, 'Removing the event'),
  end_recurring_series: () => 'Ending the repeating event',
  create_outlook_event: (i) => pick(detail(i.title) && `Adding ${detail(i.title)} to your calendar`, 'Adding it to your calendar'),
  get_outlook_events: () => 'Checking your work calendar',

  send_email: (i) => pick(person(i.to) && `Emailing ${person(i.to)}`, 'Sending your email'),
  send_outlook_email: (i) => pick(person(i.to) && `Emailing ${person(i.to)}`, 'Sending your email'),
  send_adam_email: () => 'Sending the email',
  send_adam_sms: () => 'Sending the text',
  get_emails: () => 'Checking your email',
  get_outlook_emails: () => 'Checking your work email',
  search_emails: (i) => pick(detail(i.query) && `Searching your email for ${detail(i.query)}`, 'Searching your email'),
  search_outlook_emails: (i) => pick(detail(i.query) && `Searching work email for ${detail(i.query)}`, 'Searching your work email'),
  archive_emails: () => 'Archiving those emails',
  label_emails: () => 'Sorting those emails',
  unsubscribe_email: () => 'Unsubscribing you',
  clean_inbox: (i) => pick(detail(i.sender) && `Clearing out ${detail(i.sender)} emails`, 'Tidying your inbox'),
  find_reply_needed: () => 'Finding emails that need a reply',

  plan_itinerary: (i) => pick(detail(i.destination) && `Planning your time in ${detail(i.destination)}`, 'Planning the itinerary'),
  modify_itinerary: () => 'Reworking the plan',
  plan_trip: (i) => pick(detail(i.destination) && `Planning the trip to ${detail(i.destination)}`, 'Planning the trip'),
  find_place: (i) => pick(detail(i.query) && `Finding ${detail(i.query)}`, 'Finding the place'),
  get_directions: (i) => pick(detail(i.destination) && `Getting directions to ${detail(i.destination)}`, 'Getting directions'),
  search_trains: (i) => pick(detail(i.destination) && `Checking trains to ${detail(i.destination)}`, 'Checking train times'),
  search_flights: (i) => pick(detail(i.to) && `Looking at flights to ${detail(i.to)}`, 'Looking at flights'),
  search_hotels: (i) => pick(detail(i.location) && `Looking at hotels in ${detail(i.location)}`, 'Looking at hotels'),
  track_flight: (i) => pick(detail(i.flight) && `Checking flight ${detail(i.flight)}`, 'Checking the flight'),
  book_uber: (i) => pick(detail(i.destination) && `Getting an Uber to ${detail(i.destination)}`, 'Getting you an Uber'),
  book_lyft: (i) => pick(detail(i.destination) && `Getting a Lyft to ${detail(i.destination)}`, 'Getting you a Lyft'),
  get_weather: (i) => pick(detail(i.city) && `Checking the weather in ${detail(i.city)}`, 'Checking the weather'),
  get_forecast: (i) => pick(detail(i.city) && `Checking the forecast for ${detail(i.city)}`, 'Checking the forecast'),

  save_occasion: (i) => pick(person(i.person_name) && `Saving ${person(i.person_name)}'s date`, 'Saving the date'),
  find_occasions: (i) => pick(person(i.person_name) && `Looking up ${person(i.person_name)}'s dates`, 'Checking upcoming dates'),
  remember_person: (i) => pick(person(i.person_name) && `Remembering that about ${person(i.person_name)}`, 'Remembering that'),
  find_people: (i) => pick(person(i.query) && `Looking up ${person(i.query)}`, 'Looking them up'),
  forget_person_detail: (i) => pick(person(i.person_name) && `Forgetting that about ${person(i.person_name)}`, 'Forgetting that'),
  forget_memory: () => 'Forgetting that',
  get_telegram_contacts: () => 'Checking your Telegram contacts',
  send_telegram: (i) => pick(person(i.contact) && `Messaging ${person(i.contact)} on Telegram`, 'Sending the Telegram message'),
  send_slack_message: (i) => pick(detail(i.channel) && `Posting in ${detail(i.channel)}`, 'Posting on Slack'),

  track_commitment: (i) => pick(detail(i.what) && `Keeping track: ${detail(i.what)}`, 'Keeping track of that'),
  find_commitments: () => 'Checking what you owe people',
  resolve_commitment: () => 'Marking that as done',
  start_responsibility: (i) => pick(detail(i.goal) && `Taking on: ${detail(i.goal)}`, 'Taking this on'),
  update_responsibility: (i) => pick(detail(i.current_step) && `Updating: ${detail(i.current_step)}`, 'Updating the plan'),
  list_responsibilities: () => 'Checking what I’m handling',
  daily_digest: () => 'Pulling your day together',
  set_notification_preference: () => 'Changing how I notify you',
  find_spend: (i) => pick(detail(i.merchant) && `Adding up your ${detail(i.merchant)} spending`, 'Adding up your spending'),

  list_paired_displays: () => 'Finding your screens',
  show_scene: (i) => pick(detail(i.title) && `Drawing ${detail(i.title)}`, 'Drawing it out'),
  get_display_scene: () => 'Checking the screen',
  render_to_display: (i) => pick(detail(i.title) && `Putting ${detail(i.title)} on screen`, 'Putting it on screen'),

  generate_visual: () => 'Making the image',
  create_diagram: (i) => pick(detail(i.topic) && `Drawing a diagram of ${detail(i.topic)}`, 'Drawing a diagram'),
  create_presentation: (i) => pick(detail(i.topic) && `Building slides on ${detail(i.topic)}`, 'Building the slides'),
  edit_photo: () => 'Editing the photo',
  analyze_image: () => 'Looking at the image',

  web_browse: (i) => pick(site(i.url) && `Reading ${site(i.url)}`, 'Reading the page'),
  web_search: (i) => pick(detail(i.query) && `Looking up ${detail(i.query)}`, 'Looking it up'),
  calculate: () => 'Working it out',
  search_amazon: (i) => pick(detail(i.query) && `Looking for ${detail(i.query)} on Amazon`, 'Looking on Amazon'),
  get_stock_price: (i) => pick(detail(i.symbol) && `Checking ${detail(i.symbol)}`, 'Checking the price'),

  workspace_write: () => 'Saving notes',
  workspace_read: () => 'Reading my notes',
  workspace_list: () => 'Checking my notes',
  project_status: () => 'Checking the project',
  project_diff: () => 'Reviewing the changes',
  project_write: () => 'Writing the code',
  project_check: () => 'Testing the changes',
  project_commit: () => 'Saving the changes',
  project_rollback: () => 'Undoing the changes',
  project_sync: () => 'Syncing the project',
  github_action: () => 'Checking GitHub',
  create_github_issue: () => 'Filing the issue',
  get_github_prs: () => 'Checking open pull requests',

  create_agent_task: () => 'Setting up the job',
  create_scheduled_task: (i) => pick(detail(i.title) && `Setting up: ${detail(i.title)}`, 'Setting up the routine'),
  list_scheduled_tasks: () => 'Checking your routines',
  update_scheduled_task: () => 'Updating the routine',
  record_watch_observation: () => 'Noting the latest',
  cancel_scheduled_task: () => 'Stopping the routine',
  simulate_actions: () => 'Trying it out first',

  log_health: () => 'Logging that',
  get_strava_activities: () => 'Checking your workouts',
  get_oura_sleep: () => 'Checking your sleep',
  get_oura_readiness: () => 'Checking your readiness',
  control_smart_home: () => 'Adjusting your home',

  save_to_notion: () => 'Saving to Notion',
  create_google_doc: (i) => pick(detail(i.title) && `Creating ${detail(i.title)}`, 'Creating the doc'),
  search_google_docs: (i) => pick(detail(i.query) && `Searching your docs for ${detail(i.query)}`, 'Searching your docs'),
  append_google_doc: (i) => pick(detail(i.title) && `Adding to ${detail(i.title)}`, 'Adding to the doc'),
  get_google_doc: (i) => pick(detail(i.title) && `Opening ${detail(i.title)}`, 'Opening the doc'),
  mcp_tool: () => 'Using a connected app',

  check_concierge_balance: () => 'Checking the balance',
  spend_from_concierge_account: (i) => pick(detail(i.merchant) && `Paying ${detail(i.merchant)}`, 'Making the payment'),
  top_up_concierge_account: () => 'Topping up',
  receive_to_concierge_account: () => 'Recording the payment',
  fund_opportunity: () => 'Making the payment',
  stripe_charge: () => 'Taking the payment',
  stripe_payout_to_user: () => 'Sending the payout',
  spend_from_concierge_via_stripe: () => 'Making the payment',

  browser_open: (i) => pick(site(i.url) && `Opening ${site(i.url)}`, 'Opening the website'),
  browser_observe: () => 'Looking at the page',
  browser_act: () => 'Filling it in',
  browser_upload: () => 'Adding the file',
  browser_download: () => 'Downloading',
  browser_continue_without_account: () => 'Continuing as a guest',
  browser_sign_in: (i) => pick(detail(i.site) && `Signing in to ${detail(i.site)}`, 'Signing in'),
  browser_fill_known_details: () => 'Filling in your details',
  browser_close: () => 'Finishing up',
  transaction_prepare: () => 'Getting the total',
  transaction_authorize: () => 'Waiting for your yes',
  transaction_status: () => 'Checking the order'
};

// An unknown action gets a plain phrase, never its internal name.
function progressLine(type, input = {}) {
  const line = LINES[type];
  if (!line) return 'Working on it';
  try {
    return line(input && typeof input === 'object' ? input : {}) || 'Working on it';
  } catch {
    return 'Working on it';
  }
}

module.exports = { progressLine, PROGRESS_LINES: LINES };

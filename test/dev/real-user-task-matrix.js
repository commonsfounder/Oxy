'use strict';

// A broad, redacted acceptance corpus for the things people actually ask a
// household worker to do. This is deliberately separate from the 50-site
// shopping benchmark: shopping is one slice of a consumer agent, not the whole
// product.
//
// Safe live runs execute only read-only/local tasks. Approval and browser tasks
// may be selected explicitly, but the runner never confirms a purchase, sends a
// message, submits a signup, or enters payment without a separate user action.

const TASKS = [
  // Household state and personal admin.
  { id: 'daily-brief', group: 'household-read', mode: 'safe', expectedAction: 'daily_digest', message: 'Give me a short briefing of what I need to deal with today.' },
  { id: 'calendar-tomorrow', group: 'household-read', mode: 'safe', expectedAction: 'get_calendar_events', message: 'What is on my calendar tomorrow?' },
  { id: 'urgent-email', group: 'household-read', mode: 'safe', expectedAction: 'get_emails', message: 'Check my email for anything urgent today.' },
  { id: 'search-receipt', group: 'household-read', mode: 'safe', expectedAction: 'search_emails', message: 'Find the email with my Amazon receipt from last month.' },
  { id: 'reply-needed', group: 'household-read', mode: 'safe', expectedAction: 'find_reply_needed', message: 'Which messages do I still need to reply to?' },
  { id: 'occasions', group: 'household-read', mode: 'safe', expectedAction: 'find_occasions', message: 'Do I have any birthdays or occasions coming up?' },
  { id: 'commitments', group: 'household-read', mode: 'safe', expectedAction: 'find_commitments', message: 'What have I said I would do but not finished?' },
  { id: 'responsibilities', group: 'household-read', mode: 'safe', expectedAction: 'list_responsibilities', message: 'Show me my active responsibilities.' },
  { id: 'scheduled-tasks', group: 'household-read', mode: 'safe', expectedAction: 'list_scheduled_tasks', message: 'What is Millie currently watching or scheduled to do?' },
  { id: 'paired-displays', group: 'household-read', mode: 'safe', expectedAction: 'list_paired_displays', message: 'Which of my displays are paired?' },
  { id: 'spend-search', group: 'household-read', mode: 'safe', expectedAction: 'find_spend', message: 'How much did I spend at Amazon last month?' },
  { id: 'people-search', group: 'household-read', mode: 'safe', expectedAction: 'find_people', message: 'What do you remember about Alex?' },

  { id: 'reminder', group: 'household-write', mode: 'state', expectedAction: 'create_reminder', message: 'Remind me tomorrow at 9am to call the dentist.' },
  { id: 'commitment', group: 'household-write', mode: 'state', expectedAction: 'track_commitment', message: 'Remember that I said I will send the tenancy documents this week.' },
  { id: 'responsibility', group: 'household-write', mode: 'state', expectedAction: 'start_responsibility', message: 'Start a responsibility for renewing my car insurance.' },
  { id: 'occasion-save', group: 'household-write', mode: 'state', expectedAction: 'save_occasion', message: 'Remember that Alex has a birthday on 14 September.' },
  { id: 'remember-person', group: 'household-write', mode: 'state', expectedAction: 'remember_person', message: 'Remember that Alex prefers vegetarian restaurants.' },
  { id: 'notification-preference', group: 'household-write', mode: 'state', expectedAction: 'set_notification_preference', message: 'Only notify me about urgent reminders by Telegram.' },
  { id: 'scheduled-watch', group: 'household-write', mode: 'state', expectedAction: 'create_scheduled_task', message: 'Every Friday, check whether train fares from Birmingham to London have dropped and tell me.' },
  { id: 'agent-task', group: 'household-write', mode: 'state', expectedAction: 'create_agent_task', message: 'Keep an eye on the price of a replacement washing machine and let me know if one under £400 appears.' },
  { id: 'resolve-commitment', group: 'household-write', mode: 'state', expectedAction: 'resolve_commitment', message: 'Mark the tenancy documents commitment as done.' },
  { id: 'cancel-watch', group: 'household-write', mode: 'state', expectedAction: 'cancel_scheduled_task', message: 'Stop the washing machine price watch.' },

  // Calendar, communications, and account-connected work. These are selected
  // in approval mode only when they can reach a review boundary without sending.
  { id: 'create-event', group: 'approval', mode: 'approval', expectedAction: 'create_calendar_event', message: 'Put a dentist appointment in my calendar next Tuesday from 2pm to 3pm.' },
  { id: 'move-event', group: 'approval', mode: 'approval', expectedAction: 'move_calendar_event', message: 'Move my dentist appointment next Tuesday to 4pm.' },
  { id: 'cancel-event', group: 'approval', mode: 'approval', expectedAction: 'cancel_calendar_event', message: 'Cancel my dentist appointment next Tuesday.' },
  { id: 'text-friend', group: 'approval', mode: 'approval', expectedAction: 'send_message', message: 'Text Alex that I am running ten minutes late.' },
  { id: 'email-landlord', group: 'approval', mode: 'approval', expectedAction: 'send_email', message: 'Email my landlord asking whether the boiler repair has been scheduled.' },
  { id: 'millie-business-email', group: 'approval', mode: 'approval', expectedAction: 'send_millie_email', message: 'Email the restaurant and ask whether they can move our booking to 8pm.' },
  { id: 'millie-business-sms', group: 'approval', mode: 'approval', expectedAction: 'send_millie_sms', message: 'Text the courier company and ask where my delivery is.' },
  { id: 'call-dentist', group: 'approval', mode: 'approval', expectedAction: 'make_call', message: 'Call the dentist and ask for their next available appointment.' },
  { id: 'telegram-contact', group: 'approval', mode: 'approval', expectedAction: 'send_telegram', message: 'Send Jamie a Telegram message saying dinner is at 7.' },
  { id: 'slack-message', group: 'approval', mode: 'approval', expectedAction: 'send_slack_message', message: 'Send #team a Slack message saying the release is ready for review.' },
  { id: 'archive-newsletters', group: 'approval', mode: 'approval', expectedAction: 'archive_emails', message: 'Archive all the shopping newsletters from this week.' },
  { id: 'label-receipts', group: 'approval', mode: 'approval', expectedAction: 'label_emails', message: 'Label my Amazon receipts as Expenses.' },
  { id: 'unsubscribe', group: 'approval', mode: 'approval', expectedAction: 'unsubscribe_email', message: 'Unsubscribe me from the daily retail newsletter.' },

  // Public information and travel.
  { id: 'weather', group: 'public-read', mode: 'safe', expectedAction: 'get_weather', message: 'What is the weather in London right now?' },
  { id: 'forecast', group: 'public-read', mode: 'safe', expectedAction: 'get_forecast', message: 'What will the weather be like in Manchester this weekend?' },
  { id: 'stock', group: 'public-read', mode: 'safe', expectedAction: 'get_stock_price', message: 'What is the current price of AAPL?' },
  { id: 'amazon-search', group: 'public-read', mode: 'safe', expectedAction: 'search_amazon', message: 'Find noise-cancelling headphones on Amazon and show me the options.' },
  { id: 'place-search', group: 'public-read', mode: 'safe', expectedAction: 'find_place', message: 'Find a highly rated Italian restaurant near Birmingham city centre.' },
  { id: 'directions', group: 'public-read', mode: 'safe', expectedAction: 'get_directions', message: 'How do I get from Birmingham New Street to the Bullring?' },
  { id: 'trip-route', group: 'public-read', mode: 'safe', expectedAction: 'plan_trip', message: 'Plan a route from Birmingham to Manchester by public transport.' },
  { id: 'flight-search', group: 'public-read', mode: 'safe', expectedAction: 'search_flights', message: 'Find direct flights from Birmingham to Prague in September under £200.' },
  { id: 'hotel-search', group: 'public-read', mode: 'safe', expectedAction: 'search_hotels', message: 'Find a well-rated hotel in Bath for two nights under £140 per night.' },
  { id: 'itinerary', group: 'public-read', mode: 'safe', expectedAction: 'plan_itinerary', message: 'Plan a three-day trip to Edinburgh starting 1 October.' },
  { id: 'train-search', group: 'public-read', mode: 'safe', expectedAction: 'search_trains', message: 'Find the first train from Birmingham to London tomorrow morning.' },
  { id: 'station-board', group: 'public-read', mode: 'safe', expectedAction: 'station_board', message: 'Show departures from Birmingham New Street in the next hour.' },
  { id: 'flight-watch', group: 'public-read', mode: 'safe', expectedAction: 'track_flight', message: 'Track BA flight 142 from London to New York.' },

  // Browser tasks. These are never auto-confirmed by this harness. An order is
  // successful only when the browser reaches a review/payment boundary; a signup
  // is successful only when it stops for the user's email/password/confirmation.
  { id: 'order-john-lewis', group: 'browser', mode: 'browser', expectedAction: 'run_browser_task', boundary: 'checkout', message: 'On John Lewis, order a plain men\'s sweatshirt in size medium and take it to checkout.' },
  { id: 'order-groceries', group: 'browser', mode: 'browser', expectedAction: 'run_browser_task', boundary: 'checkout', message: 'On Sainsbury\'s, add semi-skimmed milk, bread, and bananas to a basket and take it to checkout.' },
  { id: 'order-electronics', group: 'browser', mode: 'browser', expectedAction: 'run_browser_task', boundary: 'checkout', message: 'On Currys, find a wireless mouse, add it to the basket, and go to checkout.' },
  { id: 'order-takeaway', group: 'browser', mode: 'browser', expectedAction: 'run_browser_task', boundary: 'checkout', message: 'Order a pizza from a nearby restaurant for delivery to Birmingham city centre.' },
  { id: 'signup-newsletter', group: 'browser', mode: 'browser', expectedAction: 'run_browser_task', boundary: 'user-data', message: 'Sign me up for the newsletter on the John Lewis website.' },
  { id: 'signup-service', group: 'browser', mode: 'browser', expectedAction: 'run_browser_task', boundary: 'user-data', message: 'Create an account for me on the retailer website so I can save items.' },
  { id: 'book-dentist-site', group: 'browser', mode: 'browser', expectedAction: 'run_browser_task', boundary: 'review', message: 'Find and book the next available dentist appointment through the practice website.' },
  { id: 'restaurant-booking', group: 'browser', mode: 'browser', expectedAction: 'run_browser_task', boundary: 'review', message: 'Book a table for two at an Italian restaurant this Saturday at 7pm.' },
  { id: 'book-hotel', group: 'browser', mode: 'browser', expectedAction: 'run_browser_task', boundary: 'review', message: 'Book the hotel I choose after you show me the exact price and cancellation terms.' },
  { id: 'book-flight', group: 'browser', mode: 'browser', expectedAction: 'run_browser_task', boundary: 'review', message: 'Book the flight I choose after you show me the final fare and baggage terms.' },
  { id: 'return-order', group: 'browser', mode: 'browser', expectedAction: 'run_browser_task', boundary: 'user-data', message: 'Start a return for my latest online order and tell me what information you need.' },
  { id: 'track-parcel', group: 'browser', mode: 'browser', expectedAction: 'run_browser_task', boundary: 'user-data', message: 'Check the courier website for my parcel and tell me its current status.' },
  { id: 'compare-products', group: 'browser', mode: 'browser', expectedAction: 'run_browser_task', boundary: 'answer', message: 'Compare the current prices of the Dyson V15 at Amazon and John Lewis.' },

  // Work, project, and artefact tasks.
  { id: 'web-search', group: 'work-read', mode: 'safe', expectedAction: 'web_search', message: 'Search the web for the latest UK student finance repayment thresholds.' },
  { id: 'web-browse', group: 'work-read', mode: 'safe', expectedAction: 'web_browse', message: 'Open the official GOV.UK page for applying for a provisional driving licence.' },
  { id: 'calculate', group: 'work-read', mode: 'safe', expectedAction: 'calculate', message: 'Calculate 17.5% VAT on £840 and show the total.' },
  { id: 'notion-search', group: 'work-read', mode: 'safe', expectedAction: 'search_google_docs', message: 'Find my notes about the Oxy launch.' },
  { id: 'github-prs', group: 'work-read', mode: 'safe', expectedAction: 'get_github_prs', message: 'Show me the open pull requests on commonsfounder/Oxy.' },
  { id: 'workspace-list', group: 'work-read', mode: 'safe', expectedAction: 'workspace_list', message: 'List the files in the current workspace.' },
  { id: 'project-status', group: 'work-read', mode: 'safe', expectedAction: 'project_status', message: 'What is the current status of the project?' },
  { id: 'project-diff', group: 'work-read', mode: 'safe', expectedAction: 'project_diff', message: 'Show me the uncommitted changes in the project.' },
  { id: 'project-check', group: 'work-read', mode: 'safe', expectedAction: 'project_check', message: 'Run the project checks and tell me what fails.' },
  { id: 'create-doc', group: 'work-write', mode: 'state', expectedAction: 'create_google_doc', message: 'Create a Google Doc called Launch checklist with the heading Oxy release.' },
  { id: 'create-issue', group: 'approval', mode: 'approval', expectedAction: 'create_github_issue', message: 'Create a GitHub issue in commonsfounder/Oxy for the broken paired-display migration.' },
  { id: 'create-agent-task', group: 'household-write', mode: 'state', expectedAction: 'create_agent_task', message: 'Keep checking the release until the Fly health endpoint is green.' },
  { id: 'presentation', group: 'work-write', mode: 'safe', expectedAction: 'create_presentation', message: 'Create a short presentation explaining the Oxy product and its current limitations.' },
  { id: 'diagram', group: 'work-write', mode: 'safe', expectedAction: 'create_diagram', message: 'Create a diagram of the request flow from the iPhone app to Fly and Supabase.' },
  { id: 'visual', group: 'work-write', mode: 'safe', expectedAction: 'generate_visual', message: 'Generate a simple visual concept for a calm ambient household assistant.' },

  // Home, health, finance, and transport. Money and device control are review
  // boundaries; they are never executed by this acceptance runner.
  { id: 'smart-light', group: 'approval', mode: 'approval', expectedAction: 'control_smart_home', message: 'Turn on the living-room lights.' },
  { id: 'smart-temperature', group: 'approval', mode: 'approval', expectedAction: 'control_smart_home', message: 'Set the bedroom thermostat to 19 degrees.' },
  { id: 'concierge-balance', group: 'finance-read', mode: 'safe', expectedAction: 'check_concierge_balance', expectedAvailability: 'unavailable', message: 'How much money is in my concierge balance?' },
  { id: 'spend-money', group: 'approval', mode: 'approval', expectedAction: 'spend_from_concierge_account', message: 'Pay £25 to the plumber from my concierge balance.' },
  { id: 'stripe-charge', group: 'approval', mode: 'approval', expectedAction: 'stripe_charge', message: 'Charge £10 to the saved card for the test subscription.' },
  { id: 'book-uber', group: 'approval', mode: 'approval', expectedAction: 'book_uber', message: 'Get me an Uber to Birmingham New Street.' },
  { id: 'book-lyft', group: 'approval', mode: 'approval', expectedAction: 'book_lyft', message: 'Book me a Lyft to the airport.' },
  { id: 'strava', group: 'health-read', mode: 'safe', expectedAction: 'get_strava_activities', message: 'Show me my latest Strava activities.' },
  { id: 'oura', group: 'health-read', mode: 'safe', expectedAction: 'get_oura_readiness', message: 'How was my readiness score yesterday?' },
  { id: 'image-analysis', group: 'health-read', mode: 'safe', expectedAction: 'analyze_image', expectedAvailability: 'unavailable', message: 'Look at this image and tell me what is in it.' },
  { id: 'music', group: 'public-read', mode: 'safe', expectedAction: 'play_music', message: 'Play some calm instrumental music.' },
  { id: 'playlist', group: 'state', mode: 'state', expectedAction: 'add_to_music_playlist', message: 'Add a calm instrumental track to my evening playlist.' },
  { id: 'display-render', group: 'state', mode: 'state', expectedAction: 'render_to_display', message: 'Show the message "Dinner is ready" on my paired display.' },
];

const GROUPS = [...new Set(TASKS.map(task => task.group))];
const MODES = [...new Set(TASKS.map(task => task.mode))];

function selectTasks({ groups = [], modes = [], ids = [], limit = 0 } = {}) {
  const groupSet = new Set(groups.filter(Boolean));
  const modeSet = new Set(modes.filter(Boolean));
  const idSet = new Set(ids.filter(Boolean));
  let selected = TASKS.filter(task =>
    (!groupSet.size || groupSet.has(task.group)) &&
    (!modeSet.size || modeSet.has(task.mode)) &&
    (!idSet.size || idSet.has(task.id))
  );
  if (limit > 0) selected = selected.slice(0, limit);
  return selected;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = { groups: [], modes: [], ids: [], limit: 0 };
  for (const arg of argv) {
    const [key, value = ''] = arg.split('=', 2);
    if (key === '--group') options.groups.push(...value.split(',').filter(Boolean));
    if (key === '--mode') options.modes.push(...value.split(',').filter(Boolean));
    if (key === '--id') options.ids.push(...value.split(',').filter(Boolean));
    if (key === '--limit') options.limit = Number(value) || 0;
    if (arg === '--list') {
      console.log(JSON.stringify({ groups: GROUPS, modes: MODES, tasks: TASKS }, null, 2));
      process.exit(0);
    }
  }
  return options;
}

function actionReceipt(reply) {
  return (reply?.actions || []).map(entry => ({
    action: entry.action,
    outcome: entry.result?.outcome || entry.result?.type || null,
    success: entry.result?.success,
    error: entry.result?.error || null,
    text: String(entry.result?.text || entry.result?.summary || entry.result?.question || '').replace(/\s+/g, ' ').slice(0, 180)
  }));
}

function classify(task, reply) {
  const receipts = actionReceipt(reply);
  const matching = receipts.filter(receipt => receipt.action === task.expectedAction);
  if (!matching.length) return { status: 'wrong_route', receipts };
  const result = matching[matching.length - 1];
  if (task.mode === 'approval') {
    if (result.outcome === 'awaiting_user' || /approval|confirm|review|permission/i.test(`${result.text} ${result.error}`)) return { status: 'approval_boundary', receipts };
    if (result.outcome === 'unavailable') return { status: 'setup_blocked', receipts };
    return { status: result.success === false ? 'failed' : 'effect_risk', receipts };
  }
  if (task.mode === 'browser') {
    if (/checkout|review|user-data/i.test(task.boundary || '') && /payment|checkout|login|sign.?up|email|address|password|account/i.test(`${result.text} ${result.error}`)) return { status: 'browser_boundary', receipts };
    if (task.boundary === 'answer' && result.outcome === 'completed') return { status: 'completed', receipts };
    if (result.outcome === 'unavailable' || result.outcome === 'handoff_required' || result.outcome === 'reauth') return { status: 'setup_or_handoff', receipts };
    return { status: result.success === false ? 'failed' : 'browser_progress', receipts };
  }
  if (result.outcome === 'completed' || result.success === true) return { status: 'completed', receipts };
  if (result.outcome === 'unavailable') return { status: 'setup_blocked', receipts };
  if (result.outcome === 'handoff_required') return { status: 'handoff_required', receipts };
  return { status: result.success === false ? 'failed' : 'incomplete', receipts };
}

async function postChat(base, token, task, userId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.OXY_MATRIX_TURN_TIMEOUT_MS || 120000));
  try {
    const response = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId, message: task.message }),
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { httpStatus: response.status, error: body.error || 'request failed' };
    return body;
  } catch (error) {
    return { error: error.name === 'AbortError' ? 'turn timeout' : error.message };
  } finally {
    clearTimeout(timeout);
  }
}

async function runLive({ base, token, userId, tasks, verbose = true, delayMs = 0 }) {
  const results = [];
  for (const task of tasks) {
    if (delayMs > 0 && results.length) await new Promise(resolve => setTimeout(resolve, delayMs));
    const reply = await postChat(base, token, task, userId);
    const classification = reply.error || reply.httpStatus
      ? { status: 'http_error', receipts: [], error: reply.error || `HTTP ${reply.httpStatus}` }
      : classify(task, reply);
    const result = { id: task.id, group: task.group, mode: task.mode, expectedAction: task.expectedAction, message: task.message, ...classification };
    results.push(result);
    if (verbose) console.log(JSON.stringify(result));
  }
  return results;
}

if (require.main === module) {
  const base = (process.env.OXY_MATRIX_API_URL || 'https://milgrain-live-2026.fly.dev').replace(/\/+$/, '');
  const token = process.env.OXY_MATRIX_SESSION_TOKEN;
  const userId = process.env.OXY_MATRIX_USER_ID;
  if (!token || !userId) {
    console.error('Set OXY_MATRIX_USER_ID and OXY_MATRIX_SESSION_TOKEN for a live run. Use --list to print the corpus.');
    process.exit(1);
  }
  const delayMs = Number(process.env.OXY_MATRIX_DELAY_MS || 0);
  const results = runLive({ base, token, userId, tasks: selectTasks(parseArgs()), delayMs });
  results.then(rows => {
    const counts = rows.reduce((out, row) => { out[row.status] = (out[row.status] || 0) + 1; return out; }, {});
    console.log(JSON.stringify({ total: rows.length, counts }, null, 2));
  }).catch(error => { console.error(error.stack || error.message); process.exit(1); });
}

module.exports = { TASKS, GROUPS, MODES, selectTasks, actionReceipt, classify, runLive };

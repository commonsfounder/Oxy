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
    risk: 'medium',
    required: ['title', 'due_date'],
    inputExample: { title: 'reminder', due_date: 'ISO date' },
    successSummary: 'Reminder created',
    failureSummary: 'Reminder failed',
    confirmation: 'none'
  },
  play_music: {
    risk: 'low',
    required: ['query'],
    inputExample: { query: 'search term' },
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
    successSummary: 'Music added',
    failureSummary: 'Music add failed',
    confirmation: 'none'
  },
  create_calendar_event: {
    risk: 'medium',
    required: ['title', 'start_date', 'end_date'],
    inputExample: { title: 'event', start_date: 'ISO date', end_date: 'ISO date' },
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
    confirmation: 'none'
  },
  book_uber: {
    risk: 'low',
    required: ['destination'],
    aliases: { destination: ['query', 'place', 'address'] },
    inputExample: { destination: 'natural place or address phrase' },
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
  order_uber_eats: {
    risk: 'high',
    required: ['query'],
    inputExample: { query: 'food or restaurant', restaurant: 'optional restaurant name', item: 'optional dish' },
    successSummary: 'Uber Eats opened',
    failureSummary: 'Uber Eats failed',
    confirmation: 'review_required',
    executionMode: 'review'
  },
  order_deliveroo: {
    risk: 'high',
    required: ['query'],
    inputExample: { query: 'food or restaurant', restaurant: 'optional restaurant name', item: 'optional dish' },
    successSummary: 'Deliveroo opened',
    failureSummary: 'Deliveroo failed',
    confirmation: 'review_required',
    executionMode: 'review'
  },
  search_netflix_title: {
    risk: 'low',
    required: ['title'],
    inputExample: { title: 'show or film title' },
    successSummary: 'Netflix searched',
    failureSummary: 'Netflix search failed',
    confirmation: 'none'
  },
  add_to_netflix_list: {
    risk: 'medium',
    required: ['title'],
    inputExample: { title: 'show or film title' },
    successSummary: 'Netflix opened',
    failureSummary: 'Netflix failed',
    confirmation: 'external_app'
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
  create_agent_task: {
    risk: 'medium',
    required: ['goal'],
    optional: ['autonomy', 'plan'],
    inputExample: { goal: 'the long term goal', autonomy: 'Active|High', plan: 'optional initial plan json' },
    successSummary: 'Task created for background execution',
    failureSummary: 'Task creation failed',
    confirmation: 'none'
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
  log_health: { risk: 'low', required: ['metric'], optional: ['value'], inputExample: { metric: 'steps|heart_rate', value: 'number or note' }, successSummary: 'Health logged', failureSummary: 'Log failed', confirmation: 'none' },
  control_smart_home: { risk: 'medium', required: ['device', 'command'], inputExample: { device: 'lights|thermostat', command: 'on|off|set 22' }, successSummary: 'Smart home updated', failureSummary: 'Control failed', confirmation: 'none' },
  save_to_notion: { risk: 'low', required: ['content'], inputExample: { content: 'note or task' }, successSummary: 'Saved to Notion', failureSummary: 'Save failed', confirmation: 'none' },
  github_action: { risk: 'low', required: ['repo', 'action'], inputExample: { repo: 'owner/repo', action: 'status|create_issue' }, successSummary: 'GitHub action done', failureSummary: 'GitHub failed', confirmation: 'none' },
  track_flight: { risk: 'low', required: ['flight'], inputExample: { flight: 'flight number or query' }, successSummary: 'Flight tracked', failureSummary: 'Track failed', confirmation: 'none' },
  edit_photo: { risk: 'low', required: ['brief'], inputExample: { brief: 'enhance|crop|filter' }, successSummary: 'Photo edit ready', failureSummary: 'Edit failed', confirmation: 'none' },
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
    risk: 'medium',
    required: ['amount', 'description'],
    optional: ['source'],
    inputExample: { amount: 50, description: 'payment for freelance gig', source: 'client' },
    successSummary: 'Received to account',
    failureSummary: 'Receive failed',
    confirmation: 'none'
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
  check_monzo_balance: { risk: 'low', required: [], inputExample: {}, successSummary: 'Monzo balance', failureSummary: 'Failed', confirmation: 'none' },
  stripe_charge: { risk: 'high', required: ['amount'], inputExample: { amount: 1000, description: 'payment' }, successSummary: 'Charged via Stripe', failureSummary: 'Failed', confirmation: 'review' },
  get_weather: { risk: 'low', required: ['city'], inputExample: { city: 'London' }, successSummary: 'Weather', failureSummary: 'Failed', confirmation: 'none' },
  search_amazon: { risk: 'low', required: ['query'], inputExample: { query: 'headphones' }, successSummary: 'Amazon search', failureSummary: 'Failed', confirmation: 'none' },
  send_slack_message: { risk: 'medium', required: ['channel', 'message'], inputExample: { channel: '#general', message: 'hi' }, successSummary: 'Slack sent', failureSummary: 'Failed', confirmation: 'none' },
  book_lyft: { risk: 'low', required: ['destination'], inputExample: { destination: 'airport' }, successSummary: 'Lyft opened', failureSummary: 'Failed', confirmation: 'none' },
  get_strava_activities: { risk: 'low', required: [], inputExample: {}, successSummary: 'Strava activities', failureSummary: 'Failed', confirmation: 'none' },
  search_eventbrite: { risk: 'low', required: ['query'], inputExample: { query: 'concert' }, successSummary: 'Events found', failureSummary: 'Failed', confirmation: 'none' },
  search_flights: { risk: 'low', required: ['from', 'to'], inputExample: { from: 'LHR', to: 'JFK' }, successSummary: 'Flights found', failureSummary: 'Failed', confirmation: 'none' },
  search_hotels: { risk: 'low', required: ['location'], inputExample: { location: 'Paris' }, successSummary: 'Hotels found', failureSummary: 'Failed', confirmation: 'none' },
  get_stock_price: { risk: 'low', required: ['symbol'], inputExample: { symbol: 'AAPL' }, successSummary: 'Stock price', failureSummary: 'Failed', confirmation: 'none' }
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

function actionToFunctionDeclaration(type, contract) {
  const properties = {};
  const inputEx = contract.inputExample || {};
  const required = new Set(contract.required || []);
  const optional = new Set(contract.optional || []);
  const allParams = new Set([...Object.keys(inputEx), ...required, ...optional]);

  for (const key of allParams) {
    const isRequired = required.has(key);
    properties[key] = {
      type: 'string',
      description: `${key}${isRequired ? ' (required)' : ' (optional)'}`
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
  normalizeActionInput,
  validateActionWithContract,
  buildActionRecovery,
  applyActionContractResultMetadata,
  actionPromptBlock,
  buildFunctionDeclarations,
  buildToolsForGemini,
  actionToFunctionDeclaration
};

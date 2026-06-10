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
    guidance: 'Use for "play X" / "listen to X". Pass the resolved exact song title and artist as query. If the request depends on current facts, charts, rankings, popularity, or "right now", resolve the exact track via search FIRST — never pass vague queries like "most popular song" or "top song". If there is no specific song and no safe way to ground one, ask what they want to hear instead of inventing a track (e.g. "play some music" is not a request to play a song called "Some").',
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
    guidance: 'Use for "calendar", "schedule", "event", or "add to my calendar". Do not route to Apple Music just because the phrase contains the word "add". If the date or time is missing, ask for it instead of guessing.',
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
    guidance: 'Pass the user\'s natural phrase as query ("nearest gym", "coffee near me", "closest McDonald\'s"). Do not ask for a full address or a specific branch — device location resolves it.',
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
  order_uber_eats: {
    risk: 'high',
    required: ['query'],
    inputExample: { query: 'food or restaurant', restaurant: 'optional restaurant name', item: 'optional dish' },
    successSummary: 'Uber Eats opened',
    failureSummary: 'Uber Eats failed',
    confirmation: 'review_required',
    executionMode: 'review'
  },
  // Conversational Uber Eats ordering backed by the @striderlabs/mcp-ubereats
  // MCP server (real session, cart, and checkout). Drive the order as a
  // back-and-forth, one unknown at a time — never slot-dump. IDs flow between
  // tools: ubereats_search returns restaurants with ids; carry the chosen
  // restaurantId into ubereats_get_restaurant and ubereats_add_to_cart.
  ubereats_status: {
    risk: 'low',
    required: [],
    inputExample: {},
    guidance: 'Entry point when the user wants to order food. Checks the Uber Eats session. If not logged in, the result includes a login URL — surface it and STOP until the user confirms they are signed in, then resume from where you paused. Drive ordering as a back-and-forth: resolve one unknown at a time (cuisine, dish, or restaurant). If the request is vague ("order me food", "get me something"), ask one short question about what they are feeling before searching.',
    successSummary: 'Uber Eats session checked',
    failureSummary: 'Uber Eats unavailable',
    confirmation: 'none'
  },
  ubereats_set_address: {
    risk: 'low',
    required: ['address'],
    inputExample: { address: 'delivery address; default to the user home or current location' },
    guidance: 'Set the delivery address. Auto-populate from the user home or current location in memory/context — never ask for an address unless location is genuinely unavailable.',
    successSummary: 'Delivery address set',
    failureSummary: 'Address step failed',
    confirmation: 'none'
  },
  ubereats_search: {
    risk: 'low',
    required: ['query'],
    optional: ['cuisine'],
    aliases: { query: ['dish', 'food'] },
    inputExample: { query: 'dish or restaurant name', cuisine: 'optional cuisine e.g. thai, pizza' },
    guidance: 'Search once you know what they want. If the user named a specific dish, search for it — do not ask what they want. Only ask one short question when the request is genuinely vague — never several at once. Resolve "that place" / "the same one" / "something from there" from recent conversation context. The result lists restaurants with ids — remember the id of the one the user picks; you need it for the next steps.',
    successSummary: 'Restaurants found',
    failureSummary: 'Uber Eats search failed',
    confirmation: 'none'
  },
  ubereats_get_restaurant: {
    risk: 'low',
    required: ['restaurantId'],
    aliases: { restaurantId: ['restaurant', 'id'] },
    inputExample: { restaurantId: 'id from a ubereats_search result' },
    guidance: 'Fetch a restaurant menu using the restaurantId from search results — not the name. Surface the relevant menu sections instead of dumping the whole menu; ask what they are in the mood for if needed. If the restaurant has no menu, say so and offer to search for alternatives.',
    successSummary: 'Menu loaded',
    failureSummary: 'Menu load failed',
    confirmation: 'none'
  },
  ubereats_add_to_cart: {
    risk: 'medium',
    required: ['restaurantId', 'itemName'],
    optional: ['quantity', 'specialInstructions'],
    aliases: { itemName: ['item', 'dish'], restaurantId: ['restaurant'] },
    inputExample: { restaurantId: 'id from search', itemName: 'exact menu item name', quantity: 1, specialInstructions: 'optional notes' },
    guidance: 'DIETARY CHECK: only if THIS user has dietary restrictions or allergies on file (in their memory/profile — e.g. vegetarian, halal, nut allergy), check the item name and description against them and flag a likely conflict before adding ("heads up, that looks like it has X — still want it?"). Do not invent restrictions or impose defaults — if the user has none on file, just add the item. Pass the exact menu item name and the restaurantId. After adding, ask "anything else?" once — do not repeat it. "Add the usual" — check memory for known orders from that restaurant, else ask what they normally get.',
    successSummary: 'Item added',
    failureSummary: 'Add to cart failed',
    confirmation: 'none'
  },
  ubereats_view_cart: {
    risk: 'low',
    required: [],
    inputExample: {},
    guidance: 'Show the current cart and total. ALWAYS call this before ubereats_checkout so the user sees the real total. If this user has dietary restrictions on file, scan the cart and flag anything that conflicts and slipped through earlier — otherwise skip that. Present it short and natural — "[Item], [Item] — £X total. Want me to place it?" — not a formatted receipt.',
    successSummary: 'Cart ready',
    failureSummary: 'Cart view failed',
    confirmation: 'none'
  },
  ubereats_clear_cart: {
    risk: 'low',
    required: [],
    inputExample: {},
    guidance: 'Empty the cart when the user wants to start over.',
    successSummary: 'Cart cleared',
    failureSummary: 'Clear cart failed',
    confirmation: 'none'
  },
  ubereats_checkout: {
    risk: 'high',
    required: [],
    optional: ['confirm'],
    inputExample: { confirm: false },
    guidance: 'REAL MONEY — places a live Uber Eats order. Call ubereats_view_cart first so the user sees the final total. This action is review-gated: it only executes after the user gives an unambiguous green light ("yes", "place it", "go ahead"). Never imply the order is placed until the result confirms it. If checkout fails, report the actual error — do not paraphrase it as "couldn\'t place the order" with no detail.',
    successSummary: 'Order placed',
    failureSummary: 'Checkout failed',
    confirmation: 'review_required',
    executionMode: 'review'
  },
  ubereats_track_order: {
    risk: 'low',
    required: ['orderId'],
    aliases: { orderId: ['order', 'id'] },
    inputExample: { orderId: 'id from the placed order' },
    guidance: 'After an order is placed, offer to track it; call this with the orderId from the checkout result when the user asks where their food is.',
    successSummary: 'Order status checked',
    failureSummary: 'Order tracking failed',
    confirmation: 'none'
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

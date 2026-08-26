const LOCAL_PLACE_TERMS = /\b(nearest|closest|near me|nearby|around me|coffee|cafe|restaurant|gym|mcdonald'?s|john lewis|supermarket|shop|store|pharmacy|station|cinema|bank|atm|hospital|hotel)\b/i;
const RIDE_TERMS = /\b(uber|ride|taxi|cab|car|take me|pick me up|drive me)\b/i;
const DIRECTIONS_TERMS = /\b(directions|navigate|route|walk|walking|drive|driving|how do i get|when should i leave|latest.*leave|get there by|be there by|bus|buses|public transport|transit|what bus|which bus|what train|which train|train can i take|train to|first train|next train|need to be at|heading to)\b/i;
const TRANSIT_TERMS = /\b(bus|buses|public transport|transit|what bus|which bus|train|trains|rail|tube|tram)\b/i;
const RAIL_TRIP_TERMS = /\b(what train|which train|train can i take|train to|trains to|first train|rail|heading to|travelling to|traveling to)\b/i;
const LIVE_RAIL_TERMS = /\b(live departures?|departures?|arrival board|station board|platforms?|what platform|next train|first train)\b/i;
const FUTURE_TIME_TERMS = /\b(tomorrow|later|around|about|by|at|after|before|\d{1,2}(?::\d{2})?\s*(am|pm)?)\b/i;
const CAPABILITY_SWEEP_TRIGGER = /\b(?:run|use)\s+(?:the\s+)?capability[_\s-]?sweep\b|\b(?:run|do)\s+(?:the\s+)?(?:whole|full|safe)\s+(?:capability\s+)?sweep\b|\bdo\s+all(?:\s+of)?\s+that\b|\bcheck\s+everything\b|\bfull\s+capability\s+batch\b/i;
const CAPABILITY_SWEEP_INPUT_KEYS = [
  'weather_city', 'place_query', 'directions_destination', 'directions_origin',
  'train_origin', 'train_destination', 'train_date', 'flight_from', 'flight_to',
  'flight_depart_date', 'flight_return_date', 'hotel_location', 'hotel_check_in',
  'hotel_check_out', 'stock_symbol', 'amazon_query', 'itinerary_destination',
  'itinerary_start_date', 'itinerary_duration_days', 'google_docs_query', 'github_repo'
];

function normalizeText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function parseCapabilitySweepInputs(message) {
  const text = String(message || '');
  const inputs = {};
  for (const key of CAPABILITY_SWEEP_INPUT_KEYS) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`\\b${escapedKey}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^;\\n]+?))\\s*(?=;|$)`, 'i'));
    const value = match?.[1] || match?.[2] || match?.[3];
    if (value?.trim()) inputs[key] = value.trim();
  }
  return inputs;
}

function inferCapabilitySweepAction(message) {
  const text = normalizeText(message);
  if (!CAPABILITY_SWEEP_TRIGGER.test(text)) return null;
  return {
    reason: 'capability_sweep',
    spoken: "I'll run the read-only capability sweep.",
    actions: [{ type: 'capability_sweep', input: parseCapabilitySweepInputs(text) }]
  };
}

function isQuestionOnly(text) {
  return /^(what|who|when|why|explain)\b/i.test(text) &&
    !/\b(nearest|closest|near me|nearby|around me)\b/i.test(text);
}

function looksLikeLocalPlaceRequest(message) {
  const text = normalizeText(message);
  if (!text || isQuestionOnly(text)) return false;
  return LOCAL_PLACE_TERMS.test(text);
}

// Retailer names double as LOCAL_PLACE_TERMS ("john lewis"), so "get me pyjamas ON john
// lewis" wrongly matched a place lookup. A request to BUY/GET a product — especially
// "<product> on/from/at <retailer>" — is an online-shopping task (→ browser task), never a
// request to locate a nearby branch. High precision on purpose: "nearest john lewis" has no
// purchase verb and no on/from/at source, so it stays a place request.
const { allRetailerAliases } = require('./services/retailer-sites');

const SHOPPING_VERB = /\b(buy|purchase|shop for|add\s+.*\bto\s+(?:my\s+)?(?:basket|cart|bag))\b/i;
const BROWSER_SIGNUP_VERB = /\b(?:sign\s+(?:me\s+)?up|register|create\s+(?:an?\s+)?account|open\s+(?:an?\s+)?account|join|subscribe)\b/i;
const BROWSER_SIGNUP_TARGET = /\b(?:website|site|online|newsletter|account|retailer|membership|service|subscription)\b/i;
const LOCAL_BRANCH_QUERY = /\b(?:near(?:\s+me|by)?|nearest|closest|branch(?:es)?|store\s+location|opening\s+hours|where\s+is)\b/i;

function retailerMentioned(text) {
  const norm = normalizeText(text).toLowerCase();
  for (const alias of allRetailerAliases()) {
    const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'i');
    // "Next" is a real retailer but also ordinary language. Require an explicit retailer
    // connector for that alias so "next train" and "next week" never become shopping.
    if (re.test(norm) && (alias !== 'next' || new RegExp(`\\b(?:on|from|at|using)\\s+${alias}\\b`, 'i').test(norm))) return true;
  }
  return false;
}

function looksLikeShoppingRequest(message) {
  const text = normalizeText(message);
  if (!text) return false;
  if (SHOPPING_VERB.test(text)) return true;
  // A location question mentioning a retailer is still a place lookup. Only let the
  // generic acquire verbs below become browser work when the sentence is not asking for
  // a nearby branch or store details.
  if (LOCAL_BRANCH_QUERY.test(text)) return false;
  // "get/grab/find/order me <product> on/from/at <retailer>" — the acquire lead + a named
  // retailer source together mean shopping, not navigation.
  if (/\b(get|grab|find|order|want|need)\b/i.test(text) && retailerMentioned(text)) return true;
  if (/\b(?:on|from|at|using)\s+/i.test(text) && retailerMentioned(text)) return true;
  return false;
}

function inferBrowserShoppingAction(message) {
  const text = normalizeText(message);
  // A named retailer gives the browser a concrete target. Generic "what should I buy?"
  // recommendations remain grounded-search questions and must stay on the model path.
  if (!text || !looksLikeShoppingRequest(text) || !retailerMentioned(text)) return null;
  return {
    reason: 'browser_shopping',
    spoken: "I'll open the retailer and take this as far as I can.",
    actions: [{ type: 'run_browser_task', input: { goal: text } }]
  };
}

// Account/newsletter requests are browser work, not a web search or nearby-place lookup.
// Keep this narrow: an explicit signup verb plus a website/account target is enough to
// start the real browser flow, which will stop for email/password/confirmation rather
// than silently submitting user data.
function inferBrowserSignupAction(message) {
  const text = normalizeText(message);
  if (!text || !BROWSER_SIGNUP_VERB.test(text) || !BROWSER_SIGNUP_TARGET.test(text)) return null;
  return {
    reason: 'browser_signup',
    spoken: "I'll open the website and take this as far as I can.",
    actions: [{ type: 'run_browser_task', input: { goal: text } }]
  };
}

function looksLikeRideRequest(message) {
  return RIDE_TERMS.test(normalizeText(message));
}

// "Restaurant"/"gym"/"hotel" etc. sit in LOCAL_PLACE_TERMS, so any sentence that merely
// mentions one — including a plain request to email/text/contact them about something —
// used to fall through to the find_local_place fallback and get routed as a nearby-place
// search before the model ever saw it. A literal email address, or an explicit
// email/text/message/contact verb, means this is a communication request, not "find me a
// place" — narrow and high-precision on purpose, same shape as looksLikeShoppingRequest
// immediately below.
const COMMUNICATION_TERMS = /\b(email|e-mail|text|message|contact|write to)\b/i;
const EMAIL_ADDRESS_RE = /[^\s<]+@[^\s>]+\.[^\s>]+/;

function looksLikeCommunicationRequest(message) {
  const text = normalizeText(message);
  if (!text) return false;
  return EMAIL_ADDRESS_RE.test(text) || COMMUNICATION_TERMS.test(text);
}

// Same collision, different shape: a named retailer ("john lewis") sits in LOCAL_PLACE_TERMS,
// so a message about resuming an existing browser shopping session and checking the basket —
// live regression via the Telegram bridge, 2026-08-26 — fell through to find_local_place and
// got routed as a nearby-place search, with the whole sentence echoed back as a broken query.
// Narrow and high-precision on purpose, same shape as looksLikeCommunicationRequest above:
// only an explicit session/basket/cart phrase defers, so "nearest john lewis" is unaffected.
const BROWSER_SESSION_TERMS = /\b(?:that|this|the) session\b|\bsession back\b|\bwhat'?s in (?:the|my) (?:basket|cart|bag)\b/i;

function looksLikeBrowserSessionRequest(message) {
  return BROWSER_SESSION_TERMS.test(normalizeText(message));
}

function trimTrailingPunctuation(value) {
  return normalizeText(value).replace(/[?.!]+$/, '').trim();
}

function inferPersonalAdminAction(message) {
  const text = normalizeText(message);
  if (!text) return null;

  if (/\bresponsibilit(?:y|ies)\b/i.test(text) &&
      /\b(show|list|what|which|active|current)\b/i.test(text)) {
    return {
      reason: 'list_responsibilities',
      spoken: "I'll check what I'm handling.",
      actions: [{ type: 'list_responsibilities', input: {} }]
    };
  }

  const personMatch = text.match(/^(?:what do you remember about|what do you know about|who is)\s+(.+?)[?.!]*$/i);
  if (personMatch?.[1]) {
    return {
      reason: 'find_people',
      spoken: `I'll look up ${trimTrailingPunctuation(personMatch[1])}.`,
      actions: [{ type: 'find_people', input: { query: trimTrailingPunctuation(personMatch[1]) } }]
    };
  }

  const receiptMatch = text.match(/^(?:find|search(?:\s+for)?|look\s+for)\s+(?:the\s+)?email\s+(?:with|containing|about)\s+(.+?)[?.!]*$/i);
  if (receiptMatch?.[1]) {
    return {
      reason: 'search_emails',
      spoken: "I'll search your email.",
      actions: [{ type: 'search_emails', input: { query: trimTrailingPunctuation(receiptMatch[1]), max_results: 10 } }]
    };
  }

  return null;
}

function inferOutboundCommunicationAction(message) {
  const text = normalizeText(message);
  if (!text) return null;

  const telegram = text.match(/^(?:please\s+)?send\s+(.+?)\s+a\s+telegram\s+message\s+(?:saying|that)\s+(.+)$/i);
  if (telegram) {
    return {
      reason: 'send_telegram',
      spoken: 'I’ll prepare that message for review.',
      actions: [{ type: 'send_telegram', input: { contact: trimTrailingPunctuation(telegram[1]), message: telegram[2].trim() } }]
    };
  }

  const slack = text.match(/^(?:please\s+)?send\s+(#[\w-]+)\s+a\s+slack\s+message\s+(?:saying|that)\s+(.+)$/i);
  if (slack) {
    return {
      reason: 'send_slack_message',
      spoken: 'I’ll prepare that message for review.',
      actions: [{ type: 'send_slack_message', input: { channel: slack[1], message: slack[2].trim() } }]
    };
  }

  const call = text.match(/^(?:please\s+)?call\s+(.+?)(?:\s+and\s+(?:ask|find out|see if)\s+.+)?[?.!]*$/i);
  if (call && /\b(call|ring)\b/i.test(text)) {
    return {
      reason: 'make_call',
      spoken: 'I’ll prepare that call for review.',
      actions: [{ type: 'make_call', input: { contact: trimTrailingPunctuation(call[1]) } }]
    };
  }

  const email = text.match(/^(?:please\s+)?(?:send\s+an?\s+)?e-?mail\s+(?:to\s+)?(.+?)\s+(?:and\s+)?(?:ask(?:ing)?|saying|that)\s+(.+)$/i);
  if (email) {
    const recipient = trimTrailingPunctuation(email[1]);
    const type = /\b(restaurant|courier|company|vendor|support|hotel|airline|delivery|shop|store)\b/i.test(recipient)
      ? 'send_millie_email'
      : 'send_email';
    return {
      reason: type,
      spoken: 'I’ll prepare that message for review.',
      actions: [{ type, input: { to: recipient, body: email[2].trim() } }]
    };
  }

  const messageMatch = text.match(/^(?:please\s+)?(?:text|message)\s+(.+?)\s+(?:that|saying|and\s+ask)\s+(.+)$/i);
  if (messageMatch) {
    const contact = trimTrailingPunctuation(messageMatch[1]);
    const type = /\b(restaurant|courier|company|vendor|support|hotel|airline|delivery|shop|store)\b/i.test(contact)
      ? 'send_millie_sms'
      : 'send_message';
    return {
      reason: type,
      spoken: 'I’ll prepare that message for review.',
      actions: [{ type, input: type === 'send_message'
        ? { contact, message: messageMatch[2].trim() }
        : { to: contact, body: messageMatch[2].trim() } }]
    };
  }

  return null;
}

function looksLikeDirectionsRequest(message) {
  return DIRECTIONS_TERMS.test(normalizeText(message));
}

// True only when a phrase names an actual place — i.e. something survives after stripping
// the directions/navigation trigger words and generic filler. "Get directions" -> false;
// "directions to the gym" -> "the gym" -> true.
function hasRealDestination(phrase) {
  const residue = normalizeText(phrase)
    .replace(new RegExp(DIRECTIONS_TERMS.source, 'gi'), ' ')
    .replace(/\b(get|show|give|find|open|take|me|my|please|pls|a|an|the|to|for|some|now|here)\b/gi, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim();
  return residue.length > 0;
}

function looksLikeMemoryWrite(message) {
  const text = normalizeText(message);
  return /^(remember|save|note down)\b/i.test(text) ||
    /\bmy\s+(usual|preferred|default)\s+\w+\s+(is|are)\b/i.test(text) ||
    /^(my|our)\s+[^?.!]{2,80}\s+(is|are)\s+[^?.!]{2,120}$/i.test(text);
}

const WATCH_VERBS = /\b(watch|monitor|track|follow|keep an eye on)\b/i;
const WATCH_TARGETS = /\b(flight|flights|fare|fares|ticket|tickets|hotel|hotels|price|prices|cost|costs|sale|cheaper|lower|drops?|falls?)\b/i;

function stripWakeWord(text) {
  return normalizeText(text)
    .replace(/^(?:hey|okay|ok)?\s*millie(?:\s*[:,;-]\s*|\s+)/i, '')
    .replace(/^(?:okay|ok|please|pls)\s+/i, '')
    .trim();
}

function looksLikeWatchRequest(message) {
  const text = stripWakeWord(message);
  const repeats = /\bcheck\b.+\b(every|each|daily|weekly|when|if|until)\b/i.test(text);
  if (!text || !(WATCH_VERBS.test(text) || repeats) || !WATCH_TARGETS.test(text)) return false;
  // "Track my order" and similar status requests belong to the live task path.
  // A durable watch needs a price, availability, or future-change signal.
  return /\b(cheaper|lower|price|prices|cost|costs|sale|when|if|until|every|daily|weekly|available|drops?|falls?)\b/i.test(text);
}

function extractWatchCadence(text) {
  const normalized = text.toLowerCase();
  const match = normalized.match(/\b(?:every|each)\s+(\d+)?\s*(minute|hour|day|week)s?\b/) ||
    normalized.match(/\b(daily|weekly|hourly)\b/);
  if (!match) return { intervalMinutes: 1440, label: 'once a day' };

  if (match[1] === 'daily') return { intervalMinutes: 1440, label: 'once a day' };
  if (match[1] === 'weekly') return { intervalMinutes: 10080, label: 'once a week' };
  if (match[1] === 'hourly') return { intervalMinutes: 60, label: 'once an hour' };

  const amount = Number(match[1] || 1);
  const unit = match[2];
  const multiplier = unit === 'minute' ? 1 : unit === 'hour' ? 60 : unit === 'day' ? 1440 : 10080;
  const intervalMinutes = amount * multiplier;
  const label = unit === 'minute' && amount === 1 ? 'once a minute'
    : unit === 'hour' && amount === 1 ? 'once an hour'
      : unit === 'day' && amount === 1 ? 'once a day'
        : unit === 'week' && amount === 1 ? 'once a week'
          : `every ${amount} ${unit}s`;
  return { intervalMinutes, label };
}

function buildWatchRequest(message) {
  const text = stripWakeWord(message).replace(/[?.!]+$/, '').trim();
  const cadence = extractWatchCadence(text);
  const conditionMatch = text.match(/\b(?:when|if|until)\s+(.+)$/i);
  const condition = conditionMatch ? conditionMatch[1].trim() : null;
  const title = text
    .replace(/^(?:watch|monitor|track|follow|keep an eye on|check)\s+(?:for\s+)?/i, '')
    .replace(/\s+(?:when|if|until)\s+.+$/i, '')
    .replace(/\s+(?:and\s+)?(?:tell|let)\s+me\s*$/i, '')
    .replace(/\s+(?:every|each)\s+(?:\d+\s+)?(?:minute|hour|day|week)s?$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const instruction = text;
  return {
    title: title || 'Price watch',
    instruction,
    condition,
    recurrence: 'poll',
    interval_minutes: cadence.intervalMinutes,
    cadenceLabel: cadence.label
  };
}

function looksLikeWatchCancellation(message) {
  const text = stripWakeWord(message);
  return /\b(stop|cancel|pause|disable|turn off)\b/i.test(text) &&
    WATCH_TARGETS.test(text) &&
    /\b(watch|monitor|track|follow|checking|watching)\b/i.test(text);
}

function buildWatchCancellation(message) {
  const title = stripWakeWord(message)
    .replace(/^(?:stop|cancel|pause|disable|turn off)\s+(?:watching|monitoring|tracking|following|the\s+watch\s+for|the\s+watch)\s*/i, '')
    .replace(/^(?:watch|monitor|track|follow)\s+/i, '')
    .replace(/\s+(?:watch|monitor|tracking|monitoring)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return title || 'that watch';
}

function looksLikeContextualPlaceFollowup(message) {
  const text = normalizeText(message);
  return /\b(that|it|this|one|there)\b/i.test(text) &&
    /\b(closest|nearest|definitely|sure|same|open|maps|uber|there)\b/i.test(text) &&
    !/\b(mcdonald'?s|john lewis|coffee|cafe|restaurant|gym|supermarket|shop|store|pharmacy|station|cinema|bank|atm|hospital|hotel)\b/i.test(text);
}

function looksLikeContextualTravelFollowup(message) {
  const text = normalizeText(message);
  return /\b(that|it|this|there|the route|the train)\b/i.test(text) &&
    /\b(train|direct|changes?|platform|leave|arrive|get there|what time|which one|what is it|what train)\b/i.test(text) &&
    !extractFromTo(text) &&
    !extractHeadingDestination(text);
}

function cleanDestinationPhrase(message) {
  const text = normalizeText(message)
    .replace(/^(okay|ok|right|cool|great|can you|could you|please|pls)\s+/i, '')
    // Ordinary question-opener phrasing ("is there a gym...", "are there any decent
    // gyms...", "do you know if there's a coffee shop...") — see the matching strip in
    // geocoding.js's cleanPlaceSearchQuery for why this matters downstream.
    .replace(/^(?:is|are)\s+there\s+(?:a|an|any|anywhere)?\b\s*/i, '')
    .replace(/^do\s+you\s+know\s+if\s+there'?s?\s+(?:a|an|any)?\b\s*/i, '')
    .replace(/^(tell me|show me|let me know|can you find)\s+(where\s+)?/i, '')
    .replace(/^(can you\s+)?(tell|show)\s+me\s+(where\s+)?/i, '')
    .replace(/^(what|which)\s+(bus|buses|public transport|transit)\s+(can|should|do|could)\s+i\s+(take|get)\s+(to)?\s*/i, '')
    .replace(/^(what|which)\s+train\s+(can|should|do|could)\s+i\s+(take|get)\s+(to)?\s*/i, '')
    .replace(/^(when'?s\s+)?(the\s+)?(first|earliest|next)\s+train\s+(to|for)\s+/i, '')
    .replace(/^(train|trains)\s+(to|for)\s+/i, '')
    .replace(/^what\s+about\s+(to)?\s*/i, '')
    .replace(/^heading\s+to\s+/i, '')
    .replace(/^how\s+do\s+i\s+get\s+to\s+/i, '')
    .replace(/^how\s+can\s+i\s+get\s+to\s+/i, '')
    .replace(/^where\s+(is|are)\s+/i, '')
    .replace(/^(what|which)\s+(is\s+)?/i, '')
    .replace(/^i\s+need\s+to\s+be\s+at\s+/i, '')
    .replace(/^i\s+need\s+to\s+get\s+to\s+/i, '')
    .replace(/^where\s+the\s+/i, 'the ')
    .replace(/\b(this|that)\s+(?=\w)/gi, '')
    .replace(/\bnext\s+(nearest|closest)\b/i, '$1')
    .replace(/\b(book|get|order|call|send|open)\s+(me\s+)?(an?\s+)?(uber|ride|taxi|cab|car)\s+(to|for)?\b/i, ' ')
    .replace(/\b(take|drive)\s+me\s+(to)?\b/i, ' ')
    .replace(/\b(show|find|search for|look for|open)\s+(me\s+)?\b/i, ' ')
    .replace(/\b(in|on)\s+(apple\s+)?maps\b/i, ' ')
    .replace(/\bis\s+(located|at)\b/i, ' ')
    .replace(/\s+by\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\s+.*$/i, ' ')
    .replace(/\s+(tomorrow|today)\s+(around|about|at|by)?\s*\d{1,2}(?::\d{2})?\s*(am|pm)?\b.*$/i, ' ')
    .replace(/\s+(around|about|at|by)\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\b.*$/i, ' ')
    .replace(/\s+(with\s+)?(no changes?|without changing|direct|fewest changes?)\b.*$/i, ' ')
    .replace(/\s+what\s+(bus|buses|public transport|transit)\s+.*$/i, ' ')
    .replace(/\s+(to|near|from)\s+me\s+(is|are)\??$/i, ' ')
    .replace(/\s+(is|are)\??$/i, '')
    .replace(/\bplease\b/gi, ' ')
    .replace(/\s+is$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[?.!]+$/g, '')
    .trim();
  return text || normalizeText(message);
}

const TIME = /(\d{1,2}(?:[:.\s]\d{2})?\s*(?:am|pm)?)/i;
// Arrival cues mean a deadline to BE somewhere — "at 9" here is when to ARRIVE.
const ARRIVAL_CUE = /\b(be (there|at)|need to be|needs? to be|meeting|appointment|arrive|arriving|get there|make it|for)\b/i;

function extractArrivalTime(message) {
  const text = String(message || '');
  const day = /\btomorrow\b/i.test(text) ? 'tomorrow ' : '';
  // "by X" is always an arrival deadline. "at/for X" only when an arrival cue is
  // present ("meeting at 9", "be there at 8", "make it for 8") — otherwise a bare
  // "at 9" is ambiguous and handled by departure detection below.
  const match = text.match(new RegExp(`\\bby\\s+${TIME.source}`, 'i')) ||
    (ARRIVAL_CUE.test(text) ? text.match(new RegExp(`\\b(?:at|for|by)\\s+${TIME.source}`, 'i')) : null);
  return match ? `${day}${match[1].trim()}`.trim() : undefined;
}

function extractDepartureTime(message) {
  const text = String(message || '');
  const day = /\btomorrow\b/i.test(text) ? 'tomorrow ' : '';
  if (/\b(first|earliest)\s+train\b/i.test(text) && /\btomorrow\b/i.test(text)) {
    return 'tomorrow 00:01';
  }
  // Only treat a time as a departure when the user explicitly states when they
  // LEAVE — never from a bare "at 9" / "9pm", which is usually an arrival deadline
  // (HARDCODED CORRECTNESS TRAP: a wrong departure_time = a missed train).
  const match = text.match(new RegExp(`\\b(?:leav(?:e|ing)|set(?:ting)?\\s+off|depart(?:ing)?|head(?:ing)?\\s+off)\\s+(?:at|around|about|after|by)?\\s*${TIME.source}`, 'i'));
  return match ? `${day}${match[1].trim()}`.trim() : undefined;
}

function extractTripPreference(message) {
  const text = String(message || '');
  if (/\b(direct|no changes?|without changing|fewest changes?)\b/i.test(text)) return 'fewest_changes';
  if (/\b(fastest|quickest|soonest|earliest|first train)\b/i.test(text)) return 'fastest';
  return 'balanced';
}

function extractFromTo(message) {
  const text = normalizeText(message);
  const match = text.match(/\bfrom\s+(.+?)\s+to\s+(.+?)(?:\s+(?:tomorrow|today|around|about|at|by|after|before)\b|[?.!]|$)/i);
  if (!match) return null;
  return {
    origin: cleanDestinationPhrase(match[1]),
    destination: cleanDestinationPhrase(match[2])
  };
}

function extractHeadingDestination(message) {
  const text = normalizeText(message);
  const match = text.match(/\bneed\s+to\s+be\s+at\s+(.+?)(?:\s+by\b|\s+(?:tomorrow|today|around|about|at|after|before)\b|[?.!]|$)/i) ||
    text.match(/\bneed\s+to\s+get\s+to\s+(.+?)(?:\s+by\b|\s+(?:tomorrow|today|around|about|at|after|before)\b|[?.!]|$)/i) ||
    text.match(/\b(?:get|go)\s+to\s+(.+?)(?:\s+by\b|\s+(?:tomorrow|today|around|about|at|after|before)\b|[?.!]|$)/i) ||
    text.match(/\b(?:heading|going|travelling|traveling)\s+to\s+(.+?)(?:[?.!]|$)/i) ||
    text.match(/\bto\s+(.+?)(?:\s+(?:tomorrow|today|around|about|at|by|after|before)\b|[?.!]|$)/i);
  if (!match) return null;
  return cleanDestinationPhrase(match[1]);
}

function cleanStationPhrase(value) {
  return normalizeText(value)
    .replace(/^(live\s+)?(departures?|arrival board|station board|platforms?|what platform)\s+(at|from|for)?\s*/i, '')
    .replace(/^next\s+train\s+from\s+/i, '')
    .replace(/^first\s+train\s+from\s+/i, '')
    .replace(/\s+(station board|departures?|platforms?)$/i, '')
    .replace(/\bplease\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferDeterministicAction(message, options = {}) {
  const text = normalizeText(message);
  const preferredMode = options?.settings?.preferredTransportMode;
  const defaultMode = ['driving', 'transit', 'walking'].includes(preferredMode) ? preferredMode : 'driving';

  const personalAdmin = inferPersonalAdminAction(text);
  if (personalAdmin) return personalAdmin;

  const outboundCommunication = inferOutboundCommunicationAction(text);
  if (outboundCommunication) return outboundCommunication;

  const browserSignup = inferBrowserSignupAction(text);
  if (browserSignup) return browserSignup;

  if (looksLikeMemoryWrite(text) || looksLikeContextualPlaceFollowup(text) || looksLikeContextualTravelFollowup(text)) return null;

  // find_appointment_options only ever talks to the sandbox provider (see
  // getAppointmentBookingService in api/index.js) — there is no real one yet. Routing
  // straight to it regardless, with no fallback on failure, used to turn every real
  // "book me a dentist appointment" into a scripted dead end before the model ever got a
  // turn. Only take this deterministic path when a provider is actually connected
  // (today: sandbox/test runs); otherwise fall through to the model, which has
  // run_browser_task available for a genuine online booking.
  if (options?.appointmentProviderConnected &&
      /\bappointment\b/i.test(text) && /\b(get|book|find|arrange|schedule|need|want|make)\b/i.test(text)) {
    return {
      reason: 'appointment_booking',
      spoken: "I'll look for a time that fits.",
      actions: [{ type: 'find_appointment_options', input: { request: text } }]
    };
  }

  if (/\b(train|trains|rail|platforms?|departures?|station board|arrival board)\b/i.test(text) &&
      !/\b(bus|buses|what bus|which bus|drive|driving|walk|walking)\b/i.test(text) &&
      (LIVE_RAIL_TERMS.test(text) || RAIL_TRIP_TERMS.test(text) || /\bfrom\b.+\bto\b/i.test(text))) {
    return null;
  }

  if (looksLikeRideRequest(text) && looksLikeLocalPlaceRequest(text)) {
    return {
      reason: 'ride_to_local_place',
      spoken: "I'll open that in Uber.",
      actions: [{ type: 'book_uber', input: { destination: cleanDestinationPhrase(text) } }]
    };
  }

  if (looksLikeWatchCancellation(text)) {
    const title = buildWatchCancellation(text);
    return {
      reason: 'stop_durable_watch',
      spoken: `I’ll stop watching ${title}.`,
      actions: [{ type: 'cancel_scheduled_task', input: { title } }]
    };
  }

  if (looksLikeWatchRequest(text)) {
    const watch = buildWatchRequest(text);
    return {
      reason: 'durable_price_watch',
      spoken: `I’ll check ${watch.title} ${watch.cadenceLabel} and tell you when I find a change.`,
      actions: [{
        type: 'create_scheduled_task',
        input: {
          title: watch.title,
          instruction: watch.instruction,
          condition: watch.condition,
          recurrence: watch.recurrence,
          interval_minutes: watch.interval_minutes
        }
      }]
    };
  }

  if (looksLikeDirectionsRequest(text)) {
    const fromTo = extractFromTo(text);
    const headingDestination = !fromTo ? extractHeadingDestination(text) : null;
    if (!fromTo && !headingDestination && /\b(yeah|yes|but|that|it|this|same|there|direct|changes?|tomorrow)\b/i.test(text)) {
      return null;
    }
    const destination = fromTo?.destination || headingDestination || cleanDestinationPhrase(text);
    // A bare directions command ("Get directions", "directions please" — e.g. the app's
    // starter suggestion chip) has no actual place: cleanDestinationPhrase just echoes the
    // command back. Never fabricate a destination out of the command itself — defer to the
    // LLM so it asks "where to?" instead of routing to a garbage location.
    if (!fromTo && !headingDestination && !hasRealDestination(destination)) {
      return null;
    }
    const input = {
      destination,
      mode: TRANSIT_TERMS.test(text) ? 'transit' : defaultMode
    };
    if (fromTo?.origin) input.origin = fromTo.origin;
    const arrivalTime = extractArrivalTime(text);
    if (arrivalTime) input.arrival_time = arrivalTime;
    const departureTime = !arrivalTime ? extractDepartureTime(text) : undefined;
    if (departureTime) input.departure_time = departureTime;
    if (RAIL_TRIP_TERMS.test(text) && !/\b(bus|buses|what bus|which bus|drive|driving|walk|walking)\b/i.test(text)) {
      return null;
    }
    return {
      reason: input.mode === 'transit' ? 'transit_directions_to_place' : 'directions_to_local_place',
      spoken: input.mode === 'transit' ? "I'll check the transit route." : "I'll check directions.",
      actions: [{ type: 'get_directions', input }]
    };
  }

  // Buying a product from a named retailer must reach the real browser task. Keep this after
  // ride and directions guards so "get me an Uber to John Lewis" and "directions to John
  // Lewis" still route to transport rather than opening a shopping session.
  const browserShopping = inferBrowserShoppingAction(text);
  if (browserShopping) return browserShopping;

  // Placed after ride & directions the same way looksLikeShoppingRequest is, so
  // "get me an uber to the restaurant" is unaffected — only the final place-lookup
  // fallback is guarded.
  if (looksLikeCommunicationRequest(text)) return null;

  if (looksLikeBrowserSessionRequest(text)) return null;

  if (!looksLikeLocalPlaceRequest(text)) return null;

  return {
    reason: 'find_local_place',
    spoken: "I'll find that nearby.",
    actions: [{ type: 'find_place', input: { query: cleanDestinationPhrase(text) } }]
  };
}

module.exports = {
  inferDeterministicAction,
  inferPersonalAdminAction,
  inferOutboundCommunicationAction,
  inferBrowserSignupAction,
  inferBrowserShoppingAction,
  inferCapabilitySweepAction,
  looksLikeLocalPlaceRequest,
  looksLikeDirectionsRequest,
  cleanDestinationPhrase,
  looksLikeWatchRequest,
  buildWatchRequest,
  looksLikeWatchCancellation,
  buildWatchCancellation
};

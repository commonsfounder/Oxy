const LOCAL_PLACE_TERMS = /\b(nearest|closest|near me|nearby|around me|coffee|cafe|restaurant|gym|mcdonald'?s|john lewis|supermarket|shop|store|pharmacy|station|cinema|bank|atm|hospital|hotel)\b/i;
const RIDE_TERMS = /\b(uber|ride|taxi|cab|car|take me|pick me up|drive me)\b/i;
const DIRECTIONS_TERMS = /\b(directions|navigate|route|walk|walking|drive|driving|how do i get|when should i leave|latest.*leave|get there by|be there by|bus|buses|public transport|transit|what bus|which bus|what train|which train|train can i take|train to|first train|next train|need to be at|heading to)\b/i;
const TRANSIT_TERMS = /\b(bus|buses|public transport|transit|what bus|which bus|train|trains|rail|tube|tram)\b/i;
const RAIL_TRIP_TERMS = /\b(what train|which train|train can i take|train to|trains to|first train|rail|heading to|travelling to|traveling to)\b/i;
const LIVE_RAIL_TERMS = /\b(live departures?|departures?|arrival board|station board|platforms?|what platform|next train|first train)\b/i;
const FUTURE_TIME_TERMS = /\b(tomorrow|later|around|about|by|at|after|before|\d{1,2}(?::\d{2})?\s*(am|pm)?)\b/i;

function normalizeText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
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
const SHOPPING_VERB = /\b(buy|purchase|shop for|add\s+.*\bto\s+(?:my\s+)?(?:basket|cart|bag))\b/i;
const RETAILER_SOURCE = /\b(?:on|from|at)\s+(john\s*lewis|asos|selfridges|marks\s*(?:and|&)\s*spencer|m&s|currys|nike|screwfix|wickes|toolstation|sainsbury'?s?|waitrose|amazon|argos|next|boots|zara|very|h&m|deliveroo|just\s*eat|uber\s*eats|dominos?)\b/i;

function looksLikeShoppingRequest(message) {
  const text = normalizeText(message);
  if (!text) return false;
  if (SHOPPING_VERB.test(text)) return true;
  // "get/grab/find/order me <product> on/from/at <retailer>" — the acquire lead + a named
  // retailer source together mean shopping, not navigation.
  if (/\b(get|grab|find|order|want|need)\b/i.test(text) && RETAILER_SOURCE.test(text)) return true;
  return false;
}

function looksLikeRideRequest(message) {
  return RIDE_TERMS.test(normalizeText(message));
}

function looksLikeDirectionsRequest(message) {
  return DIRECTIONS_TERMS.test(normalizeText(message));
}

function looksLikeMemoryWrite(message) {
  const text = normalizeText(message);
  return /^(remember|save|note down)\b/i.test(text) ||
    /\bmy\s+(usual|preferred|default)\s+\w+\s+(is|are)\b/i.test(text) ||
    /^(my|our)\s+[^?.!]{2,80}\s+(is|are)\s+[^?.!]{2,120}$/i.test(text);
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

  if (looksLikeMemoryWrite(text) || looksLikeContextualPlaceFollowup(text) || looksLikeContextualTravelFollowup(text)) return null;

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

  if (looksLikeDirectionsRequest(text)) {
    const fromTo = extractFromTo(text);
    const headingDestination = !fromTo ? extractHeadingDestination(text) : null;
    if (!fromTo && !headingDestination && /\b(yeah|yes|but|that|it|this|same|there|direct|changes?|tomorrow)\b/i.test(text)) {
      return null;
    }
    const input = {
      destination: fromTo?.destination || headingDestination || cleanDestinationPhrase(text),
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

  // Buying a product from a named retailer must NOT deterministically become a place lookup —
  // defer to the LLM/browser-task path. Placed after the ride & directions guards so
  // "order me an uber" / "directions to john lewis" still route correctly.
  if (looksLikeShoppingRequest(text)) return null;

  if (!looksLikeLocalPlaceRequest(text)) return null;

  return {
    reason: 'find_local_place',
    spoken: "I'll find that nearby.",
    actions: [{ type: 'find_place', input: { query: cleanDestinationPhrase(text) } }]
  };
}

module.exports = {
  inferDeterministicAction,
  looksLikeLocalPlaceRequest,
  looksLikeDirectionsRequest,
  cleanDestinationPhrase
};

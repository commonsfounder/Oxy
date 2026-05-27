const LOCAL_PLACE_TERMS = /\b(nearest|closest|near me|nearby|around me|coffee|cafe|restaurant|gym|mcdonald'?s|john lewis|supermarket|shop|store|pharmacy|station|cinema|bank|atm|hospital|hotel)\b/i;
const RIDE_TERMS = /\b(uber|ride|taxi|cab|car|take me|pick me up|drive me)\b/i;
const DIRECTIONS_TERMS = /\b(directions|navigate|route|walk|walking|drive|driving|how do i get|bus|buses|public transport|transit|what bus|which bus|what train|which train|train can i take|train to|first train|next train|need to be at|heading to)\b/i;
const TRANSIT_TERMS = /\b(bus|buses|public transport|transit|what bus|which bus|train|trains|rail|tube|tram)\b/i;
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

function looksLikeRideRequest(message) {
  return RIDE_TERMS.test(normalizeText(message));
}

function looksLikeDirectionsRequest(message) {
  return DIRECTIONS_TERMS.test(normalizeText(message));
}

function cleanDestinationPhrase(message) {
  const text = normalizeText(message)
    .replace(/^(okay|ok|right|cool|great|can you|could you|please|pls)\s+/i, '')
    .replace(/^(tell me|show me|let me know|can you find)\s+(where\s+)?/i, '')
    .replace(/^(can you\s+)?(tell|show)\s+me\s+(where\s+)?/i, '')
    .replace(/^(what|which)\s+(bus|buses|public transport|transit)\s+(can|should|do|could)\s+i\s+(take|get)\s+(to)?\s*/i, '')
    .replace(/^(what|which)\s+train\s+(can|should|do|could)\s+i\s+(take|get)\s+(to)?\s*/i, '')
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
    .replace(/\s+what\s+(bus|buses|public transport|transit)\s+.*$/i, ' ')
    .replace(/\s+(to|near|from)\s+me\s+(is|are)\??$/i, ' ')
    .replace(/\s+(is|are)\??$/i, '')
    .replace(/\bplease\b/gi, ' ')
    .replace(/\s+is$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text || normalizeText(message);
}

function extractArrivalTime(message) {
  const text = String(message || '');
  const day = /\btomorrow\b/i.test(text) ? 'tomorrow ' : '';
  const match = text.match(/\bby\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
  return match ? `${day}${match[1].trim()}`.trim() : undefined;
}

function extractDepartureTime(message) {
  const text = String(message || '');
  const day = /\btomorrow\b/i.test(text) ? 'tomorrow ' : '';
  if (/\b(first|earliest)\s+train\b/i.test(text) && /\btomorrow\b/i.test(text)) {
    return 'tomorrow 00:01';
  }
  const match = text.match(/\b(?:at|around|about|after)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i) ||
    text.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
  return match ? `${day}${match[1].trim()}`.trim() : undefined;
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

function inferLiveRailAction(message) {
  const text = normalizeText(message);
  if (!/\b(train|trains|rail|station|platform|departures?|arrival board|station board)\b/i.test(text)) return null;
  if (!LIVE_RAIL_TERMS.test(text)) return null;

  const fromTo = extractFromTo(text);
  if (fromTo?.origin && fromTo?.destination && !FUTURE_TIME_TERMS.test(text.replace(/\bnext train\b/i, ''))) {
    return {
      reason: 'live_train_between_stations',
      spoken: "I'll check live train departures.",
      actions: [{ type: 'search_trains', input: fromTo }]
    };
  }

  if (/\b(tomorrow|later|around|about|at|by|after|before)\b/i.test(text)) return null;

  const stationMatch = text.match(/\b(?:at|from)\s+(.+?)(?:[?.!]|$)/i);
  const station = cleanStationPhrase(stationMatch?.[1] || text);
  if (!station || /\b(to|towards)\b/i.test(station)) return null;
  return {
    reason: 'live_station_board',
    spoken: "I'll check the live station board.",
    actions: [{ type: 'station_board', input: { station } }]
  };
}

function inferDeterministicAction(message) {
  const text = normalizeText(message);

  const liveRail = inferLiveRailAction(text);
  if (liveRail) return liveRail;

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
    if (!fromTo && !headingDestination && /\b(yeah|yes|but|that|it|this|same|tomorrow)\b/i.test(text)) {
      return null;
    }
    const input = {
      destination: fromTo?.destination || headingDestination || cleanDestinationPhrase(text),
      mode: TRANSIT_TERMS.test(text) ? 'transit' : 'driving'
    };
    if (fromTo?.origin) input.origin = fromTo.origin;
    const arrivalTime = extractArrivalTime(text);
    if (arrivalTime) input.arrival_time = arrivalTime;
    const departureTime = !arrivalTime ? extractDepartureTime(text) : undefined;
    if (departureTime) input.departure_time = departureTime;
    return {
      reason: TRANSIT_TERMS.test(text) ? 'transit_directions_to_place' : 'directions_to_local_place',
      spoken: "I'll open directions.",
      actions: [{ type: 'get_directions', input }]
    };
  }

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

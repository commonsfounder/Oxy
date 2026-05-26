const LOCAL_PLACE_TERMS = /\b(nearest|closest|near me|nearby|around me|coffee|cafe|restaurant|gym|mcdonald'?s|john lewis|supermarket|shop|store|pharmacy|station|cinema|bank|atm|hospital|hotel)\b/i;
const RIDE_TERMS = /\b(uber|ride|taxi|cab|car|take me|pick me up|drive me)\b/i;
const DIRECTIONS_TERMS = /\b(directions|navigate|route|walk|walking|drive|driving|how do i get|bus|buses|public transport|transit|what bus|which bus|need to be at)\b/i;
const TRANSIT_TERMS = /\b(bus|buses|public transport|transit|what bus|which bus)\b/i;

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

function cleanDestinationPhrase(message) {
  const text = normalizeText(message)
    .replace(/^(okay|ok|right|cool|great|can you|could you|please|pls)\s+/i, '')
    .replace(/^(tell me|show me|let me know|can you find)\s+(where\s+)?/i, '')
    .replace(/^(can you\s+)?(tell|show)\s+me\s+(where\s+)?/i, '')
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
  const match = String(message || '').match(/\bby\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
  return match ? match[1].trim() : undefined;
}

function inferDeterministicAction(message) {
  const text = normalizeText(message);
  if (!looksLikeLocalPlaceRequest(text)) return null;

  if (looksLikeRideRequest(text)) {
    return {
      reason: 'ride_to_local_place',
      spoken: "I'll open that in Uber.",
      actions: [{ type: 'book_uber', input: { destination: cleanDestinationPhrase(text) } }]
    };
  }

  if (DIRECTIONS_TERMS.test(text)) {
    const input = {
      destination: cleanDestinationPhrase(text),
      mode: TRANSIT_TERMS.test(text) ? 'transit' : 'driving'
    };
    const arrivalTime = extractArrivalTime(text);
    if (arrivalTime) input.arrival_time = arrivalTime;
    return {
      reason: TRANSIT_TERMS.test(text) ? 'transit_directions_to_place' : 'directions_to_local_place',
      spoken: "I'll open directions.",
      actions: [{ type: 'get_directions', input }]
    };
  }

  return {
    reason: 'find_local_place',
    spoken: "I'll find that nearby.",
    actions: [{ type: 'find_place', input: { query: cleanDestinationPhrase(text) } }]
  };
}

module.exports = {
  inferDeterministicAction,
  looksLikeLocalPlaceRequest,
  cleanDestinationPhrase
};

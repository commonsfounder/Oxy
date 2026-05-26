const LOCAL_PLACE_TERMS = /\b(nearest|closest|near me|nearby|around me|coffee|cafe|restaurant|gym|mcdonald'?s|john lewis|supermarket|shop|store|pharmacy|station|cinema|bank|atm|hospital|hotel)\b/i;
const RIDE_TERMS = /\b(uber|ride|taxi|cab|car|take me|pick me up|drive me)\b/i;
const DIRECTIONS_TERMS = /\b(directions|navigate|route|walk|walking|drive|driving|how do i get)\b/i;

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
    .replace(/^(can you|could you|please|pls)\s+/i, '')
    .replace(/^(tell me|show me|let me know|can you find)\s+(where\s+)?/i, '')
    .replace(/^(can you\s+)?(tell|show)\s+me\s+(where\s+)?/i, '')
    .replace(/^where\s+(is|are)\s+/i, '')
    .replace(/^(what|which)\s+(is\s+)?/i, '')
    .replace(/^where\s+the\s+/i, 'the ')
    .replace(/\bnext\s+(nearest|closest)\b/i, '$1')
    .replace(/\b(book|get|order|call|send|open)\s+(me\s+)?(an?\s+)?(uber|ride|taxi|cab|car)\s+(to|for)?\b/i, ' ')
    .replace(/\b(take|drive)\s+me\s+(to)?\b/i, ' ')
    .replace(/\b(show|find|search for|look for|open)\s+(me\s+)?\b/i, ' ')
    .replace(/\b(in|on)\s+(apple\s+)?maps\b/i, ' ')
    .replace(/\bis\s+(located|at)\b/i, ' ')
    .replace(/\s+(to|near|from)\s+me\s+(is|are)\??$/i, ' ')
    .replace(/\s+(is|are)\??$/i, '')
    .replace(/\s+is$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text || normalizeText(message);
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

  return {
    reason: DIRECTIONS_TERMS.test(text) ? 'directions_to_local_place' : 'find_local_place',
    spoken: "I'll find that nearby.",
    actions: [{ type: 'find_place', input: { query: cleanDestinationPhrase(text) } }]
  };
}

module.exports = {
  inferDeterministicAction,
  looksLikeLocalPlaceRequest,
  cleanDestinationPhrase
};

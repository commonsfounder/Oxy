// Detect whether a message likely needs current/real-time information or other changeable facts.
const SEARCH_KEYWORD_PATTERNS = [
  { reason: 'current-events', pattern: /\b(news|headline|headlines|breaking|what happened|recent|latest|current|currently|today'?s?|tonight|yesterday|this week|this month|this year|trending|update on|updates on|live)\b/i },
  { reason: 'current-music-chart', pattern: /\b(billboard|hot\s*100|official singles chart|charts?|number\s*one|no\.?\s*1|top\s+(song|track|single)|most popular song|most streamed|viral song)\b|(?=.*\b(song|track|single|music)\b)(?=.*\b(right now|currently|today|latest|trending|most popular|top|number\s*one|no\.?\s*1)\b)/i },
  { reason: 'public-transport-live', pattern: /\b(next|first|last|live|departures?|platforms?)\s+(train|bus|tram|tube)\b|\b(what|which)\s+(train|bus|tram|tube|platform)\b|\bplatform\s*(number)?\??$|\b(train|bus|tram|tube)\s+from\b.+\bto\b/i },
  { reason: 'public-safety-events', pattern: /\b(assassination|assassinate|attempt(?:ed)?|shooting|shooter|gunman|armed|rally|campaign rally|security incident|suspect|arrested|charged|identified|names?|who did it|who was it)\b/i },
  { reason: 'time-sensitive', pattern: /\b(weather|forecast|temperature|rain|snow|traffic|delay|delays|schedule|schedules|arrival|departure|when does|when is|opening hours|closing time|wait time|wait times|availability)\b/i },
  { reason: 'market-data', pattern: /\b(stocks?|share price|price|pricing|market cap|valuation|earnings|revenue|exchange rate|exchange rates|interest rate|interest rates|how much is)\b/i },
  { reason: 'company-info', pattern: /\b(company|startup|firm|brand|business|corporation|corp\.?|inc\.?|plc|llc|ceo|founder|cofounder|chairman|chairwoman|board|layoffs?|funding|raised|acquired|acquisition|merger|launch(?:ed)?|release(?:d)?|product|app)\b/i },
  { reason: 'public-figure', pattern: /\b(president|prime minister|pm\b|mayor|governor|chancellor|minister|secretary|ceo|founder|captain|manager|head coach|coach|trump|biden|harris|vance)\b/i },
  { reason: 'explicit-search', pattern: /\b(search|look\s*it\s*up|look up|lookup|find out|google|check online|check it|re-?check|verify|online)\b/i },
  { reason: 'contextual-fact-check', pattern: /\b(is|was|are|were)\s+(that|this|it)\s+(right|correct|true|accurate)\b|\b(are you sure|source\??|prove it|check that)\b/i }
];

const CHANGEABLE_QUESTION_PATTERNS = [
  /\bwho is\b/i,
  /\bwhat is\b/i,
  /\bwhat's\b/i,
  /\bwho are\b/i,
  /\bwho was\b/i,
  /\bwho were\b/i,
  /\bwhat happened\b/i,
  /\bwhat are\b/i,
  /\bwhen is\b/i,
  /\bwhen does\b/i,
  /\bwhere is\b/i,
  /\bwhere are\b/i,
  /\bhow much is\b/i,
  /\bhow much are\b/i,
  /\bhow many\b/i,
  /\bdoes .* (still|currently|now)\b/i,
  /\bdid .* (recently|today|this week|this month|this year)\b/i,
  /\bis .* (open|closed|available|released|launching)\b/i,
  /\bare .* (open|closed|available)\b/i
];

const NON_SEARCH_PATTERNS = [
  /\b(send|text|message|email|call|ring|telegram|whatsapp|imessage)\b/i,
  /\b(remind|reminder|calendar|event|schedule me|add to calendar)\b/i,
  /\b(book|order|get me|take me|uber|ubereats|deliveroo|train|trainline)\b/i,
  /\b(play|pause|skip|spotify|music)\b/i,
  /\b(forget|delete from memory|wipe memory|remember)\b/i,
  /\bmy\b.+\b(email|calendar|memory|reminder|messages?|settings|preferences)\b/i
];

const PERSONAL_CONTEXT_PATTERNS = [
  /\bmy\b/i,
  /\bi\b/i,
  /\bme\b/i,
  /\bmine\b/i,
  /\bwe\b/i,
  /\byou\b/i,
  /\bdo you remember\b/i,
  /\bwhat did i\b/i,
  /\bwhen did i\b/i,
  /\bwho am i\b/i
];

const FACTUAL_QUESTION_START = /^(who|what|when|where|why|how|is|are|did|does|do|can|could|will|would)\b/i;

function getSearchReason(message) {
  const text = String(message || '').trim();
  if (!text) return '';

  const hasQuestion = /[?]/.test(text) || FACTUAL_QUESTION_START.test(text);
  const looksLikeToolRequest = NON_SEARCH_PATTERNS.some(pattern => pattern.test(text));

  for (const entry of SEARCH_KEYWORD_PATTERNS) {
    if (entry.pattern.test(text)) return entry.reason;
  }

  const mentionsEntityLikeToken = /\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}|[A-Z]{2,}|[A-Z][a-z]+AI|[A-Z][a-z]+Tech)\b/.test(text);
  const asksChangeableQuestion = CHANGEABLE_QUESTION_PATTERNS.some(pattern => pattern.test(text));

  if (hasQuestion && mentionsEntityLikeToken && asksChangeableQuestion) {
    return 'entity-question';
  }

  if (hasQuestion && asksChangeableQuestion && !looksLikeToolRequest) {
    return 'factual-question-default';
  }

  if (hasQuestion && /\b(news|company|ceo|founder|price|stock|weather|forecast|launch|release|latest|current|today|tonight|yesterday|week|month|year)\b/i.test(text)) {
    return 'factual-question-keyword';
  }

  const looksPersonal = PERSONAL_CONTEXT_PATTERNS.some(pattern => pattern.test(text));
  if (hasQuestion && !looksLikeToolRequest && !looksPersonal && text.length >= 18) {
    return 'question-default-search';
  }

  return '';
}

function needsSearch(message) {
  return Boolean(getSearchReason(message));
}

module.exports = {
  getSearchReason,
  needsSearch
};

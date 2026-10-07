// Deterministic shortcuts for messages that need no interpretation.
//
// A shortcut may only key off something literal: a URL, an uppercase ticker, an anchored
// command form that names its own channel. Anything needing prose weighed belongs to the
// model, which can see the conversation and the action contracts. See preroute-boundary.test.js.

function normalizeText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function trimTrailingPunctuation(value) {
  return normalizeText(value).replace(/[?.!]+$/, '').trim();
}

const EXPLICIT_WEB_URL = /https?:\/\/[^\s<>"'`]+/i;
const EXPLICIT_WEB_REQUEST = /\b(open|browse|read|look at|check|summari[sz]e)\b/i;
// A plain fetch can only read. A request to act on the page (or to use a real browser) needs the
// browser tools, and choosing between them is the model's job.
const WEB_INTERACTION = /\b(click|tap|type|typing|enter|fill|submit|log ?in|sign ?in|select|choose|scroll|press|book|buy|order|purchase|add to|check ?out|download|upload|search (?:for|box|bar)|use the browser|in the browser|real browser|like a person)\b/i;
const STOCK_REQUEST = /\b(?:stock|share|current)\s+price\b|\b(?:price|quote)\s+(?:of|for)\b/i;
const PLAY_TRIVIA_REQUEST = /\b(?:let['’]?s|can we|could we|we should|i want to|i['’]d like to|please)?\s*(?:play|start|begin|do|have)\s+(?:a\s+)?(?:quick\s+|little\s+|fun\s+)?(?:trivia|quiz|game)\b/i;

function inferExplicitWebBrowseAction(message) {
  const text = normalizeText(message);
  const match = text.match(EXPLICIT_WEB_URL);
  if (!match || !EXPLICIT_WEB_REQUEST.test(text) || WEB_INTERACTION.test(text)) return null;

  const url = match[0].replace(/[),.!?;:]+$/, '');
  const query = normalizeText(text
    .replace(match[0], ' ')
    .replace(/^(?:please\s+)?(?:open|browse|read|look at|check|summari[sz]e)\s*/i, '')
    .replace(/^(?:and|then)\s+/i, '')
    .replace(/[?.!]+$/, ''));

  return {
    reason: 'browse_explicit_url',
    spoken: "I'll open that.",
    actions: [{ type: 'web_browse', input: { url, ...(query ? { query } : {}) } }]
  };
}

function inferStockPriceAction(message) {
  const text = normalizeText(message);
  if (!STOCK_REQUEST.test(text)) return null;

  // A ticker is deliberately uppercase in the original message. This keeps ordinary product
  // prices ("price of a mouse") out of the market-data connector.
  const ticker = text.match(/\b[A-Z]{1,5}\b/)?.[0];
  if (!ticker) return null;

  return {
    reason: 'stock_price',
    spoken: "I'll check the current price.",
    actions: [{ type: 'get_stock_price', input: { symbol: ticker } }]
  };
}

function inferPlayAction(message) {
  const text = normalizeText(message);
  if (!PLAY_TRIVIA_REQUEST.test(text)) return null;

  return {
    reason: 'play_trivia',
    spoken: "Let's play a quick one.",
    actions: [{ type: 'play_game', input: { game: 'trivia' } }]
  };
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

// Only the two forms that name their own channel in words nobody uses by accident. A bare
// "call/email/text <someone>" leaves the recipient and the request as prose, which the model
// resolves against contacts and context — and which this used to mangle.
function inferOutboundCommunicationAction(message) {
  const text = normalizeText(message);
  if (!text) return null;

  const telegram = text.match(/^(?:please\s+)?send\s+(.+?)\s+a\s+telegram\s+message\s+(?:saying|that)\s+(.+)$/i);
  if (telegram) {
    return {
      reason: 'send_telegram',
      spoken: 'I’ll send that.',
      actions: [{ type: 'send_telegram', input: { contact: trimTrailingPunctuation(telegram[1]), message: telegram[2].trim() } }]
    };
  }

  const slack = text.match(/^(?:please\s+)?send\s+(#[\w-]+)\s+a\s+slack\s+message\s+(?:saying|that)\s+(.+)$/i);
  if (slack) {
    return {
      reason: 'send_slack_message',
      spoken: 'I’ll send that.',
      actions: [{ type: 'send_slack_message', input: { channel: slack[1], message: slack[2].trim() } }]
    };
  }

  return null;
}

function inferDeterministicAction(message) {
  const text = normalizeText(message);
  if (!text) return null;

  return inferExplicitWebBrowseAction(text)
    || inferStockPriceAction(text)
    || inferPlayAction(text)
    || inferPersonalAdminAction(text)
    || inferOutboundCommunicationAction(text);
}

module.exports = {
  inferDeterministicAction,
  inferPersonalAdminAction,
  inferOutboundCommunicationAction
};

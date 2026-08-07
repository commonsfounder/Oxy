// Resolves vague follow-ups ("play it", "book the second one", "same place", "do the failed
// one") against recent conversation and action history.
//
// Structural history (2026-08-06): this used to collapse everything to ONE candidate — highest
// confidence, else most recent — before ever looking at what the current message actually said.
// resolveContextualTurn then only fired a hardcoded action for that single candidate if it
// happened to be media/place/route AND the message contained a matching verb. Anything else
// (reminders with no stated subject, ordinal selection among options, retrying a failed action,
// re-dating a route lookup, sending a drafted-but-unsent message) had no path through this file
// at all. buildResolvedContext is now message-aware: it ranks multiple typed candidates by
// relevance to what was actually asked, not just recency.

function normalizeText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function safeParseJSON(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

// Subject-less reminder/schedule requests ("remind me tomorrow") don't contain any of the
// pronoun/deictic words below, so they need their own clause — otherwise they never enter this
// pipeline and always fall straight to the model asking "what should I remind you about?", which
// is fine when there's truly nothing to infer but wrong when a topic was just discussed.
const BARE_REMINDER_RE = /^(?:can you |could you |please )?remind me\b(?!.*\b(?:to|about|that)\b)/i;

// A bare pronoun ("it", "that", "one"...) appearing ANYWHERE in a sentence used to be enough to
// trigger contextual resolution — which also caught ordinary grammatical "it" in unrelated
// questions like "what time is it in Tokyo?". These two patterns require the pronoun to actually
// be doing referential work: paired with a verb that takes an object ("play it", "send that"), or
// inside one of a fixed set of known follow-up noun phrases. Plain "it"/"that"/"this" floating
// alone in a sentence no longer qualifies on its own.
const REFERENTIAL_VERB_RE = /\b(play|book|open|send|do|try|watch|read|check|start|stop|cancel|use|pick|choose|order|get|take|make)\s+(it|that|this|one)\b/i;
const REFERENTIAL_NOUN_RE = /\b(that one|this one|the other one|last one|same (?:place|time|thing|one|spot)|get me there|take me there)\b/i;

function isContextualReference(message) {
  const text = normalizeText(message).toLowerCase();
  if (!text) return false;
  if (/^(it|that|this|there|same|again|do it|book it|book that|open it|open that|send it|play it|play that|play this|that one|this one|the other one|last one)$/i.test(text)) return true;
  if (BARE_REMINDER_RE.test(text)) return true;
  if (isRetryIntent(text)) return true;
  if (parseOrdinalSelector(text)) return true;
  return REFERENTIAL_VERB_RE.test(text) ||
    REFERENTIAL_NOUN_RE.test(text) ||
    /\bwhat about\b/i.test(text) ||
    /^(why not|why can't you|why couldn'?t you|how come)\??$/i.test(text) ||
    /^(what|which)\s+platform(\s+is\s+it)?\??$/i.test(text) ||
    /\b(no|nah|actually),?\s+i\s+mean\b/i.test(text) ||
    /\b(is|was)\s+(that|this|it)\s+(right|correct|true)\b/i.test(text) ||
    /\b(do you remember|remember)\b/i.test(text);
}

function unwrapAction(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.result) {
    return {
      type: entry.action || entry.type || '',
      input: entry.input || {},
      result: entry.result || {},
      status: entry.result?.success === false ? 'failed' : 'executed',
      created_at: entry.created_at
    };
  }
  return {
    type: entry.action || entry.type || '',
    input: entry.input || {},
    result: entry,
    // Prefer the explicit DB status column; fall back to the inline success flag.
    status: entry.status || (entry.success === false ? 'failed' : 'executed'),
    created_at: entry.created_at
  };
}

function actionLabel(action) {
  const result = action?.result || {};
  const input = action?.input || {};
  return normalizeText(
    result.cardText ||
    result.text ||
    action?.resultText ||
    input.destination ||
    input.query ||
    input.title ||
    input.message ||
    input.body ||
    ''
  );
}

// A date/time-bearing field on an action's input means it can be re-issued with a different
// date — the mechanism "what about tomorrow?" needs. Kept as a name list rather than a type
// check because these are the only fields any contract actually uses for a point in time.
const DATE_FIELDS = ['departure_time', 'arrival_time', 'due_date', 'start_date', 'end_date', 'date'];
function dateFieldOf(input = {}) {
  return DATE_FIELDS.find(field => input[field]);
}

function contextFromAction(action, source = 'action_result') {
  const type = action?.type || '';
  const input = action?.input || {};
  const label = actionLabel(action);
  if (!type || action?.status === 'pending') return null;

  // Failed actions get their OWN kind instead of being dropped. This is deliberately separate
  // from the action's "real" kind (a failed find_place is 'failed_action', not 'place') so
  // retry-language ("do the failed one") only ever matches failures, and ordinary replay
  // language ("that place again") never accidentally binds to something that didn't work.
  if (action?.status === 'failed') {
    return {
      kind: 'failed_action',
      label: label || type,
      source,
      confidence: 'high',
      suggestedAction: type,
      input,
      error: action?.result?.error || action?.error || ''
    };
  }

  if (type === 'find_place' || type === 'book_uber') {
    return {
      kind: 'place',
      label: label || input.destination || input.query || 'that place',
      source,
      confidence: label || input.destination || input.query ? 'high' : 'low',
      suggestedAction: type === 'find_place' ? 'book_uber' : undefined,
      input
    };
  }
  if (['get_directions', 'plan_trip', 'search_trains', 'station_board'].includes(type)) {
    const result = action?.result || {};
    return {
      kind: 'route',
      label: input.destination || input.station || label || 'that route',
      source,
      confidence: input.destination || input.station ? 'high' : 'medium',
      suggestedAction: type,
      input,
      result,
      routeContext: result.routeContext || null,
      itinerary: Array.isArray(result.itinerary) ? result.itinerary : [],
      dateField: dateFieldOf(input)
    };
  }
  if (type === 'play_music' || type === 'add_to_music_playlist') {
    return {
      kind: 'media',
      label: input.query || label,
      source,
      confidence: input.query || label ? 'high' : 'low',
      suggestedAction: 'play_music',
      input
    };
  }
  if (['send_message', 'send_email', 'send_telegram'].includes(type)) {
    return {
      kind: 'content',
      label: input.message || input.body || label,
      source,
      confidence: input.message || input.body || label ? 'high' : 'low',
      suggestedAction: type,
      input
    };
  }
  if (type === 'create_calendar_event') {
    return {
      kind: 'action',
      label: input.title || label,
      source,
      confidence: input.title || label ? 'high' : 'medium',
      suggestedAction: type,
      input,
      dateField: dateFieldOf(input)
    };
  }
  if (type === 'create_reminder') {
    return {
      kind: 'action',
      label: input.title || label,
      source,
      confidence: input.title || label ? 'high' : 'medium',
      suggestedAction: type,
      input,
      dateField: dateFieldOf(input)
    };
  }
  if (label) {
    return {
      kind: 'action',
      label,
      source,
      confidence: 'medium',
      suggestedAction: type,
      input,
      dateField: dateFieldOf(input)
    };
  }
  return null;
}

function extractSongFromText(text) {
  const source = normalizeText(text);
  if (!source) return null;
  const quoted = source.match(/["“]([^"”]{2,120})["”]\s+by\s+([A-Z][^.,;\n]{1,100})/);
  if (quoted) return `${quoted[1].trim()} by ${quoted[2].trim()}`;
  const possessiveQuoted = source.match(/\b([A-Z][A-Za-z0-9 .&'-]{1,80})['’]s\s+["“]([^"”]{2,120})["”]/);
  if (possessiveQuoted) return `${possessiveQuoted[2].trim()} by ${possessiveQuoted[1].trim()}`;
  const playing = source.match(/\bPlaying\s+(.+?)\s+by\s+([^.,;\n]{2,100})[.!]?$/i);
  if (playing) return `${playing[1].trim()} by ${playing[2].trim()}`;
  const named = source.match(/\b(?:is|was)\s+([^.,;\n"]{2,100})\s+by\s+([^.,;\n]{2,100})/i);
  if (named && /\b(song|track|single|music|billboard|chart|artist)\b/i.test(source)) {
    return `${named[1].replace(/\*+/g, '').trim()} by ${named[2].replace(/\*+/g, '').trim()}`;
  }
  return null;
}

function extractRouteFromText(text) {
  const source = normalizeText(text);
  if (!source) return null;
  const firstTrain = source.match(/\b(?:first|next)\s+train\s+from\s+(.+?)\s+to\s+(.+?)\s+(?:today|tomorrow|on\s+\w+)?\s*(?:is|leaves|departs)?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  if (!firstTrain) return null;
  const origin = firstTrain[1].replace(/[.,;]+$/g, '').trim();
  const destination = firstTrain[2].replace(/\s+(today|tomorrow)$/i, '').replace(/[.,;]+$/g, '').trim();
  const departure = firstTrain[3].trim();
  if (!origin || !destination) return null;
  return {
    kind: 'route',
    label: `${origin} to ${destination}`,
    source: 'assistant_answer',
    confidence: 'high',
    suggestedAction: 'search_trains',
    input: { origin, destination, departure_time: departure },
    result: { text: source },
    routeContext: { origin, destination, mode: 'rail', departure_time: departure },
    itinerary: [],
    dateField: 'departure_time'
  };
}

// Matches the exact shape appointmentChoicesText() renders ("1. Tue 11 Aug at 6pm\n2. ..."),
// not arbitrary numbered prose — a genuine structured list the product itself produces, so
// parsing it is extraction, not free-text NLP. Requires 2+ consecutive numbered lines so a
// single "1." somewhere in an unrelated reply can't be mistaken for a real option list.
function extractOptionListFromText(text) {
  const source = String(text || '');
  const matches = [...source.matchAll(/^(\d+)\.\s+(.+)$/gm)];
  if (matches.length < 2) return null;
  // Consecutive line numbers only (1,2,3 — not 1, then unrelated "4." three paragraphs later).
  for (let i = 1; i < matches.length; i++) {
    if (Number(matches[i][1]) !== Number(matches[i - 1][1]) + 1) return null;
  }
  const options = matches.map(m => ({ index: Number(m[1]), label: normalizeText(m[2]) }));
  return {
    kind: 'option_list',
    label: options.map(o => `${o.index}. ${o.label}`).join(' | '),
    source: 'assistant_answer',
    confidence: 'high',
    options
  };
}

// A message/email the assistant drafted in chat text but never sent. Deliberately scoped to
// bare pronoun references only ("send it", "send that") — a message naming "email"/"mail"
// explicitly already goes through the more capable isEmailDraftRequest/buildEmailDraftContext
// path in index.js, which resolves sender identity and thread context this file has no access
// to. Keying off "the prior turn asked for a draft and nothing was actually sent" rather than
// guessing from the text's shape (greeting-like, paragraph length, ...) avoids false positives
// on ordinary assistant replies that happen to read like prose.
const DRAFT_REQUEST_RE = /\b(draft|write|compose)\b.*\b(message|text|note)\b/i;
const SEND_ACTION_TYPES = new Set(['send_message', 'send_email', 'send_telegram']);

function extractDraftContext(history = []) {
  const rows = [...history];
  for (let i = rows.length - 1; i >= 1; i--) {
    const row = rows[i];
    if (row?.role !== 'assistant') continue;
    const parsed = safeParseJSON(row.content);
    const text = normalizeText(typeof parsed === 'object' && parsed ? parsed.text : row.content);
    if (!text || text.length < 8) continue;
    const alreadySent = (row.actions || []).some(a => SEND_ACTION_TYPES.has(a?.action || a?.type));
    if (alreadySent) continue;
    const priorUser = rows[i - 1];
    if (priorUser?.role !== 'user' || !DRAFT_REQUEST_RE.test(String(priorUser.content || ''))) continue;
    return {
      kind: 'draft',
      label: text.slice(0, 1200),
      source: 'assistant_answer',
      confidence: 'high',
      suggestedAction: 'send_message'
    };
  }
  return null;
}

// Only called when the message itself signals a subject-less reminder ("remind me tomorrow").
// Finds the most recent SUBSTANTIVE thing said — skipping the reminder request itself, skipping
// pure acknowledgements/fillers, and skipping a turn that just dismissed or cancelled something
// (dismissing something is a signal there is nothing left to remind about, not a topic).
// Conservative on purpose: returns null rather than guess when nothing clear stands out, which
// keeps today's "ask what to remind about" behaviour for exactly the cases where that's correct.
const FILLER_RE = /^(ok|okay|kk|cool|nice|great|sure|yep|yes|thanks|thank you|hey|hi|hello|got it|no worries)\.?$/i;
const DISMISSAL_RE = /\b(never mind|forget it|cancel|drop it|nah|no worries|scrap(?:ped)?|leave it)\b/i;
const TOPIC_HINT_RE = /\b(appointment|meeting|call|deadline|dentist|doctor|flight|train|reminder|package|delivery|interview|renewal|invoice|payment due|bill)\b/i;

function extractTopicContext(history = []) {
  const rows = [...history].reverse();
  for (const row of rows) {
    if (row?.role !== 'user') continue;
    const text = normalizeText(row.content);
    if (!text || FILLER_RE.test(text) || BARE_REMINDER_RE.test(text.toLowerCase())) continue;
    if (DISMISSAL_RE.test(text)) return null; // most recent substantive turn was a dismissal — nothing to infer
    if (TOPIC_HINT_RE.test(text) && text.length <= 200) {
      return { kind: 'topic', label: text, source: 'user_message', confidence: 'medium' };
    }
    // First non-filler, non-dismissal user turn that isn't an obvious topic keyword match is
    // still a plausible subject, just lower confidence — the model (or a low-confidence prompt
    // hint) can use its own judgement rather than this resolver guessing harder.
    if (text.length <= 200) {
      return { kind: 'topic', label: text, source: 'user_message', confidence: 'low' };
    }
    return null;
  }
  return null;
}

function extractAssistantContexts(history = []) {
  const contexts = [];
  for (const row of [...history].reverse()) {
    const parsed = safeParseJSON(row?.content);
    const text = normalizeText(typeof parsed === 'object' && parsed ? parsed.text : row?.content);
    const actions = Array.isArray(row?.actions)
      ? row.actions
      : (parsed && Array.isArray(parsed.actions) ? parsed.actions : []);

    for (const actionEntry of actions) {
      const ctx = contextFromAction(unwrapAction(actionEntry));
      if (ctx) contexts.push(ctx);
    }

    if (row?.role === 'assistant' && text) {
      const song = extractSongFromText(text);
      if (song) {
        contexts.push({
          kind: 'media',
          label: song,
          source: 'assistant_answer',
          confidence: 'high',
          suggestedAction: 'play_music'
        });
      }
      const route = extractRouteFromText(text);
      if (route) contexts.push(route);
      if (/\b(weather|forecast|billboard|hot 100|right now|current|latest|today|revenue|price|stock|chart)\b/i.test(text)) {
        contexts.push({
          kind: 'factual_claim',
          label: text.slice(0, 400),
          source: 'assistant_answer',
          confidence: 'medium'
        });
      }
      contexts.push({
        kind: 'content',
        label: text.slice(0, 1200),
        source: 'assistant_answer',
        confidence: 'medium'
      });
    }
  }
  return contexts;
}

function extractActionContexts(recentActions = []) {
  return recentActions
    .map(action => contextFromAction(action, 'action_result'))
    .filter(Boolean);
}

// Symbolic selectors ('other'/'last') resolve against the candidate option_list itself, since
// which index they mean depends on how many options exist. Numeric ones don't.
function parseOrdinalSelector(message) {
  const text = normalizeText(message).toLowerCase();
  const named = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3 };
  for (const [word, index] of Object.entries(named)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) return { index };
  }
  const numbered = text.match(/\boption\s+(\d+)\b|\bnumber\s+(\d+)\b|#\s*(\d+)\b/);
  if (numbered) {
    const n = Number(numbered[1] || numbered[2] || numbered[3]);
    if (n > 0) return { index: n - 1 };
  }
  if (/\blast one\b|\bthe last\b/.test(text)) return { symbolic: 'last' };
  if (/\bother one\b|\bthe other\b/.test(text)) return { symbolic: 'other' };
  return null;
}

// What the CURRENT message is actually asking for, expressed as which candidate kinds are
// eligible — this is the piece that was missing entirely before: kind-relevance filters
// candidates FIRST, recency only breaks ties within that filtered set. A message with no kind
// signal at all (bare "do it"/"that") falls back to today's plain-recency behaviour unchanged.
function messageKindHints(message) {
  const text = normalizeText(message).toLowerCase();
  const hints = new Set();
  if (/\b(play|again)\b/.test(text)) hints.add('media');
  if (/\b(directions|navigate|maps?|route)\b/.test(text)) hints.add('route');
  if (/\bplace\b/.test(text) || /\bsame place\b/.test(text)) hints.add('place');
  if (/\b(send)\b/.test(text) && !/\b(email|mail)\b/.test(text)) hints.add('draft');
  if (/\b(failed|fix|retry|redo)\b/.test(text)) hints.add('failed_action');
  if (/\b(book|choose|pick|order|select)\b/.test(text) || parseOrdinalSelector(text)) hints.add('option_list');
  return hints;
}

function isRetryIntent(message) {
  return /\b(do|fix|retry|redo|try)\b.*\bfailed\b|\bfailed\s+one\b|\btry\s+that\s+again\b/i.test(normalizeText(message));
}

function isDateShiftIntent(message) {
  return /\bwhat about\b.*\b(tomorrow|today|next\s+\w+|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(normalizeText(message)) ||
    /^(?:and\s+)?(?:what about\s+)?tomorrow\??$/i.test(normalizeText(message));
}

function resolveOptionListSelection(optionListCtx, message) {
  const selector = parseOrdinalSelector(message);
  if (!selector || !optionListCtx?.options?.length) return null;
  const options = optionListCtx.options;
  let chosen = null;
  if (Number.isInteger(selector.index)) {
    chosen = options[selector.index] || null;
  } else if (selector.symbolic === 'last') {
    chosen = options[options.length - 1] || null;
  } else if (selector.symbolic === 'other' && options.length === 2) {
    // "The other one" is only unambiguous with exactly two options — with three or more it
    // could mean any of several, so this deliberately does not guess.
    chosen = options[1];
  }
  if (!chosen) return null;
  return {
    kind: 'option_list_selection',
    label: chosen.label,
    source: optionListCtx.source,
    confidence: 'high',
    selectedIndex: chosen.index,
    options
  };
}

function buildResolvedContext(message = '', history = [], recentActions = []) {
  const hints = messageKindHints(message);

  // option_list selection is resolved first and independently: it answers "which of several
  // named things" rather than "which kind of thing", and a correct ordinal match should win
  // regardless of what else ranks highly.
  if (hints.has('option_list')) {
    const optionListCtx = extractOptionListFromText(
      [...history].reverse().find(row => row?.role === 'assistant')?.content
    ) || [...extractAssistantContexts(history)].find(c => c.kind === 'option_list');
    const selection = optionListCtx && resolveOptionListSelection(optionListCtx, message);
    if (selection) return selection;
  }

  if (BARE_REMINDER_RE.test(normalizeText(message).toLowerCase())) {
    const topic = extractTopicContext(history);
    // A low-confidence topic (no topic-keyword hint matched, just "the most recent thing said")
    // isn't reliable enough to hand the model as grounds for auto-creating a reminder — that's
    // exactly how a blank/generic "Reminder" gets created when the previous idea was dismissed
    // or the topic is genuinely unclear. Only a medium/high-confidence topic is used directly.
    if (topic && topic.confidence !== 'low') return topic;
    return { kind: 'reminder_needs_topic', label: '', source: 'assistant_answer', confidence: 'low' };
  }

  const allContexts = [
    ...extractActionContexts(recentActions),
    ...extractAssistantContexts(history)
  ];
  const draft = hints.has('draft') ? extractDraftContext(history) : null;
  if (draft) allContexts.unshift(draft);

  if (hints.size) {
    const filtered = allContexts.filter(ctx => hints.has(ctx.kind));
    if (filtered.length) {
      return filtered.find(ctx => ctx.confidence === 'high') || filtered[0];
    }
    // A kind was clearly wanted and nothing of that kind exists recently — do not silently
    // fall back to an unrelated candidate just because it's the most recent thing overall.
    return { kind: 'unknown', label: '', source: 'assistant_answer', confidence: 'low' };
  }

  // No kind signal in the message at all (bare "it"/"that") — unchanged from before: highest
  // confidence, else most recent.
  return allContexts.find(ctx => ctx.confidence === 'high') || allContexts[0] || {
    kind: 'unknown',
    label: '',
    source: 'assistant_answer',
    confidence: 'low'
  };
}

function resolveContextualTurn({ message = '', history = [], recentActions = [], settings = {} } = {}) {
  const text = normalizeText(message);
  const lower = text.toLowerCase();
  const resolvedContext = buildResolvedContext(text, history, recentActions);
  if (!resolvedContext) return null;

  // No reliable topic to hang a reminder on (dismissed, ambiguous, or low-confidence) — ask
  // instead of the model auto-creating a blank "Reminder". Deterministic and model-independent,
  // same as the other spokenOnly shortcuts below.
  if (resolvedContext.kind === 'reminder_needs_topic') {
    return {
      reason: 'context_reminder_ask_topic',
      resolvedContext,
      spokenOnly: true,
      spoken: 'What should I remind you about?'
    };
  }

  if (resolvedContext.kind === 'unknown') return null;

  // A high-confidence structured pick (an ordinal like "the second one"/"the other one" resolved
  // against a real numbered option list) is authoritative: the choice is built here, directly
  // from the resolver's own selectedIndex/label, so the model has no opportunity to reconstruct
  // — and potentially substitute — a different option from prose. The model can still phrase the
  // final reply (via the action's own execution result), it just can't choose the option.
  if (resolvedContext.kind === 'option_list_selection' && resolvedContext.confidence === 'high') {
    return {
      reason: 'context_option_selected',
      resolvedContext,
      spoken: `I'll go with ${resolvedContext.label}.`,
      actions: [{
        type: 'book_appointment',
        input: { choice_id: String(resolvedContext.selectedIndex), choice_label: resolvedContext.label }
      }]
    };
  }

  if (resolvedContext.kind === 'failed_action' && isRetryIntent(text)) {
    return {
      reason: 'context_retry_failed_action',
      resolvedContext,
      spoken: "I'll try that again.",
      actions: [{ type: resolvedContext.suggestedAction, input: resolvedContext.input }]
    };
  }

  if (resolvedContext.kind === 'media' && /\b(play|play that|play it|again)\b/i.test(lower)) {
    return {
      reason: 'context_media_play',
      resolvedContext,
      spoken: `Playing ${resolvedContext.label}.`,
      actions: [{ type: 'play_music', input: { query: resolvedContext.label } }]
    };
  }

  if (resolvedContext.kind === 'place' && /\b(open|directions|navigate|get me there|take me there)\b/i.test(lower)) {
    const destination = resolvedContext.input?.destination || resolvedContext.input?.query || resolvedContext.label;
    if (!destination) return null;
    return {
      reason: 'context_place_directions',
      resolvedContext,
      spoken: "I'll open directions.",
      actions: [{ type: 'get_directions', input: { destination, mode: settings?.preferredTransportMode || 'driving' } }]
    };
  }

  if (resolvedContext.kind === 'route') {
    const input = resolvedContext.input || resolvedContext.routeContext || {};
    if (!input.destination) return null;

    // Re-issue the SAME route lookup with the date field swapped, rather than replaying it
    // verbatim — "what about tomorrow?" means a new date, not the old answer again.
    if (isDateShiftIntent(text)) {
      const dateField = resolvedContext.dateField || 'departure_time';
      const dayMatch = text.match(/\b(tomorrow|today|next\s+\w+|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
      const newDate = dayMatch ? dayMatch[0] : 'tomorrow';
      return {
        reason: 'context_route_date_shift',
        resolvedContext,
        spoken: `I'll check that for ${newDate}.`,
        actions: [{ type: resolvedContext.suggestedAction || 'get_directions', input: { ...input, [dateField]: newDate } }]
      };
    }

    if (/\b(open|directions|view|map|maps)\b/i.test(lower)) {
      return {
        reason: 'context_route_reopen',
        resolvedContext,
        spoken: "I'll open that route.",
        actions: [{ type: 'get_directions', input }]
      };
    }
  }

  return null;
}

module.exports = {
  buildResolvedContext,
  extractAssistantContexts,
  extractActionContexts,
  extractOptionListFromText,
  extractDraftContext,
  extractTopicContext,
  extractSongFromText,
  parseOrdinalSelector,
  isContextualReference,
  resolveContextualTurn
};

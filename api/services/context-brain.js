function normalizeText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function safeParseJSON(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function isContextualReference(message) {
  const text = normalizeText(message).toLowerCase();
  if (!text) return false;
  if (/^(it|that|this|there|same|again|do it|book it|book that|open it|open that|send it|play it|play that|play this|that one|this one|the other one|last one)$/i.test(text)) return true;
  return /\b(it|that|this|one|there|same|again|other one|last one)\b/i.test(text) ||
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

function contextFromAction(action, source = 'action_result') {
  const type = action?.type || '';
  const input = action?.input || {};
  const label = actionLabel(action);
  if (!type || action?.status === 'failed' || action?.status === 'pending') return null;

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
      itinerary: Array.isArray(result.itinerary) ? result.itinerary : []
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
      input
    };
  }
  if (label) {
    return {
      kind: 'action',
      label,
      source,
      confidence: 'medium',
      suggestedAction: type,
      input
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
    itinerary: []
  };
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

function buildResolvedContext(history = [], recentActions = []) {
  const contexts = [
    ...extractAssistantContexts(history),
    ...extractActionContexts(recentActions)
  ];
  return contexts.find(ctx => ctx.confidence === 'high') || contexts[0] || {
    kind: 'unknown',
    label: '',
    source: 'assistant_answer',
    confidence: 'low'
  };
}

function resolveContextualTurn({ message = '', history = [], recentActions = [], settings = {} } = {}) {
  const text = normalizeText(message);
  const lower = text.toLowerCase();
  const resolvedContext = buildResolvedContext(history, recentActions);
  if (!resolvedContext || resolvedContext.kind === 'unknown') return null;

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

  if (resolvedContext.kind === 'route' && /\b(open|directions|view|map|maps)\b/i.test(lower)) {
    const input = resolvedContext.input || resolvedContext.routeContext || {};
    if (!input.destination) return null;
    return {
      reason: 'context_route_reopen',
      resolvedContext,
      spoken: "I'll open that route.",
      actions: [{ type: 'get_directions', input }]
    };
  }

  return null;
}

module.exports = {
  buildResolvedContext,
  extractAssistantContexts,
  extractActionContexts,
  extractSongFromText,
  isContextualReference,
  resolveContextualTurn
};

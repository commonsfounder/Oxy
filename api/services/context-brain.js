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
    status: entry.success === false ? 'failed' : 'executed',
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
  if (!type || action?.status === 'failed') return null;

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

function findMemoryValue(memory, topicPatterns) {
  const lines = String(memory || '').split(/\n+/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!topicPatterns.some(pattern => pattern.test(line))) continue;
    const match = line.match(/\b(?:is|:|-)\s+(.+)$/i);
    return normalizeText(match?.[1] || line.replace(/^.*?\b(?:usual|preferred|default)?\s*(station|place|address)\b/i, '').trim());
  }
  return '';
}

function extractContact(message) {
  const text = normalizeText(message);
  const match = text.match(/\bto\s+([A-Za-z][A-Za-z .'-]{1,60})(?:[?.!]|$)/);
  return match ? match[1].trim() : '';
}

function firstRouteLeg(ctx, modePattern) {
  const itinerary = Array.isArray(ctx?.itinerary) ? ctx.itinerary : [];
  return itinerary.find(leg => modePattern.test([leg?.type, leg?.service, leg?.line].filter(Boolean).join(' '))) ||
    ctx?.routeContext?.firstTransitLeg ||
    itinerary[0] ||
    ctx?.routeContext?.mainRailLeg ||
    null;
}

function routeLegSentence(leg, fallbackText = '') {
  if (!leg) return normalizeText(fallbackText).slice(0, 280);
  const service = leg.service || leg.line || (leg.type === 'rail' ? 'the train' : 'the bus');
  const dep = leg.departure ? ` at ${leg.departure}` : '';
  const from = leg.from ? ` from ${leg.from}` : '';
  const to = leg.to ? ` to ${leg.to}` : '';
  const arr = leg.arrival ? `, arriving ${leg.arrival}` : '';
  const platform = leg.platform ? ` Platform ${leg.platform}.` : '';
  return `${service}${dep}${from}${to}${arr}.${platform}`.trim();
}

function contextualActionForMessage(message, contexts = [], memory = '', settings = {}) {
  const text = normalizeText(message);
  const lower = text.toLowerCase();

  if (/\bdo you remember\b/i.test(text) && /\busual station\b/i.test(text)) {
    const station = findMemoryValue(memory, [/\busual station\b/i, /\bpreferred station\b/i, /\bdefault station\b/i]);
    if (station) {
      return {
        reason: 'memory_usual_station',
        spokenOnly: true,
        spoken: `Your usual station is ${station}.`,
        resolvedContext: { kind: 'memory', label: station, source: 'memory', confidence: 'high' }
      };
    }
    return {
      reason: 'memory_usual_station_missing',
      spokenOnly: true,
      spoken: "I don't have your usual station saved yet.",
      resolvedContext: { kind: 'memory', label: 'usual station', source: 'memory', confidence: 'low' }
    };
  }

  if (/\b(is|was)\s+(that|this|it)\s+(right|correct|true)\b/i.test(text) || /\b(are you sure|source\??|check that)\b/i.test(text)) {
    return null;
  }

  const latestPlace = contexts.find(ctx => ctx.kind === 'place' && ctx.confidence !== 'low');
  const latestRoute = contexts.find(ctx => ctx.kind === 'route' && ctx.confidence !== 'low');
  const latestMedia = contexts.find(ctx => ctx.kind === 'media' && ctx.confidence !== 'low');
  const latestContent = contexts.find(ctx => ctx.kind === 'content' && ctx.label);

  if (latestRoute && /\b(next|that'?s|that is|is that|so that).*\b(bus|train|route)\b/i.test(text)) {
    const wantsTrain = /\btrain\b/i.test(text);
    const leg = firstRouteLeg(latestRoute, wantsTrain ? /rail|train/i : /bus|transit/i);
    const fallback = latestRoute.result?.text || latestRoute.label;
    return {
      reason: wantsTrain ? 'contextual_confirm_next_train' : 'contextual_confirm_next_bus',
      spokenOnly: true,
      spoken: leg
        ? `That is the first ${wantsTrain ? 'train' : 'transit leg'} I found for that route: ${routeLegSentence(leg)}`
        : `That is the route information I found: ${normalizeText(fallback).slice(0, 320)}`,
      resolvedContext: latestRoute
    };
  }

  if (latestRoute && /^(why not|why can't you|why couldn'?t you|how come)\??$/i.test(text)) {
    const reason = latestRoute.result?.error ||
      latestRoute.result?.text ||
      latestRoute.routeContext?.reason ||
      'I did not have enough reliable route data to answer that fully.';
    return {
      reason: 'contextual_route_failure_explanation',
      spokenOnly: true,
      spoken: normalizeText(reason).slice(0, 360),
      resolvedContext: latestRoute
    };
  }

  if (/\b(book|get|order|call)\s+(me\s+)?(an?\s+)?(uber|taxi|ride)\b/i.test(text) && /\b(it|that|this|there|one)\b/i.test(text)) {
    if (!latestPlace?.label) return null;
    return {
      reason: 'contextual_uber_to_place',
      spoken: "I'll open that in Uber.",
      actions: [{ type: 'book_uber', input: { destination: latestPlace.input?.destination || latestPlace.label } }],
      resolvedContext: { ...latestPlace, suggestedAction: 'book_uber' }
    };
  }

  if (/\b(open|navigate|directions|get there|take me)\b/i.test(text) && /\b(it|that|this|there|one|nearest)\b/i.test(text)) {
    const target = latestPlace || latestRoute;
    if (!target?.label) return null;
    const input = {
      ...(target.input || {}),
      destination: target.input?.destination || target.label,
      mode: target.input?.mode || settings?.preferredTransportMode || 'driving'
    };
    return {
      reason: 'contextual_open_target',
      spoken: "I'll open directions.",
      actions: [{ type: 'get_directions', input }],
      resolvedContext: { ...target, suggestedAction: 'get_directions' }
    };
  }

  if (/\bplay\s+(it|that|this|that one|this one|the song|the track|the one)\b/i.test(lower)) {
    if (!latestMedia?.label) return null;
    return {
      reason: 'contextual_play_media',
      spoken: `Playing ${latestMedia.label}.`,
      actions: [{ type: 'play_music', input: { query: latestMedia.label } }],
      resolvedContext: { ...latestMedia, suggestedAction: 'play_music' }
    };
  }

  if (/\bsend\s+(it|that|this)\s+to\b/i.test(lower)) {
    const contact = extractContact(text);
    if (!contact || !latestContent?.label) return null;
    return {
      reason: 'contextual_send_content',
      spoken: `I'll send that to ${contact}.`,
      actions: [{ type: 'send_message', input: { contact, message: latestContent.label } }],
      resolvedContext: { ...latestContent, suggestedAction: 'send_message' }
    };
  }

  if (/\bwhat about\s+tomorrow\b/i.test(lower) && latestRoute?.input) {
    const input = { ...latestRoute.input };
    if (latestRoute.suggestedAction === 'get_directions') {
      input.departure_time = input.departure_time || 'tomorrow';
      return {
        reason: 'contextual_route_tomorrow',
        spoken: "I'll check that for tomorrow.",
        actions: [{ type: 'get_directions', input }],
        resolvedContext: { ...latestRoute, suggestedAction: 'get_directions' }
      };
    }
    input.departure_time = input.departure_time || 'tomorrow';
    input.preference = input.preference || 'balanced';
    return {
      reason: 'contextual_trip_tomorrow',
      spoken: "I'll plan that for tomorrow.",
      actions: [{ type: 'plan_trip', input }],
      resolvedContext: { ...latestRoute, suggestedAction: 'plan_trip' }
    };
  }

  if (/^(do it|do that|same|same again|again|that one|this one|the other one|last one)$/i.test(text)) {
    return {
      reason: 'ambiguous_contextual_reference',
      spokenOnly: true,
      spoken: 'What should I do with that?',
      resolvedContext: { kind: 'unknown', label: text, source: 'assistant_answer', confidence: 'low' }
    };
  }

  return null;
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

function resolveContextualTurn({ message, history = [], recentActions = [], memory = '', settings = {} } = {}) {
  if (!isContextualReference(message)) return null;
  const contexts = [
    ...extractAssistantContexts(history),
    ...extractActionContexts(recentActions)
  ];
  const turn = contextualActionForMessage(message, contexts, memory, settings);
  if (turn) return turn;
  const resolvedContext = buildResolvedContext(history, recentActions);
  return resolvedContext.confidence === 'low' ? null : { resolvedContext };
}

module.exports = {
  buildResolvedContext,
  extractAssistantContexts,
  extractActionContexts,
  extractSongFromText,
  isContextualReference,
  resolveContextualTurn
};

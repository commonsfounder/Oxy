'use strict';

// Travel actions, lifted out of the 2,600-line switch in api/index.js.
//
// Handlers take one object and return the same shapes they always did. `deps` carries
// what index.js owns (the database client and the travel service modules) rather than
// this file re-creating a second Supabase client, so tests can still inject.

const { getLocalDateKey } = require('../lib/time');
const {
  generateItinerary,
  modifyItinerary,
  itineraryToText
} = require('../services/itinerary-engine');

// Real trip planning. Named plan_itinerary, not plan_trip: plan_trip already exists
// elsewhere in this switch as a point-to-point route/train planner, an unrelated
// capability — do not merge or rename either without checking both. Deliberately does NOT
// use search_flights/search_hotels (those only build a browser deep-link, never real
// prices or availability) or itinerary-engine.js's dormant hotels/activities/flights
// fields (nothing populates them for real) — the only live-facts source here is a real
// grounded web search, fed into itinerary-engine.js as groundedNotes. Booking is a
// deliberately separate step (the general browser capabilities handle actual booking).
async function planItinerary({ userId, action, params, context, deps }) {
  const { supabase, agentWorkspace, travelSearch, travelInventory, travelRanking, FAST_MODEL, path, generateBrain, webSearchBrain } = deps;
  const destination = String(params?.destination || '').trim();
  if (!destination) return { success: false, error: 'plan_itinerary requires destination' };

  const requirements = {
    destination,
    origin: params?.origin || undefined,
    date: params?.start_date || undefined,
    endDate: params?.end_date || undefined,
    duration: params?.duration_days || undefined,
    partySize: params?.party_size || undefined,
    budget: params?.budget ? `${params?.budget_currency || ''}${params.budget}` : undefined,
    transportMode: params?.transport_mode || undefined,
    interests: Array.isArray(params?.interests) ? params.interests : undefined,
    dietary: Array.isArray(params?.dietary) ? params.dietary : undefined,
    accessibility: params?.accessibility || undefined,
    pace: params?.pace || undefined,
    alreadyDone: params?.already_done || undefined,
    notes: params?.notes || undefined
  };
  Object.keys(requirements).forEach(key => requirements[key] === undefined && delete requirements[key]);

  let groundedNotes = '';
  let groundedResearch = false;
  try {
    const searchQuery = [
      `Practical trip-planning info for ${destination}`,
      params?.start_date ? `around ${params.start_date}${params?.end_date ? ` to ${params.end_date}` : ''}` : '',
      params?.interests?.length ? `for someone interested in ${[].concat(params.interests).join(', ')}` : ''
    ].filter(Boolean).join(' ');
    const answer = await webSearchBrain({
      model: FAST_MODEL,
      prompt: `Today's date is ${getLocalDateKey()}. ${searchQuery}. Cover: top attractions worth the time with realistic visit durations, current opening hours and any closures, approximate current ticket/entry prices, realistic walking/transit times between areas, and any well-known food spots. Only report what search results actually support; say plainly if something can't be verified rather than guessing. Plain prose, no markdown headings or asterisks.`
    });
    if (answer) { groundedNotes = answer; groundedResearch = true; }
  } catch (e) {
    console.warn('[plan_itinerary] grounded search failed, generating without it:', e.message);
  }

  // A full multi-day itinerary (or a modified one) is a large JSON payload — the default
  // completion budget elsewhere in this file (768 tokens, fine for short replies/judgments)
  // left nothing for visible output once a reasoning model spent its budget on reasoning
  // tokens, so generateBrain came back with empty text. Confirmed live 2026-08-08: the
  // same request against gpt-5.6-luna returned candidates[0].content.parts: [] with
  // maxOutputTokens unset; raising the cap fixed it.
  const callModel = async (systemPrompt, prompt) => {
    const res = await generateBrain({ model: FAST_MODEL, contents: [{ role: 'user', parts: [{ text: prompt }] }], config: { systemInstruction: systemPrompt, maxOutputTokens: 4000 } });
    return res?.text || '';
  };

  let itinerary;
  try {
    itinerary = await generateItinerary(requirements, { groundedNotes }, null, callModel);
  } catch (e) {
    return { success: false, error: `Could not build an itinerary: ${e.message}` };
  }

  const caveats = [
    groundedResearch
      ? null
      : "I couldn't verify current opening hours/prices/closures for this trip, so treat times and costs as estimates, not confirmed facts.",
    'Flights and hotels are not live-searched or booked here — say the word and I can look at real options and take you through an actual booking.'
  ].filter(Boolean);

  return {
    success: true,
    itinerary,
    groundedResearch,
    text: `${itineraryToText(itinerary)}\n\n${caveats.join(' ')}`
  };
}

// Surgical edit of an existing itinerary (preserves days/sections the instruction doesn't
// touch) rather than a full regeneration. Accepts the itinerary inline (the model's own
// context from a recent plan_itinerary call) or a workspace_path to a previously saved one —
// whichever is fresher wins if both are given, and a workspace-loaded trip is re-saved
// to the same path after the edit so the saved copy stays in sync.
async function modifyItineraryAction({ userId, action, params, context, deps }) {
  const { supabase, agentWorkspace, travelSearch, travelInventory, travelRanking, FAST_MODEL, path, generateBrain, webSearchBrain } = deps;
  const instruction = String(params?.instruction || '').trim();
  if (!instruction) return { success: false, error: 'modify_itinerary requires instruction' };

  let itinerary = null;
  let workspacePath = params?.workspace_path ? String(params.workspace_path).trim() : '';

  if (params?.itinerary) {
    try {
      itinerary = typeof params.itinerary === 'string' ? JSON.parse(params.itinerary) : params.itinerary;
    } catch {
      return { success: false, error: 'The itinerary passed to modify_itinerary was not valid JSON. Pass the exact itinerary object from plan_itinerary, or a workspace_path to a previously saved one.' };
    }
  } else if (workspacePath) {
    let file;
    try {
      file = await agentWorkspace.readWorkspaceFile(supabase, userId, workspacePath);
    } catch (e) {
      return { success: false, error: e.message };
    }
    if (!file) return { success: false, error: `No saved itinerary at ${workspacePath}.` };
    try {
      itinerary = JSON.parse(file.content);
    } catch {
      return { success: false, error: `The saved file at ${workspacePath} isn't valid itinerary JSON, so it can't be edited directly. Generate a fresh one with plan_itinerary instead.` };
    }
  } else {
    return { success: false, error: 'modify_itinerary needs either the itinerary JSON from a recent plan_itinerary call, or a workspace_path to a previously saved itinerary.' };
  }

  if (!itinerary?.days) return { success: false, error: 'That does not look like a valid itinerary (no days array).' };

  // A full multi-day itinerary (or a modified one) is a large JSON payload — the default
  // completion budget elsewhere in this file (768 tokens, fine for short replies/judgments)
  // left nothing for visible output once a reasoning model spent its budget on reasoning
  // tokens, so generateBrain came back with empty text. Confirmed live 2026-08-08: the
  // same request against gpt-5.6-luna returned candidates[0].content.parts: [] with
  // maxOutputTokens unset; raising the cap fixed it.
  const callModel = async (systemPrompt, prompt) => {
    const res = await generateBrain({ model: FAST_MODEL, contents: [{ role: 'user', parts: [{ text: prompt }] }], config: { systemInstruction: systemPrompt, maxOutputTokens: 4000 } });
    return res?.text || '';
  };

  let updated;
  try {
    updated = await modifyItinerary(itinerary, instruction, {}, callModel);
  } catch (e) {
    return { success: false, error: `Could not apply that change: ${e.message}` };
  }

  let resaved = false;
  if (workspacePath) {
    try {
      await agentWorkspace.writeWorkspaceFile(supabase, userId, workspacePath, JSON.stringify(updated, null, 2), 'file');
      resaved = true;
    } catch (e) {
      console.warn('[modify_itinerary] re-save failed:', e.message);
    }
  }

  return {
    success: true,
    itinerary: updated,
    resaved,
    text: `${updated.lastModification?.summary || 'Updated the itinerary.'}${resaved ? ` (re-saved to ${workspacePath})` : ''}\n\n${itineraryToText(updated)}`
  };
}

// ── Real travel search ────────────────────────────────────────────────────────────
// These two used to build a deep link and report success. They now do a real grounded
// web search and return what the results actually stated, with prices marked as
// observed-not-bookable. See api/services/travel-search.js for why this route and not
// an API or a browser. They are also removed from the connectors registry, so the old
// link-generator is unreachable rather than merely unused.
async function searchTravel({ userId, action, params, context, deps }) {
  const { supabase, agentWorkspace, travelSearch, travelInventory, travelRanking, FAST_MODEL, path, generateBrain, webSearchBrain } = deps;
  const kind = action === 'search_flights' ? 'flights' : 'hotels';
  const today = getLocalDateKey();

  const research = kind === 'flights'
    ? travelSearch.buildFlightResearchPrompt({
      from: String(params?.from || '').trim(),
      to: String(params?.to || params?.destination || '').trim(),
      departDate: String(params?.depart_date || params?.date || '').trim(),
      returnDate: String(params?.return_date || '').trim(),
      adults: Math.max(1, Math.min(Number(params?.adults) || 1, 9)),
      notes: String(params?.notes || '').trim(),
      maxPrice: Number(params?.max_price) || null,
      directOnly: params?.direct_only === true || String(params?.direct_only) === 'true',
      today
    })
    : travelSearch.buildHotelResearchPrompt({
      location: String(params?.location || params?.city || '').trim(),
      checkIn: String(params?.check_in || params?.checkin || '').trim(),
      checkOut: String(params?.check_out || params?.checkout || '').trim(),
      guests: Math.max(1, Math.min(Number(params?.guests) || 2, 12)),
      maxNightly: params?.max_price ? String(params.max_price) : '',
      area: String(params?.area || '').trim(),
      notes: String(params?.notes || '').trim(),
      today
    });

  if (kind === 'flights' && (!params?.from || !(params?.to || params?.destination))) {
    return { success: false, error: 'search_flights needs both a departure and a destination.' };
  }
  if (kind === 'hotels' && !(params?.location || params?.city)) {
    return { success: false, error: 'search_hotels needs a location.' };
  }

  // Real inventory first, when a provider is configured. This is the difference between
  // "a page mentioned £133 for some nearby dates" and "here is a sellable fare for the
  // dates you asked for". Grounded search below stays as the fallback rather than being
  // replaced: with no provider key it is still the honest answer, and it is the only
  // thing that works for routes or properties a single provider does not carry.
  let inventoryOptions = [];
  let inventoryNote = null;
  if (travelInventory.isConfigured()) {
    const found = kind === 'flights'
      ? await travelInventory.searchFlights({
        origin: String(params?.from || '').trim(),
        destination: String(params?.to || params?.destination || '').trim(),
        start: String(params?.depart_date || params?.date || '').trim(),
        end: String(params?.return_date || '').trim(),
        passengers: Math.max(1, Math.min(Number(params?.adults) || 1, 9))
      })
      : await travelInventory.searchStays({
        latitude: Number(params?.latitude), longitude: Number(params?.longitude),
        checkIn: String(params?.check_in || params?.checkin || '').trim(),
        checkOut: String(params?.check_out || params?.checkout || '').trim(),
        guests: Math.max(1, Math.min(Number(params?.guests) || 2, 12))
      });
    if (found.ok) inventoryOptions = found.options;
    // A provider that errored is said out loud. Falling through to web search silently
    // would turn "the travel API is down" into "these are your options".
    else if (found.configured) inventoryNote = `Live inventory was unavailable (${found.reason}), so these are sourced from the web instead.`;
  }

  let researchText = '';
  try {
    researchText = await webSearchBrain({ model: FAST_MODEL, prompt: research });
  } catch (e) {
    return { success: false, error: `The travel search could not run: ${e.message}` };
  }
  if (!researchText) {
    return { success: false, error: 'The web search returned nothing for that route — I have no real options to show you rather than made-up ones.' };
  }

  // Stage two runs WITHOUT the search tool: it may only restructure the text above, so
  // it cannot introduce an option that was never found. The token budget is explicit —
  // the default (768, shared with reasoning) silently returns an empty string on an
  // input this long.
  let options = [];
  try {
    const extracted = await generateBrain({
      model: FAST_MODEL,
      contents: [{ role: 'user', parts: [{ text: travelSearch.buildExtractionPrompt(kind, researchText, params || {}) }] }],
      config: { maxOutputTokens: travelSearch.EXTRACTION_TOKENS }
    });
    options = travelSearch.parseTravelResults(kind, extracted.text || '');
  } catch (e) {
    return { success: false, error: `The travel search found results but could not read them: ${e.message}`, research: researchText };
  }

  // Date provenance FIRST: the exact/adjacent/unknown grade is recomputed from what the
  // source actually quoted, so nothing downstream can present an adjacent-date fare as
  // satisfying the request.
  const requestedDates = kind === 'flights'
    ? { start: params?.depart_date || params?.date, end: params?.return_date }
    : { start: params?.check_in || params?.checkin, end: params?.check_out || params?.checkout };
  // Inventory options go through exactly the same grading as web-sourced ones. They will
  // almost always come out 'exact' — that is the point of asking a booking system — but
  // the verdict is still computed from their observed dates rather than asserted.
  const dated = travelSearch.applyDateProvenance([...inventoryOptions, ...options], requestedDates);

  const { kept, dropped } = travelSearch.applyConstraints(dated, {
    maxPrice: Number(params?.max_price) || null,
    maxPriceCurrency: String(params?.currency || 'GBP').toUpperCase(),
    directOnly: params?.direct_only === true || String(params?.direct_only) === 'true',
    maxStops: Number.isFinite(Number(params?.max_stops)) && params?.max_stops !== undefined ? Number(params.max_stops) : undefined,
    minRating: Number(params?.min_rating) || null
  });

  // travel-ranking.js finally has real structured results to rank. It was written for an
  // Amadeus connector that never existed here, which is why it sat orphaned; the mapping
  // in toRankingShape is what makes it live rather than rewriting it.
  const requirements = {
    budget: params?.max_price ? String(params.max_price) : '',
    constraints: (params?.direct_only === true || String(params?.direct_only) === 'true') ? ['direct_or_fewest_changes'] : [],
    partySize: String(params?.adults || params?.guests || 1),
    accommodationPreference: String(params?.style || '').trim()
  };
  const shaped = kept.map(travelSearch.toRankingShape);
  const ranked = kind === 'flights'
    ? travelRanking.rankFlights(shaped, {}, requirements)
    : travelRanking.rankHotels(shaped, {}, requirements);
  // Date-matched options always outrank indicative ones, whatever the score: a cheaper
  // price for the wrong week is not a better option, it is a different question.
  // Exact beats unknown beats adjacent, whatever the score. A cheaper price for the wrong
  // week is not a better option, it is an answer to a different question.
  const dateRank = (o) => (o.dateMatch === 'exact' ? 0 : o.dateMatch === 'unknown' ? 1 : 2);
  ranked.sort((a, b) => dateRank(a) - dateRank(b) || (b.score - a.score));

  const searched = kind === 'flights'
    ? `${params.from} to ${params.to || params.destination}${params?.depart_date ? ` ${params.depart_date}` : ''}${params?.return_date ? `–${params.return_date}` : ''}`
    : `${params.location || params.city}${params?.check_in ? ` ${params.check_in}` : ''}${params?.check_out ? `–${params.check_out}` : ''}`;

  return {
    success: true,
    kind,
    options: ranked,
    datesMatched: ranked.filter(o => o.dateMatch === 'exact').length,
    adjacentDates: ranked.filter(o => o.dateMatch === 'adjacent').length,
    datesUnknown: ranked.filter(o => o.dateMatch === 'unknown').length,
    indicative: ranked.filter(o => o.dateMatch !== 'exact').length,
    currencies: [...new Set(ranked.map(o => o.currency).filter(Boolean))],
    droppedByConstraints: dropped.map(d => ({ why: d.why, option: d.option.airline || d.option.name })),
    research: researchText,
    // How many of these came from a booking system rather than from reading a page —
    // the one distinction that decides whether a price can be acted on.
    fromInventory: ranked.filter(o => o.inventory === true).length,
    inventoryProvider: travelInventory.isConfigured() ? travelInventory.providerMode() : null,
    // Search and booking stay separate: finding a sellable fare is not the same as
    // holding one, and purchase still goes through the existing review path.
    bookable: false,
    text: [
      travelSearch.formatTravelResults(kind, ranked, { dropped, searched, researchFound: Boolean(researchText) }),
      inventoryNote
    ].filter(Boolean).join(' ')
  };
}

module.exports = {
  handlers: {
    plan_itinerary: planItinerary,
    modify_itinerary: modifyItineraryAction,
    search_flights: searchTravel,
    search_hotels: searchTravel
  }
};

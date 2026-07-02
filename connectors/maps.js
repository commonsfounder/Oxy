const axios = require('axios');
const { resolvePlaceDestination, cleanPlaceSearchQuery } = require('../api/geocoding');
const { getGoogleDirectionsKey } = require('../api/services/maps-config');

const SUPPORTED_ACTIONS = ['find_place', 'get_directions', 'plan_trip'];

function shortAddress(address) {
  return String(address || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(', ');
}

function distanceLabel(meters) {
  const value = Number(meters);
  if (!Number.isFinite(value)) return '';
  if (value < 1000) return `${Math.round(value)} m away`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} km away`;
}

function placeLabel(place, fallback) {
  const name = place?.name || cleanPlaceSearchQuery(fallback);
  const area = shortAddress(place?.formattedAddress || '');
  if (name && area && !area.toLowerCase().startsWith(name.toLowerCase())) {
    return `${name}, ${area}`;
  }
  return name || area || fallback;
}

function mapsLink(place, query) {
  if (place?.googleMapsUri) return place.googleMapsUri;
  const lat = Number(place?.lat);
  const lng = Number(place?.lng);
  const label = encodeURIComponent(place?.name || cleanPlaceSearchQuery(query) || 'Place');
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return `https://maps.apple.com/?ll=${lat},${lng}&q=${label}`;
  }
  return `https://maps.apple.com/?q=${encodeURIComponent(query)}`;
}

function mapsSearchFallback(query, err = null) {
  const cleanedQuery = cleanPlaceSearchQuery(query);
  const link = `https://maps.apple.com/?q=${encodeURIComponent(cleanedQuery)}`;
  const reason = String(err?.message || err || '');
  const setupText = /not configured|GOOGLE_PLACES_API_KEY|GOOGLE_MAPS_API_KEY/i.test(reason)
    ? 'Exact nearest-place ranking needs a Google Places API key on the server.'
    : 'Exact nearest-place ranking needs the server Places key to be accepted.';
  return {
    success: true,
    text: `I can open Maps for ${cleanedQuery}. ${setupText}`,
    actionSummary: 'Maps search ready',
    cardText: 'Open search in Maps',
    deepLink: link,
    webLink: link
  };
}

function directionModeFlag(mode) {
  const normalized = String(mode || '').toLowerCase();
  if (/walk|walking/.test(normalized)) return 'w';
  if (/bus|transit|public|train|tube|tram/.test(normalized)) return 'r';
  return 'd';
}

function mapsDirectionsFallback(destination, params = {}) {
  const cleanedDestination = cleanPlaceSearchQuery(destination);
  const cleanedOrigin = cleanPlaceSearchQuery(params.origin || '');
  const flag = directionModeFlag(params.mode);
  const originPart = cleanedOrigin ? `saddr=${encodeURIComponent(cleanedOrigin)}&` : '';
  const link = `https://maps.apple.com/?${originPart}daddr=${encodeURIComponent(cleanedDestination)}&dirflg=${flag}`;
  const modeLabel = flag === 'r' ? 'transit' : flag === 'w' ? 'walking' : 'driving';
  if (flag === 'r') {
    return {
      success: true,
      text: `I couldn't get a reliable transit route summary to ${cleanedDestination} right now.`,
      actionSummary: 'Route unavailable',
      cardText: 'No transit route summary available',
      routeContext: {
        origin: cleanedOrigin || 'current location',
        destination: cleanedDestination,
        mode: 'transit',
        reason: 'route_summary_unavailable'
      }
    };
  }
  return {
    success: true,
    text: `${modeLabel[0].toUpperCase()}${modeLabel.slice(1)} directions to ${cleanedDestination} are ready.`,
    actionSummary: 'Directions ready',
    cardText: `Open ${modeLabel} directions in Maps`,
    deepLink: link,
    webLink: link
  };
}

function trainlineLink(origin, destination, params = {}) {
  const from = cleanPlaceSearchQuery(origin || '');
  const to = cleanPlaceSearchQuery(destination || '');
  const query = [from, to].filter(Boolean).join(' to ');
  return `https://www.thetrainline.com/search?origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to || query)}${params.departure_time ? `&when=${encodeURIComponent(params.departure_time)}` : ''}${params.arrival_time ? `&arriveBy=${encodeURIComponent(params.arrival_time)}` : ''}`;
}

function parseDirectionTime(value, now = new Date()) {
  const text = String(value || '').trim();
  if (!text) return null;
  const tomorrow = /\btomorrow\b/i.test(text);
  // Accept ":", ".", or a space between hour and minutes ("9:25", "9.25", "9 25 am").
  const match = text.match(/(\d{1,2})(?:[:.\s](\d{2}))?\s*(am|pm)?/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = match[3]?.toLowerCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  const arrival = new Date(now);
  if (tomorrow) arrival.setDate(arrival.getDate() + 1);
  arrival.setHours(hour, minute, 0, 0);
  if (!tomorrow && arrival.getTime() < now.getTime()) arrival.setDate(arrival.getDate() + 1);
  return Math.floor(arrival.getTime() / 1000);
}

function formatClockTime(seconds) {
  const d = new Date(Number(seconds) * 1000);
  let hour = d.getHours();
  const minute = d.getMinutes();
  const meridiem = hour >= 12 ? 'pm' : 'am';
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${String(minute).padStart(2, '0')} ${meridiem}`;
}

function minutesBetween(a, b) {
  const start = Number(a);
  const end = Number(b);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const mins = Math.round((end - start) / 60);
  return mins > 7 ? mins : null;
}

function findPlatformValue(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (/platform/i.test(key) && (typeof child === 'string' || typeof child === 'number')) {
      const text = String(child).trim();
      if (text) return text;
    }
    const nested = findPlatformValue(child, seen);
    if (nested) return nested;
  }
  return null;
}

function isRailStep(step) {
  return /RAIL|TRAIN|HEAVY_RAIL|COMMUTER_TRAIN|INTERCITY|NATIONAL_RAIL/i.test([
    step?.vehicle,
    step?.service,
    step?.line
  ].filter(Boolean).join(' '));
}

function formatTransitStep(step) {
  const transit = step.transit_details;
  if (!transit) return null;
  const line = transit.line?.short_name || transit.line?.name || transit.line?.vehicle?.name || 'transit';
  const from = transit.departure_stop?.name;
  const to = transit.arrival_stop?.name;
  const vehicle = transit.line?.vehicle?.type || transit.line?.vehicle?.name || '';
  const agency = transit.line?.agencies?.[0]?.name || '';
  const departure = transit.departure_time?.text;
  const arrival = transit.arrival_time?.text;
  const stops = transit.num_stops;
  const service = [agency, line].filter(Boolean).join(' ');
  const platform = findPlatformValue(transit);
  const platformText = platform ? `platform ${platform}` : '';
  return {
    line,
    service: service || line,
    vehicle,
    from,
    to,
    departure,
    arrival,
    departureValue: transit.departure_time?.value,
    arrivalValue: transit.arrival_time?.value,
    stops,
    platform,
    text: [line, from && `from ${from}`, platformText, to && `to ${to}`].filter(Boolean).join(' ')
  };
}

function routeTransitSteps(route) {
  const leg = route?.legs?.[0];
  return (leg?.steps || []).map(formatTransitStep).filter(Boolean);
}

// A mild nudge toward rail (in seconds, comparable to duration) so trains are
// preferred over an equal-ish coach — but NOT a blunt override. The old flat
// -200000 made ANY route containing rail beat ANY non-rail route regardless of
// duration, so a multi-hour Eurostar detour won "directions to Apsley". Keeping
// the bonus duration-comparable means a route that's wildly longer still loses.
const RAIL_PREFERENCE_SECONDS = 1800;

function scoreTripRoute(route, preference = '') {
  const leg = route?.legs?.[0];
  const steps = routeTransitSteps(route);
  const railCount = steps.filter(isRailStep).length;
  const transitCount = steps.length;
  const duration = Number(leg?.duration?.value || Number.MAX_SAFE_INTEGER);
  const waits = [];
  for (let i = 1; i < steps.length; i += 1) {
    const wait = minutesBetween(steps[i - 1].arrivalValue, steps[i].departureValue);
    if (wait) waits.push(wait);
  }
  const changePenalty = /direct|few|no changes?/i.test(preference)
    ? transitCount * 1400
    : transitCount * 700;
  const waitPenalty = waits.reduce((sum, wait) => sum + (wait > 45 ? wait * 80 : wait * 20), 0);
  return (railCount ? -RAIL_PREFERENCE_SECONDS : 0) + changePenalty + waitPenalty + duration;
}

function chooseBestTripRoute(routes = [], preference = '') {
  return [...routes]
    .filter(route => route?.legs?.[0])
    .sort((a, b) => scoreTripRoute(a, preference) - scoreTripRoute(b, preference))[0] || null;
}

function buildTransitRequestParams(destination, params = {}, railFirst = false) {
  const key = getGoogleDirectionsKey();
  const location = params.location;
  const lat = Number(location?.latitude ?? location?.lat);
  const lng = Number(location?.longitude ?? location?.lng);
  const explicitOrigin = cleanPlaceSearchQuery(params.origin || '');
  if (!key || (!explicitOrigin && (!Number.isFinite(lat) || !Number.isFinite(lng)))) return null;
  const requestParams = {
    origin: explicitOrigin || `${lat},${lng}`,
    destination: cleanPlaceSearchQuery(destination),
    mode: 'transit',
    alternatives: true,
    // Bias geocoding to Great Britain so an ambiguous name ("Apsley") resolves to
    // the UK town near the user, not a foreign match that routes via Eurostar.
    region: 'gb',
    key
  };
  if (railFirst) requestParams.transit_mode = 'train|rail';
  else if (/^bus$/i.test(params.mode)) requestParams.transit_mode = 'bus';
  const arrival = parseDirectionTime(params.arrival_time);
  const departure = parseDirectionTime(params.departure_time);
  if (arrival) requestParams.arrival_time = arrival;
  if (!arrival && departure) requestParams.departure_time = departure;
  return requestParams;
}

async function fetchTransitRoutes(destination, params = {}, railFirst = false) {
  const requestParams = buildTransitRequestParams(destination, params, railFirst);
  if (!requestParams) return null;
  const response = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
    params: requestParams,
    timeout: 10000
  });
  if (response.data?.status !== 'OK' || !response.data.routes?.length) return null;
  return response.data.routes;
}

function summarizeTripRoute(route, destination, params = {}, usedRailFirst = false) {
  const leg = route?.legs?.[0];
  if (!leg) return null;
  const steps = routeTransitSteps(route);
  const railSteps = steps.filter(isRailStep);
  const mainRail = railSteps.sort((a, b) => Number(b.arrivalValue || 0) - Number(a.arrivalValue || 0))[0] || steps[0];
  const duration = leg.duration?.text;
  const departure = leg.departure_time?.text;
  const arrival = leg.arrival_time?.text;
  const originLabel = params.origin || leg.start_address || 'your current location';
  const cleanDestination = cleanPlaceSearchQuery(destination);
  const hasRail = railSteps.length > 0;
  const directRail = railSteps.length === 1;
  const accessSteps = [];
  for (const step of steps) {
    if (step === mainRail) break;
    accessSteps.push(step);
  }
  const changes = [];
  for (let i = 1; i < steps.length; i += 1) {
    const wait = minutesBetween(steps[i - 1].arrivalValue, steps[i].departureValue);
    if (wait) changes.push({ minutes: wait, at: steps[i - 1].to, next: steps[i].service });
  }
  const mainPlatform = mainRail?.platform ? ` from platform ${mainRail.platform}` : '';
  const mainTrainText = mainRail
    ? `${mainRail.service}${mainRail.departure ? ` at ${mainRail.departure}` : ''}${mainPlatform}${mainRail.from ? ` from ${mainRail.from}` : ''}${mainRail.to ? ` to ${mainRail.to}` : ''}${mainRail.arrival ? `, arriving ${mainRail.arrival}` : ''}`
    : '';
  const accessText = accessSteps.length
    ? `First get to ${mainRail?.from || 'the station'}${mainRail?.departure ? ` before ${mainRail.departure}` : ''}.`
    : '';
  const directText = directRail ? 'direct train' : `${railSteps.length || steps.length} transit legs`;
  const nonRailLabel = steps.some(s => /BUS/i.test(s.vehicle || '')) ? 'bus' : 'transit';
  const opener = hasRail
    ? `Best move: ${accessSteps.length ? `get to ${mainRail?.from || 'the station'}, then ` : ''}take the ${directText} to ${cleanDestination}.`
    : `Best move: take the ${nonRailLabel} to ${cleanDestination}.`;
  const timing = departure && arrival
    ? `Leave around ${departure}; you should arrive around ${arrival}${duration ? ` (${duration})` : ''}.`
    : duration ? `It takes about ${duration}.` : '';
  const changeText = changes[0]
    ? `You have about ${changes[0].minutes} minutes to change${changes[0].at ? ` at ${changes[0].at}` : ''}.`
    : '';
  const platformCaveat = hasRail && !railSteps.some(step => step.platform)
    ? 'No reliable platform is in the route data yet, so check the board closer to departure.'
    : '';
  const text = [opener, timing, mainTrainText ? `Main train: ${mainTrainText}.` : '', changeText, platformCaveat]
    .filter(Boolean)
    .join(' ');
  const itinerary = steps.map(step => ({
    type: isRailStep(step) ? 'rail' : 'transit',
    service: step.service,
    line: step.line,
    from: step.from,
    to: step.to,
    departure: step.departure,
    arrival: step.arrival,
    platform: step.platform || null,
    stops: Number.isFinite(Number(step.stops)) ? Number(step.stops) : null
  }));
  const cardBits = [
    accessText,
    mainTrainText ? `Train: ${mainTrainText}.` : null,
    changeText,
    arrival ? `Arrive around ${arrival}.` : null
  ].filter(Boolean);
  return {
    text,
    headline: [duration, departure && arrival ? `${departure}-${arrival}` : null].filter(Boolean).join(' · '),
    detail: mainRail?.text || `Open trip in Maps`,
    cardText: cardBits.join(' '),
    itinerary,
    routeContext: {
      origin: originLabel,
      destination: cleanDestination,
      departure,
      arrival,
      duration,
      railFirst: usedRailFirst,
      directRail,
      mainRailLeg: mainRail || null,
      changes,
      platformReliable: railSteps.some(step => step.platform)
    }
  };
}

async function planTrip(destination, params = {}) {
  const cleanedDestination = cleanPlaceSearchQuery(destination);
  const fallbackLink = `https://maps.apple.com/?${params.origin ? `saddr=${encodeURIComponent(params.origin)}&` : ''}daddr=${encodeURIComponent(cleanedDestination)}&dirflg=r`;
  const bookingUrl = trainlineLink(params.origin || '', cleanedDestination, params);
  if (!getGoogleDirectionsKey()) {
    return {
      success: true,
      text: `I couldn't get a rail route summary to ${cleanedDestination} because the server is missing a Google Directions key.`,
      actionSummary: 'Route unavailable',
      cardText: 'Open transit directions in Maps',
      deepLink: fallbackLink,
      webLink: fallbackLink,
      routeContext: {
        origin: params.origin || 'current location',
        destination: cleanedDestination,
        mode: 'rail',
        reason: 'google_directions_key_missing'
      }
    };
  }
  // Resolve the destination to a GB-biased, location-aware address first (same as
  // get_directions) so the routing request gets a precise place instead of raw text
  // that Google can geocode to the wrong "Apsley". Fall back to the cleaned text if
  // Places isn't configured or finds nothing.
  let routeDestination = cleanedDestination;
  try {
    const place = await resolvePlaceDestination(destination, { location: params.location });
    if (place?.formattedAddress) routeDestination = place.formattedAddress;
  } catch (err) {
    console.warn('[maps] plan_trip destination resolve failed, using raw text:', err.message);
  }
  const busPreferred = /^bus$/i.test(String(params.mode || ''));
  const railRoutes = busPreferred ? null : await fetchTransitRoutes(routeDestination, params, true).catch(err => {
    console.warn('[maps] Rail-first Directions failed:', err.message);
    return null;
  });
  const allRoutes = railRoutes || await fetchTransitRoutes(routeDestination, params, false).catch(err => {
    console.warn('[maps] Transit Directions failed:', err.message);
    return null;
  });
  const best = chooseBestTripRoute(allRoutes || [], params.preference);
  if (!best) {
    return {
      success: true,
      text: `I couldn't get a reliable transit route summary to ${cleanedDestination} right now.`,
      actionSummary: 'Route unavailable',
      cardText: 'Open transit directions in Maps',
      deepLink: fallbackLink,
      webLink: fallbackLink,
      routeContext: {
        origin: params.origin || 'current location',
        destination: cleanedDestination,
        mode: 'transit',
        reason: 'route_summary_unavailable'
      }
    };
  }
  const summary = summarizeTripRoute(best, cleanedDestination, params, Boolean(railRoutes));
  return {
    success: true,
    text: summary.text,
    actionSummary: 'Trip planned',
    cardText: summary.cardText || summary.detail,
    headline: summary.headline,
    itinerary: summary.itinerary,
    routeContext: summary.routeContext,
    bookingUrl,
    deepLink: fallbackLink,
    webLink: bookingUrl
  };
}

function summarizeDirectionsRoute(route, modeLabel, arrivalSeconds = null) {
  const leg = route?.legs?.[0];
  if (!leg) return null;
  const duration = leg.duration?.text;
  const arrival = leg.arrival_time?.text;
  const departure = leg.departure_time?.text;
  const transitSteps = (leg.steps || []).map(formatTransitStep).filter(Boolean);
  const headline = [
    duration && `${duration}`,
    departure && arrival && `${departure}-${arrival}`,
    !departure && arrival && `arrive ${arrival}`
  ].filter(Boolean).join(' · ');
  const detail = transitSteps.length
    ? transitSteps.map(step => step.text).slice(0, 3).join(' · ')
    : `Open ${modeLabel} directions in Maps`;
  if (!transitSteps.length) {
    // Driving/walking: if the user gave an arrival deadline, compute and lead
    // with the actual leave-by time instead of just opening Maps.
    const durationSeconds = leg.duration_in_traffic?.value ?? leg.duration?.value;
    const durationText = leg.duration_in_traffic?.text || leg.duration?.text || duration;
    if (arrivalSeconds && Number.isFinite(durationSeconds)) {
      const leaveText = formatClockTime(arrivalSeconds - durationSeconds);
      const arriveText = formatClockTime(arrivalSeconds);
      return {
        headline: durationText,
        detail: `Leave by ${leaveText}`,
        text: `Leave by ${leaveText} to arrive by ${arriveText} — about ${durationText} by ${modeLabel}.`,
        routeContext: { mode: modeLabel, duration: durationText, leaveBy: leaveText, arrival: arriveText }
      };
    }
    return {
      headline,
      detail,
      text: durationText ? `It's about ${durationText} by ${modeLabel}.` : undefined,
      routeContext: { mode: modeLabel, duration: durationText }
    };
  }

  const naturalSteps = transitSteps.slice(0, 4).map((step, index) => {
    const first = index === 0 ? 'Take' : 'Then take';
    const time = step.departure ? ` at ${step.departure}` : '';
    const arrivalText = step.arrival ? `, arriving ${step.arrival}` : '';
    const stops = Number.isFinite(Number(step.stops)) && Number(step.stops) > 0 ? ` (${step.stops} stops)` : '';
    return `${first} ${step.service}${time} from ${step.from || 'the stop'} to ${step.to || 'the destination'}${arrivalText}${stops}`;
  });
  const waits = [];
  for (let i = 1; i < transitSteps.length; i += 1) {
    const wait = minutesBetween(transitSteps[i - 1].arrivalValue, transitSteps[i].departureValue);
    if (wait) waits.push(`you have about ${wait} minutes to change before ${transitSteps[i].line}`);
  }
  const opener = departure && arrival
    ? `You should leave around ${departure}; this gets you there around ${arrival} (${duration}).`
    : `This route takes about ${duration}.`;
  const platformNote = transitSteps.some(step => /RAIL|TRAIN|HEAVY_RAIL|COMMUTER_TRAIN/i.test(step.vehicle))
    ? 'Planned routes usually do not include platform numbers this far ahead, so check the board when you reach the station.'
    : '';
  const text = [opener, naturalSteps.join('. '), waits[0] ? `On the change, ${waits[0]}.` : '', platformNote]
    .filter(Boolean)
    .join(' ');
  const itinerary = transitSteps.map(step => ({
    type: isRailStep(step) ? 'rail' : 'transit',
    service: step.service,
    line: step.line,
    from: step.from,
    to: step.to,
    departure: step.departure,
    arrival: step.arrival,
    platform: step.platform || null,
    stops: Number.isFinite(Number(step.stops)) ? Number(step.stops) : null
  }));
  return {
    headline,
    detail,
    text,
    itinerary,
    routeContext: {
      departure,
      arrival,
      duration,
      mode: modeLabel,
      firstTransitLeg: itinerary[0] || null
    }
  };
}

async function getGoogleDirections(destination, place, params = {}) {
  const key = getGoogleDirectionsKey();
  const location = params.location;
  const lat = Number(location?.latitude ?? location?.lat);
  const lng = Number(location?.longitude ?? location?.lng);
  const explicitOrigin = cleanPlaceSearchQuery(params.origin || '');
  if (!key || (!explicitOrigin && (!Number.isFinite(lat) || !Number.isFinite(lng)))) return null;

  const mode = directionModeFlag(params.mode) === 'r'
    ? 'transit'
    : directionModeFlag(params.mode) === 'w'
      ? 'walking'
      : 'driving';
  const requestParams = {
    origin: explicitOrigin || `${lat},${lng}`,
    destination: place?.formattedAddress || cleanPlaceSearchQuery(destination),
    mode,
    alternatives: true,
    region: 'gb',
    key
  };
  const arrival = parseDirectionTime(params.arrival_time);
  const departure = parseDirectionTime(params.departure_time);
  if (mode === 'transit') {
    if (arrival) requestParams.arrival_time = arrival;
    else if (departure) requestParams.departure_time = departure;
  } else if (mode === 'driving') {
    // The Directions API ignores arrival_time for driving, so request a
    // traffic-aware duration (which needs a departure_time) and compute the
    // leave time ourselves from the requested arrival.
    requestParams.departure_time = departure || arrival || 'now';
  }

  const response = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
    params: requestParams,
    timeout: 10000
  });
  if (response.data?.status !== 'OK' || !response.data.routes?.length) return null;
  return summarizeDirectionsRoute(response.data.routes[0], mode, arrival);
}

function isPlacesSetupError(err) {
  return /Google Places|Places API|GOOGLE_MAPS_API_KEY|PERMISSION_DENIED|REQUEST_DENIED/i.test(String(err?.message || err || ''));
}

async function execute(userId, action, params) {
  try {
    if (action === 'plan_trip') {
      const destination = String(params?.destination || params?.query || '').trim();
      if (!destination) return { success: false, error: 'plan_trip requires a destination' };
      return await planTrip(destination, params || {});
    }

    if (action === 'get_directions') {
      const destination = String(params?.destination || params?.query || '').trim();
      if (!destination) return { success: false, error: 'get_directions requires a destination' };
      // Transit/bus journeys go through the robust multi-leg planner — the single-route
      // directions path returns degenerate summaries like "7 mins by transit" for a
      // 1-hour bus trip (it falls back to a tiny walking leg). plan_trip does rail/bus
      // alternatives + sane scoring, so a bus ask gets the real itinerary first time.
      if (directionModeFlag(params.mode) === 'r') {
        const result = await planTrip(destination, params || {});
        // planTrip is an implementation detail here — relabel so the card reads
        // "Directions ready" not "Trip planned" for a simple commute query.
        if (result.actionSummary === 'Trip planned') result.actionSummary = 'Directions ready';
        return result;
      }
      let place = null;
      try {
        place = await resolvePlaceDestination(destination, { location: params.location });
      } catch (err) {
        if (isPlacesSetupError(err)) return mapsDirectionsFallback(destination, params);
        return mapsDirectionsFallback(destination, params);
      }
      const flag = directionModeFlag(params.mode);
      const modeLabel = flag === 'r' ? 'transit' : flag === 'w' ? 'walking' : 'driving';
      const route = await getGoogleDirections(destination, place, params).catch(err => {
        console.warn('[maps] Google Directions failed:', err.message);
        return null;
      });
      const link = place?.googleMapsUri
        ? `https://maps.apple.com/?${params.origin ? `saddr=${encodeURIComponent(params.origin)}&` : ''}daddr=${encodeURIComponent(place.formattedAddress || destination)}&dirflg=${flag}`
        : `https://maps.apple.com/?${params.origin ? `saddr=${encodeURIComponent(params.origin)}&` : ''}daddr=${encodeURIComponent(destination)}&dirflg=${flag}`;
      const label = placeLabel(place, destination);
      const routeText = route?.text || (route?.headline ? `${route.headline}: ${route.detail}` : flag === 'r'
        ? `I couldn't get a reliable transit route summary to ${label} right now.`
        : `${modeLabel[0].toUpperCase()}${modeLabel.slice(1)} directions to ${label} are ready.`);
      return {
        success: true,
        text: routeText,
        deepLink: route ? link : (flag === 'r' ? undefined : link),
        webLink: route ? link : (flag === 'r' ? undefined : link),
        actionSummary: route || flag !== 'r' ? 'Directions ready' : 'Route unavailable',
        cardText: route?.detail || (flag === 'r' ? 'No transit route summary available' : `Open ${modeLabel} directions in Maps`),
        itinerary: route?.itinerary,
        routeContext: route?.routeContext || {
          origin: params.origin || 'current location',
          destination: label,
          mode: modeLabel,
          reason: 'route_summary_unavailable'
        }
      };
    }

    if (action !== 'find_place') return { success: false, error: `Unknown action: ${action}` };

    const query = String(params?.query || params?.destination || '').trim();
    if (!query) return { success: false, error: 'find_place requires a query' };

    let place;
    try {
      place = await resolvePlaceDestination(query, { location: params.location });
    } catch (err) {
      if (isPlacesSetupError(err)) return mapsSearchFallback(query, err);
      throw err;
    }
    const label = placeLabel(place, query);
    const distance = distanceLabel(place.distanceMeters);
    const address = shortAddress(place.formattedAddress || '');
    const detail = [address, distance].filter(Boolean).join(' · ');

    return {
      success: true,
      text: `I found ${label}${distance ? `, ${distance}` : ''}.`,
      name: place.name || '',
      address: place.formattedAddress || '',
      distanceMeters: place.distanceMeters ?? null,
      deepLink: mapsLink(place, query),
      webLink: mapsLink(place, query),
      cardText: detail || 'Open in Maps'
    };
  } catch (err) {
    return { success: false, error: `Maps error: ${err.message}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute, chooseBestTripRoute, scoreTripRoute };

const axios = require('axios');
const { resolvePlaceDestination, cleanPlaceSearchQuery } = require('../api/geocoding');
const { getGoogleDirectionsKey } = require('../api/services/maps-config');

const SUPPORTED_ACTIONS = ['find_place', 'get_directions'];

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
  return {
    success: true,
    text: `${modeLabel[0].toUpperCase()}${modeLabel.slice(1)} directions to ${cleanedDestination} are ready.`,
    actionSummary: 'Directions ready',
    cardText: `Open ${modeLabel} directions in Maps`,
    deepLink: link,
    webLink: link
  };
}

function parseDirectionTime(value, now = new Date()) {
  const text = String(value || '').trim();
  if (!text) return null;
  const tomorrow = /\btomorrow\b/i.test(text);
  const match = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
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

function minutesBetween(a, b) {
  const start = Number(a);
  const end = Number(b);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const mins = Math.round((end - start) / 60);
  return mins > 7 ? mins : null;
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
    text: [line, from && `from ${from}`, to && `to ${to}`].filter(Boolean).join(' ')
  };
}

function summarizeDirectionsRoute(route, modeLabel) {
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
  if (!transitSteps.length) return { headline, detail };

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
  return { headline, detail, text };
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
    key
  };
  const arrival = parseDirectionTime(params.arrival_time);
  const departure = parseDirectionTime(params.departure_time);
  if (arrival && mode === 'transit') requestParams.arrival_time = arrival;
  if (!arrival && departure && mode === 'transit') requestParams.departure_time = departure;

  const response = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
    params: requestParams,
    timeout: 10000
  });
  if (response.data?.status !== 'OK' || !response.data.routes?.length) return null;
  return summarizeDirectionsRoute(response.data.routes[0], mode);
}

function isPlacesSetupError(err) {
  return /Google Places|Places API|GOOGLE_MAPS_API_KEY|PERMISSION_DENIED|REQUEST_DENIED/i.test(String(err?.message || err || ''));
}

async function execute(userId, action, params) {
  try {
    if (action === 'get_directions') {
      const destination = String(params?.destination || params?.query || '').trim();
      if (!destination) return { success: false, error: 'get_directions requires a destination' };
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
      const routeText = route?.text || (route?.headline ? `${route.headline}: ${route.detail}` : `${modeLabel[0].toUpperCase()}${modeLabel.slice(1)} directions to ${label} are ready.`);
      return {
        success: true,
        text: routeText,
        deepLink: link,
        webLink: link,
        actionSummary: 'Directions ready',
        cardText: route?.detail || `Open ${modeLabel} directions in Maps`
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

module.exports = { SUPPORTED_ACTIONS, execute };

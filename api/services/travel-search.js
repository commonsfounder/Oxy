'use strict';

// Real flight and hotel search — replacing two actions that only ever built a deep link and
// reported success.
//
// Why this route. There is no flight/hotel API credential in this environment (no Amadeus,
// Duffel, Kiwi or SerpApi key), and the partner APIs that would give bookable inventory all
// require an account this project does not have. Browser automation against Google Flights or
// Booking.com is the known anti-bot ceiling in this codebase. What IS available and genuinely
// current is the real web-search grounding already used by plan_itinerary and gift research —
// so that is the source, and the honesty of the output is calibrated to exactly what it can
// support.
//
// It runs in two stages because one does not work: asking the grounded search to "return only
// JSON" makes it skip searching and return an empty array (measured, repeatedly). So stage one
// searches and reports in prose, and stage two — a plain call with NO search tool — converts
// only that prose into structured options. The extractor cannot invent an option that is not
// in the text it was given.
//
// What this can and cannot claim:
//   CAN: "easyJet, direct, £133 return, quoted on Google Flights for 5–7 September" — a real
//        price a real site really showed at search time.
//   CANNOT: bookability, availability, or that the price still holds. Search results routinely
//        quote a nearby date range rather than the exact one asked for, so every option
//        carries whether it actually matches the requested dates, and the two groups are
//        never mixed into one "cheapest" claim.

const MAX_OPTIONS = 12;
const EXTRACTION_TOKENS = 4000;

function clean(value, max = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function toNumber(value) {
  const num = Number(String(value ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(num) && num > 0 ? num : null;
}

function describeDates(depart, ret) {
  if (depart && ret) return `departing ${depart} and returning ${ret}`;
  if (depart) return `departing ${depart}`;
  return 'on flexible dates';
}

// ── Stage 1: the real search ───────────────────────────────────────────────────────────

function buildFlightResearchPrompt({ from, to, departDate, returnDate, adults = 1, notes = '', maxPrice, directOnly, today }) {
  // Constraints belong in the SEARCH, not only in the filter afterwards: searching for
  // "cheapest direct under £150" surfaces different results than searching generically and
  // then discarding most of them.
  const wants = [
    directOnly ? 'They only want direct/nonstop flights' : '',
    maxPrice ? `They want to stay under ${maxPrice} in total` : ''
  ].filter(Boolean).join('. ');
  return `Today is ${today}. Search the web NOW for real, current flight options from ${from} to ${to}, ${describeDates(departDate, returnDate)}, ${adults} adult${adults === 1 ? '' : 's'}.${wants ? ` ${wants}.` : ''}${notes ? ` The traveller also said: ${notes}.` : ''}

Report exactly what the search results show, and nothing more:
- which airlines fly this route and whether each option is direct/nonstop or connecting
- every specific price you can actually see, with the currency, whether it is one-way or return, the site that quoted it, and the exact dates that price applies to
- state clearly, for each price, whether it applies to the requested dates or to different dates
- typical journey duration if the results state it

Never invent a flight number, an exact departure time, or a price. If the results only give indicative "from £X" figures rather than prices for these dates, say so plainly.`;
}

function buildHotelResearchPrompt({ location, checkIn, checkOut, guests = 2, maxNightly, area, notes = '', today }) {
  return `Today is ${today}. Search the web NOW for real, current hotel options in ${location}${area ? `, specifically ${area}` : ''}${checkIn ? `, checking in ${checkIn}${checkOut ? ` and out ${checkOut}` : ''}` : ''}, for ${guests} guest${guests === 1 ? '' : 's'}.${maxNightly ? ` The traveller wants to stay under ${maxNightly} per night.` : ''}${notes ? ` They also said: ${notes}.` : ''}

Report exactly what the search results show, and nothing more:
- named properties, with the area/neighbourhood they are in and how central they are if stated
- every specific nightly or total price you can actually see, with currency, the site that quoted it, and the exact dates it applies to
- state clearly, for each price, whether it applies to the requested dates or to different dates
- guest rating or star rating if the results state it
- whether availability for those dates is actually stated anywhere

Never invent a property, a price, or availability. If the results only give indicative "from £X" figures, say so plainly.`;
}

// ── Stage 2: structure only what the search actually said ──────────────────────────────

const FLIGHT_SHAPE = '{"airline":"","stops":0,"durationMinutes":null,"priceAmount":0,"priceCurrency":"GBP","priceBasis":"return|one_way","quotedFor":"the exact dates/conditions this price applies to","matchesRequestedDates":true,"source":"the site that showed it","sourceUrl":"","caveat":""}';
const HOTEL_SHAPE = '{"name":"","area":"","rating":null,"pricePerNight":0,"totalPrice":null,"priceCurrency":"GBP","quotedFor":"the exact dates this price applies to","matchesRequestedDates":true,"availabilityStated":false,"source":"the site that showed it","sourceUrl":"","caveat":""}';

function buildExtractionPrompt(kind, research, { departDate, returnDate, checkIn, checkOut } = {}) {
  const requested = kind === 'flights'
    ? describeDates(departDate, returnDate)
    : (checkIn ? `${checkIn}${checkOut ? ` to ${checkOut}` : ''}` : 'the requested dates');
  return `Below is the result of a real web search. Convert it into JSON.

Use ONLY what the text states. Never add an option, a price, a property or an airline that is not in the text. Never invent a flight number or an exact time.

Return ONLY a JSON array, one element per option the text genuinely reports:
[${kind === 'flights' ? FLIGHT_SHAPE : HOTEL_SHAPE}]

Rules:
- Drop any option with no stated price — an option with no price is not a search result.
- matchesRequestedDates: true ONLY if the text says the price applies to ${requested}. If the text says the price is for different dates, or is an indicative "from" figure, set it to false.
- ${kind === 'flights' ? 'stops: 0 for direct/nonstop, the stated number if connecting, null if the text does not say.' : 'availabilityStated: true only if the text actually says rooms are available for those dates.'}
- caveat: copy any warning the source itself gave (fare conditions, "prices may change", baggage extra).
- If the text reports nothing usable, return [].

SEARCH RESULT:
${research}`;
}

function parseTravelResults(kind, rawText) {
  const match = String(rawText || '').match(/\[[\s\S]*\]/);
  if (!match) return [];
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const options = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const source = clean(entry.source, 120);
    if (!source) continue;

    if (kind === 'flights') {
      const price = toNumber(entry.priceAmount);
      const airline = clean(entry.airline, 80);
      // No price or no airline means it is not an option, it is a sentence.
      if (!price || !airline) continue;
      options.push({
        kind: 'flight',
        airline,
        stops: Number.isInteger(entry.stops) ? entry.stops : null,
        durationMinutes: Number.isFinite(entry.durationMinutes) ? entry.durationMinutes : null,
        price,
        currency: clean(entry.priceCurrency, 8).toUpperCase() || 'GBP',
        priceBasis: /one/i.test(String(entry.priceBasis)) ? 'one_way' : 'return',
        quotedFor: clean(entry.quotedFor, 160),
        matchesRequestedDates: entry.matchesRequestedDates === true,
        source,
        sourceUrl: clean(entry.sourceUrl, 400) || null,
        caveat: clean(entry.caveat, 240) || null
      });
    } else {
      const nightly = toNumber(entry.pricePerNight);
      const total = toNumber(entry.totalPrice);
      const name = clean(entry.name, 120);
      if (!name || (!nightly && !total)) continue;
      options.push({
        kind: 'hotel',
        name,
        area: clean(entry.area, 120) || null,
        rating: Number.isFinite(entry.rating) ? entry.rating : null,
        pricePerNight: nightly,
        totalPrice: total,
        currency: clean(entry.priceCurrency, 8).toUpperCase() || 'GBP',
        quotedFor: clean(entry.quotedFor, 160),
        matchesRequestedDates: entry.matchesRequestedDates === true,
        availabilityStated: entry.availabilityStated === true,
        source,
        sourceUrl: clean(entry.sourceUrl, 400) || null,
        caveat: clean(entry.caveat, 240) || null
      });
    }
    if (options.length >= MAX_OPTIONS) break;
  }
  return options;
}

// ── Constraints ────────────────────────────────────────────────────────────────────────

// Hard filters the user actually stated. Applied AFTER extraction so a dropped option is
// dropped for a stated reason, and the count of what was dropped can be reported.
function applyConstraints(options = [], { maxPrice, directOnly, maxStops, minRating } = {}) {
  const dropped = [];
  const kept = options.filter(option => {
    const price = option.kind === 'flight' ? option.price : (option.pricePerNight || option.totalPrice);
    if (maxPrice && price && price > maxPrice) { dropped.push({ option, why: `over ${maxPrice}` }); return false; }
    if (option.kind === 'flight') {
      if (directOnly && option.stops !== 0) { dropped.push({ option, why: 'not direct' }); return false; }
      if (Number.isFinite(maxStops) && option.stops !== null && option.stops > maxStops) {
        dropped.push({ option, why: `more than ${maxStops} stop${maxStops === 1 ? '' : 's'}` });
        return false;
      }
    } else if (minRating && option.rating !== null && option.rating < minRating) {
      dropped.push({ option, why: `rated below ${minRating}` });
      return false;
    }
    return true;
  });
  return { kept, dropped };
}

// travel-ranking.js has always expected these field names (it was written for an Amadeus
// connector that never existed here, which is why it sat orphaned). Mapping to its shape is
// what finally makes it real rather than rewriting it.
function toRankingShape(option) {
  return option.kind === 'flight'
    ? { ...option, totalPrice: option.price, stops: option.stops ?? 1 }
    : { ...option, totalPrice: option.totalPrice ?? option.pricePerNight, pricePerNight: option.pricePerNight, rating: option.rating };
}

// ── Honest formatting ──────────────────────────────────────────────────────────────────

function money(amount, currency) {
  const symbol = { GBP: '£', USD: '$', EUR: '€' }[currency];
  return symbol ? `${symbol}${Number(amount).toFixed(0)}` : `${Number(amount).toFixed(0)} ${currency}`;
}

function describeFlight(option) {
  const stops = option.stops === 0 ? 'direct' : option.stops === null ? 'stops not stated' : `${option.stops} stop${option.stops === 1 ? '' : 's'}`;
  const basis = option.priceBasis === 'one_way' ? 'one-way' : 'return';
  const duration = option.durationMinutes ? `, ${Math.floor(option.durationMinutes / 60)}h ${option.durationMinutes % 60}m` : '';
  return `${option.airline}, ${stops}${duration} — ${money(option.price, option.currency)} ${basis} (${option.source}${option.quotedFor ? `, quoted for ${option.quotedFor}` : ''})`;
}

function describeHotel(option) {
  const price = option.pricePerNight
    ? `${money(option.pricePerNight, option.currency)}/night`
    : `${money(option.totalPrice, option.currency)} total`;
  const rating = option.rating ? `, rated ${option.rating}` : '';
  const area = option.area ? `, ${option.area}` : '';
  return `${option.name}${area}${rating} — ${price} (${option.source}${option.quotedFor ? `, quoted for ${option.quotedFor}` : ''})`;
}

// The distinction that keeps this honest: options priced for the dates asked about, versus
// indicative prices for other dates. They are never merged into one "cheapest" claim.
function formatTravelResults(kind, options = [], { dropped = [], searched = '', constraintNote = '', researchFound = true } = {}) {
  if (!options.length) {
    // "The search found nothing" and "the search found pages but none of them stated a price
    // I could attribute to a source" are different facts, and the second one is the common
    // one. Collapsing them into one sentence would misdescribe what actually happened.
    const why = !researchFound
      ? `the search turned up nothing usable for ${searched}`
      : `the search found information about ${searched}, but no specific price I could attribute to a source`;
    return `I looked, and ${why}.${dropped.length ? ` Separately, ${dropped.length} option${dropped.length === 1 ? ' was' : 's were'} ruled out: ${[...new Set(dropped.map(d => d.why))].join(', ')}.` : ''} This was a web search, not a live booking system — the ${kind === 'flights' ? 'airline' : 'hotel'}'s own site will give you live prices and availability.`;
  }

  const describe = kind === 'flights' ? describeFlight : describeHotel;
  const onDates = options.filter(o => o.matchesRequestedDates);
  const indicative = options.filter(o => !o.matchesRequestedDates);

  const parts = [];
  if (onDates.length) {
    parts.push(`For ${searched}: ${onDates.map(describe).join('; ')}.`);
  }
  if (indicative.length) {
    parts.push(`${onDates.length ? 'Also found, but ' : 'Nothing was priced for exactly those dates. What I did find is '}priced for other dates or as indicative "from" fares: ${indicative.map(describe).join('; ')}.`);
  }
  if (constraintNote) parts.push(constraintNote);
  if (dropped.length) {
    parts.push(`${dropped.length} option${dropped.length === 1 ? '' : 's'} ruled out for not matching what you asked (${[...new Set(dropped.map(d => d.why))].join(', ')}).`);
  }
  // The caveat that has to travel with every one of these numbers.
  parts.push('These are prices observed in search results just now, not held quotes — availability and price are only confirmed on the airline or hotel\'s own site, and I have not checked whether any of them can actually be booked.');
  return parts.join(' ');
}

module.exports = {
  MAX_OPTIONS,
  EXTRACTION_TOKENS,
  buildFlightResearchPrompt,
  buildHotelResearchPrompt,
  buildExtractionPrompt,
  parseTravelResults,
  applyConstraints,
  toRankingShape,
  describeFlight,
  describeHotel,
  formatTravelResults
};

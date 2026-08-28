'use strict';

// Flight and hotel search grounded in real web search — the fallback for when no inventory
// provider is configured (see travel-inventory.js), since browser automation against the big
// travel sites is a known anti-bot ceiling here.
//
// Two stages, because one does not work: asking a grounded search for JSON only makes it skip
// searching and return an empty array. So stage one searches and answers in prose, and stage
// two — no search tool attached — converts only that prose into options, and so cannot invent
// one that was never found.
//
// It can claim a real price a real site showed at search time. It cannot claim bookability,
// availability, or that the price holds — and since results often quote a nearby date range,
// every option records whether it matches the dates asked for, and the two groups are never
// mixed into one "cheapest".

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

// observedStart/observedEnd are the dates the SOURCE actually quoted, in ISO form where the
// text gives enough to know them. They are what makes "£133 for 17–20 September" checkable
// against a request for 18–21 September, instead of relying on the extractor's own opinion.
const FLIGHT_SHAPE = '{"airline":"","stops":0,"durationMinutes":null,"priceAmount":0,"priceCurrency":"GBP","priceBasis":"return|one_way","quotedFor":"the exact dates/conditions this price applies to","observedStart":"YYYY-MM-DD the source quoted, or null","observedEnd":"YYYY-MM-DD the source quoted, or null","matchesRequestedDates":true,"source":"the site that showed it","sourceUrl":"","caveat":""}';
const HOTEL_SHAPE = '{"name":"","area":"","rating":null,"pricePerNight":0,"totalPrice":null,"priceCurrency":"GBP","quotedFor":"the exact dates this price applies to","observedStart":"YYYY-MM-DD check-in the source quoted, or null","observedEnd":"YYYY-MM-DD check-out the source quoted, or null","matchesRequestedDates":true,"availabilityStated":false,"source":"the site that showed it","sourceUrl":"","caveat":""}';

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
- observedStart/observedEnd: the dates the SOURCE quoted the price for, as YYYY-MM-DD, whenever the text makes them knowable. Use null when it genuinely does not say. Do NOT copy the requested dates here — these are what the source said.
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
        observedStart: clean(entry.observedStart, 30) || null,
        observedEnd: clean(entry.observedEnd, 30) || null,
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
        observedStart: clean(entry.observedStart, 30) || null,
        observedEnd: clean(entry.observedEnd, 30) || null,
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

// ── Date provenance ────────────────────────────────────────────────────────────────────

function isoDay(value) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? '').trim());
  return match ? match[1] : null;
}

// The verdict is recomputed from the observed dates whenever they are known, rather than
// trusted from the extractor. A £133 fare quoted for 17–20 September does not satisfy a
// request for 18–21 September, and saying it does is the specific failure this exists to stop.
// Returns 'exact' (the source quoted these dates), 'adjacent' (it quoted different ones), or
// 'unknown' (the source never said, so nothing can be claimed either way).
function gradeDateMatch(option = {}, requested = {}) {
  const wantStart = isoDay(requested.start);
  const wantEnd = isoDay(requested.end);
  const gotStart = isoDay(option.observedStart);
  const gotEnd = isoDay(option.observedEnd);

  if (!wantStart) return option.matchesRequestedDates ? 'exact' : 'unknown';
  if (!gotStart) {
    // The source did not say. The extractor's claim alone is not enough to call it exact —
    // "unknown" is the honest grade, and it is reported separately from a verified match.
    return 'unknown';
  }
  if (gotStart !== wantStart) return 'adjacent';
  if (wantEnd && gotEnd && gotEnd !== wantEnd) return 'adjacent';
  return 'exact';
}

function daysApart(a, b) {
  const left = isoDay(a);
  const right = isoDay(b);
  if (!left || !right) return null;
  return Math.round(Math.abs(Date.parse(left) - Date.parse(right)) / 86400000);
}

// Attaches the grade and, for anything not exact, how far off it actually is — which is what
// makes "the closest sourced fare I found was £133 for 17–20 September" possible.
function applyDateProvenance(options = [], requested = {}) {
  return options.map(option => {
    const grade = gradeDateMatch(option, requested);
    const offBy = grade === 'adjacent' ? daysApart(option.observedStart, requested.start) : null;
    return {
      ...option,
      requestedStart: isoDay(requested.start),
      requestedEnd: isoDay(requested.end),
      dateMatch: grade,
      // Only a verified exact match may claim to satisfy the request.
      matchesRequestedDates: grade === 'exact',
      offByDays: offBy
    };
  });
}

// ── Currency ───────────────────────────────────────────────────────────────────────────

// Numbers in different currencies are never compared or summed. With no FX source configured,
// the honest move is to keep them apart and say so — not to apply a rate nobody supplied.
function groupByCurrency(options = []) {
  const groups = new Map();
  for (const option of options) {
    const currency = option.currency || 'UNKNOWN';
    if (!groups.has(currency)) groups.set(currency, []);
    groups.get(currency).push(option);
  }
  return groups;
}

function cheapestPerCurrency(options = []) {
  const out = [];
  for (const [currency, group] of groupByCurrency(options)) {
    const priced = group.filter(o => Number.isFinite(o.price ?? o.pricePerNight ?? o.totalPrice));
    if (!priced.length) continue;
    out.push(priced.reduce((best, o) => {
      const value = (x) => x.price ?? x.pricePerNight ?? x.totalPrice;
      return value(o) < value(best) ? o : best;
    }));
  }
  return out;
}

// ── Constraints ────────────────────────────────────────────────────────────────────────

// Hard filters the user actually stated. Applied AFTER extraction so a dropped option is
// dropped for a stated reason, and the count of what was dropped can be reported.
function applyConstraints(options = [], { maxPrice, maxPriceCurrency, directOnly, maxStops, minRating, guests, nights } = {}) {
  const dropped = [];
  const kept = options.filter(option => {
    const price = option.kind === 'flight' ? option.price : (option.pricePerNight || option.totalPrice);
    // A budget is in a currency, and with no FX source configured, comparing "under £150" to a
    // $179 fare would silently apply a 1:1 rate. Dropping other currencies loses real options
    // wholesale, so they are kept and flagged as unchecked against the budget instead.
    const otherCurrency = Boolean(maxPrice && price && maxPriceCurrency && option.currency && option.currency !== maxPriceCurrency);
    if (otherCurrency) {
      option.budgetCheckable = false;
      return true;
    }
    if (maxPrice && price) option.budgetCheckable = true;
    if (maxPrice && price && price > maxPrice) { dropped.push({ option, why: `over ${maxPrice}` }); return false; }
    if (Number.isFinite(guests) && Number.isFinite(option.guests) && option.guests < guests) {
      dropped.push({ option, why: `only sleeps ${option.guests}` });
      return false;
    }
    if (Number.isFinite(nights) && Number.isFinite(option.nights) && option.nights !== nights) {
      dropped.push({ option, why: `priced for ${option.nights} nights, not ${nights}` });
      return false;
    }
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
  // A Duffel total is for the whole party, never per person — said explicitly whenever there
  // is more than one passenger, so a 4-passenger total is never misread as one person's fare.
  const forParty = option.priceIsTotal && option.passengers > 1 ? ` total for ${option.passengers} passengers` : '';
  return `${option.airline}, ${stops}${duration} — ${money(option.price, option.currency)} ${basis}${forParty} (${option.source}${option.quotedFor ? `, quoted for ${option.quotedFor}` : ''})`;
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
function describeAdjacent(option, kind) {
  const describe = kind === 'flights' ? describeFlight : describeHotel;
  const when = option.observedStart
    ? `${option.observedStart}${option.observedEnd ? ` to ${option.observedEnd}` : ''}`
    : option.quotedFor || 'other dates';
  const off = Number.isFinite(option.offByDays) && option.offByDays > 0
    ? `, ${option.offByDays} day${option.offByDays === 1 ? '' : 's'} off`
    : '';
  return `${describe(option)} [for ${when}${off}]`;
}

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
  // Three genuinely different things, never merged: prices the source quoted FOR these dates,
  // prices it quoted for other dates, and prices where it never said which dates apply.
  const exact = options.filter(o => o.dateMatch === 'exact' || (!o.dateMatch && o.matchesRequestedDates));
  const adjacent = options.filter(o => o.dateMatch === 'adjacent');
  const unknown = options.filter(o => o.dateMatch === 'unknown' || (!o.dateMatch && !o.matchesRequestedDates));

  const parts = [];
  if (exact.length) {
    parts.push(`For ${searched}: ${exact.map(describe).join('; ')}.`);
  } else {
    // The sentence the whole feature turns on. Never let an adjacent fare stand in for one.
    const closest = [...adjacent].sort((a, b) => (a.offByDays ?? 99) - (b.offByDays ?? 99))[0];
    parts.push(closest
      ? `I couldn't verify a priced result for ${searched}. The closest sourced one I found was ${describeAdjacent(closest, kind)}.`
      : `I couldn't verify a priced result for ${searched}.`);
  }
  if (adjacent.length && exact.length) {
    parts.push(`Also found, priced for DIFFERENT dates: ${adjacent.map(o => describeAdjacent(o, kind)).join('; ')}.`);
  } else if (adjacent.length > 1) {
    parts.push(`Other sourced prices, all for different dates: ${adjacent.slice(1).map(o => describeAdjacent(o, kind)).join('; ')}.`);
  }
  if (unknown.length) {
    parts.push(`These had a price but the source never said which dates it applies to: ${unknown.map(describe).join('; ')}.`);
  }

  // Mixed currencies are stated, never converted.
  const currencies = [...new Set(options.map(o => o.currency).filter(Boolean))];
  if (currencies.length > 1) {
    parts.push(`Prices are in ${currencies.join(' and ')} — I have not converted between them, so they are not directly comparable.`);
  }
  const uncheckable = options.filter(o => o.budgetCheckable === false);
  if (uncheckable.length) {
    parts.push(`${uncheckable.length} of these ${uncheckable.length === 1 ? 'is' : 'are'} priced in a different currency from your budget, so I could not check ${uncheckable.length === 1 ? 'it' : 'them'} against it.`);
  }
  if (constraintNote) parts.push(constraintNote);
  if (dropped.length) {
    parts.push(`${dropped.length} option${dropped.length === 1 ? '' : 's'} ruled out for not matching what you asked (${[...new Set(dropped.map(d => d.why))].join(', ')}).`);
  }
  // The caveat that has to travel with every one of these numbers — but not the SAME caveat
  // for all of them. An inventory offer really is a live, sellable price from a booking system
  // (and really does expire); calling it "not a held quote" right alongside the honest web-page
  // caveat would flatten a distinction the rest of this file exists to preserve.
  const fromInventory = options.filter(o => o.inventory === true);
  const fromWeb = options.length - fromInventory.length;
  if (fromInventory.length) {
    parts.push(`${fromInventory.length} of these ${fromInventory.length === 1 ? 'is a' : 'are'} real, sellable ${fromInventory.length === 1 ? 'price' : 'prices'} from live inventory — held only until the offer expires, not indefinitely, and still requires actually booking.`);
  }
  if (fromWeb > 0) {
    parts.push(`${fromInventory.length ? 'The rest are' : 'These are'} prices observed in search results just now, not held quotes — availability and price are only confirmed on the airline or hotel's own site, and I have not checked whether any of them can actually be booked.`);
  }
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
  gradeDateMatch,
  applyDateProvenance,
  groupByCurrency,
  cheapestPerCurrency,
  toRankingShape,
  describeFlight,
  describeHotel,
  describeAdjacent,
  formatTravelResults
};

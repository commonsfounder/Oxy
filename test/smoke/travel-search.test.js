// Real travel search (api/services/travel-search.js). These tests cover the parsing,
// constraint and honesty rules; the live-external-data verification is separate, because a
// test suite cannot assert on today's actual flight prices.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
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
  formatTravelResults
} = require('../../api/services/travel-search');
const { rankFlights, rankHotels } = require('../../api/services/travel-ranking');

const FLIGHT_JSON = JSON.stringify([
  { airline: 'easyJet', stops: 0, durationMinutes: 125, priceAmount: 133, priceCurrency: 'GBP', priceBasis: 'return', quotedFor: '15–18 September 2026', matchesRequestedDates: true, source: 'Google Flights', sourceUrl: 'https://example.com/gf', caveat: 'Baggage extra' },
  { airline: 'Lufthansa', stops: 1, priceAmount: 202, priceCurrency: 'GBP', priceBasis: 'return', quotedFor: '3–6 September 2026', matchesRequestedDates: false, source: 'Google Flights' },
  { airline: 'Ryanair', stops: 1, priceAmount: 46, priceCurrency: 'GBP', priceBasis: 'one_way', quotedFor: '15 September 2026', matchesRequestedDates: true, source: 'KAYAK' }
]);

const HOTEL_JSON = JSON.stringify([
  { name: 'The Bath Townhouse', area: 'city centre', rating: 4.4, pricePerNight: 128, priceCurrency: 'GBP', quotedFor: '12–14 September 2026', matchesRequestedDates: true, availabilityStated: true, source: 'Booking.com' },
  { name: 'Riverside Inn', area: '1.5km from centre', rating: 3.9, pricePerNight: 95, priceCurrency: 'GBP', quotedFor: 'from-price, no dates', matchesRequestedDates: false, availabilityStated: false, source: 'Hotels.com' }
]);

// ── Parsing refuses anything that is not actually a result ─────────────────────────────
test('a flight option with no price is not an option', () => {
  const parsed = parseTravelResults('flights', JSON.stringify([
    { airline: 'easyJet', stops: 0, priceAmount: 0, source: 'Google Flights' },
    { airline: 'easyJet', stops: 0, priceAmount: 133, priceCurrency: 'GBP', source: 'Google Flights' }
  ]));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].price, 133);
});

test('an option with no source is dropped — an unattributable price is not evidence', () => {
  const parsed = parseTravelResults('flights', JSON.stringify([
    { airline: 'easyJet', stops: 0, priceAmount: 133, priceCurrency: 'GBP', source: '' }
  ]));
  assert.equal(parsed.length, 0);
});

test('a hotel with neither a nightly nor a total price is dropped', () => {
  const parsed = parseTravelResults('hotels', JSON.stringify([
    { name: 'Somewhere Nice', source: 'Booking.com' },
    { name: 'The Bath Townhouse', pricePerNight: 128, priceCurrency: 'GBP', source: 'Booking.com' }
  ]));
  assert.deepEqual(parsed.map(h => h.name), ['The Bath Townhouse']);
});

test('unparseable output yields nothing rather than a fabricated result', () => {
  assert.deepEqual(parseTravelResults('flights', 'I could not find any flights, sorry.'), []);
  assert.deepEqual(parseTravelResults('flights', '[not json'), []);
});

test('date matching is only ever true when the extractor said so', () => {
  const parsed = parseTravelResults('flights', FLIGHT_JSON);
  assert.deepEqual(parsed.map(f => f.matchesRequestedDates), [true, false, true]);
  // Anything ambiguous defaults to "not for these dates" — the safe direction.
  const vague = parseTravelResults('flights', JSON.stringify([
    { airline: 'easyJet', stops: 0, priceAmount: 99, priceCurrency: 'GBP', source: 'KAYAK' }
  ]));
  assert.equal(vague[0].matchesRequestedDates, false);
});

test('stops are preserved exactly, including "not stated"', () => {
  const parsed = parseTravelResults('flights', JSON.stringify([
    { airline: 'A', stops: 0, priceAmount: 100, priceCurrency: 'GBP', source: 'S' },
    { airline: 'B', stops: 2, priceAmount: 100, priceCurrency: 'GBP', source: 'S' },
    { airline: 'C', stops: 'unknown', priceAmount: 100, priceCurrency: 'GBP', source: 'S' }
  ]));
  assert.deepEqual(parsed.map(f => f.stops), [0, 2, null]);
});

// ── Constraints ────────────────────────────────────────────────────────────────────────
test('a stated budget removes what is over it, and says what it removed', () => {
  const { kept, dropped } = applyConstraints(parseTravelResults('flights', FLIGHT_JSON), { maxPrice: 150 });
  assert.deepEqual(kept.map(f => f.airline), ['easyJet', 'Ryanair']);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].why, /over 150/);
});

test('"direct only" excludes connections, including ones with unstated stops', () => {
  const { kept } = applyConstraints(parseTravelResults('flights', JSON.stringify([
    { airline: 'easyJet', stops: 0, priceAmount: 133, priceCurrency: 'GBP', source: 'S' },
    { airline: 'KLM', stops: 1, priceAmount: 175, priceCurrency: 'GBP', source: 'S' },
    { airline: 'Unknown', stops: 'unclear', priceAmount: 120, priceCurrency: 'GBP', source: 'S' }
  ])), { directOnly: true });
  assert.deepEqual(kept.map(f => f.airline), ['easyJet']);
});

test('a hotel nightly ceiling and a rating floor both apply', () => {
  const hotels = parseTravelResults('hotels', HOTEL_JSON);
  assert.equal(applyConstraints(hotels, { maxPrice: 100 }).kept.length, 1);
  assert.equal(applyConstraints(hotels, { minRating: 4 }).kept.length, 1);
});

// ── Ranking is genuinely wired ─────────────────────────────────────────────────────────
test('travel-ranking scores real parsed flights, and direct beats a cheap connection when asked', () => {
  const flights = parseTravelResults('flights', FLIGHT_JSON).map(toRankingShape);
  const ranked = rankFlights(flights, {}, { budget: '400', constraints: ['direct_or_fewest_changes'] });
  assert.ok(ranked.every(f => Number.isFinite(f.score)), 'every option must actually be scored');
  assert.equal(ranked[0].airline, 'easyJet', 'the direct flight should win when direct was requested');
  // Without that constraint the cheap connection is no longer penalised as heavily.
  const neutral = rankFlights(flights, {}, { budget: '400', constraints: [] });
  assert.ok(neutral.find(f => f.airline === 'Ryanair').score > 0);
});

test('travel-ranking scores real parsed hotels against a stated budget', () => {
  const hotels = parseTravelResults('hotels', HOTEL_JSON).map(toRankingShape);
  const ranked = rankHotels(hotels, {}, { budget: '120' });
  assert.ok(ranked.every(h => Number.isFinite(h.score)));
  assert.equal(ranked[0].name, 'Riverside Inn', 'the one inside budget should outrank the one over it');
});

// ── Honest output ──────────────────────────────────────────────────────────────────────
test('every result set carries the observed-not-bookable caveat', () => {
  const text = formatTravelResults('flights', parseTravelResults('flights', FLIGHT_JSON), { searched: 'Birmingham to Prague' });
  assert.match(text, /observed in search results just now, not held quotes/);
  assert.match(text, /have not checked whether any of them can actually be booked/);
});

test('options for other dates are reported separately, never as the price for these dates', () => {
  // These fixtures carry no observedStart, so the grade is "unknown" — the source never
  // pinned a date. That is reported as its own thing, and still never as an answer.
  const text = formatTravelResults('flights', parseTravelResults('flights', FLIGHT_JSON), { searched: '15–18 September' });
  assert.match(text, /For 15–18 September: easyJet, direct/);
  assert.match(text, /the source never said which dates it applies to/);
  assert.match(text, /Lufthansa/);
  const onDatesSentence = text.split('These had a price')[0];
  assert.doesNotMatch(onDatesSentence, /Lufthansa/);
});

test('when nothing matches the requested dates, that is stated outright', () => {
  const text = formatTravelResults('flights', parseTravelResults('flights', JSON.stringify([
    { airline: 'Lufthansa', stops: 1, priceAmount: 202, priceCurrency: 'GBP', quotedFor: 'early September', matchesRequestedDates: false, source: 'Google Flights' }
  ])), { searched: '15–18 September' });
  assert.match(text, /couldn't verify a priced result for 15–18 September/);
});

test('a no-results search says so instead of producing plausible options', () => {
  const text = formatTravelResults('hotels', [], { searched: 'Bath 12–14 September', researchFound: false });
  assert.match(text, /the search turned up nothing usable for Bath/);
  assert.match(text, /web search, not a live booking system/);
});

test('"found pages but no attributable price" is not reported as "found nothing"', () => {
  // The common real case, and a different fact from an empty search.
  const text = formatTravelResults('flights', [], { searched: 'Birmingham to Prague', researchFound: true });
  assert.match(text, /found information about Birmingham to Prague, but no specific price I could attribute to a source/);
  assert.doesNotMatch(text, /turned up nothing usable/);
});

test('a no-results search still explains what its own constraints ruled out', () => {
  const text = formatTravelResults('flights', [], {
    searched: 'Birmingham to Prague',
    dropped: [{ option: { airline: 'KLM' }, why: 'not direct' }, { option: { airline: 'Lufthansa' }, why: 'not direct' }]
  });
  assert.match(text, /2 options were ruled out: not direct/);
});

test('a hotel line reports the area and rating the search actually gave', () => {
  const text = formatTravelResults('hotels', parseTravelResults('hotels', HOTEL_JSON), { searched: 'Bath' });
  assert.match(text, /The Bath Townhouse, city centre, rated 4\.4 — £128\/night \(Booking\.com/);
});

// ── Prompts enforce the rules at the source ────────────────────────────────────────────
test('stated constraints reach the search itself, not only the filter afterwards', () => {
  const prompt = buildFlightResearchPrompt({
    from: 'BHX', to: 'PRG', departDate: '2026-09-15', today: '2026-08-08',
    maxPrice: 150, directOnly: true
  });
  assert.match(prompt, /They only want direct\/nonstop flights/);
  assert.match(prompt, /stay under 150 in total/);
});

test('the research prompt forbids inventing what search results do not contain', () => {
  const prompt = buildFlightResearchPrompt({ from: 'BHX', to: 'PRG', departDate: '2026-09-15', today: '2026-08-08' });
  assert.match(prompt, /Never invent a flight number, an exact departure time, or a price/);
  assert.match(prompt, /whether it applies to the requested dates or to different dates/);
});

test('the hotel research prompt refuses invented availability', () => {
  const prompt = buildHotelResearchPrompt({ location: 'Bath', checkIn: '2026-09-12', today: '2026-08-08' });
  assert.match(prompt, /Never invent a property, a price, or availability/);
  assert.match(prompt, /whether availability for those dates is actually stated/);
});

test('the extraction stage is constrained to the text it was handed', () => {
  const prompt = buildExtractionPrompt('flights', 'SEARCH TEXT HERE', { departDate: '2026-09-15' });
  assert.match(prompt, /Use ONLY what the text states/);
  assert.match(prompt, /Never add an option, a price, a property or an airline that is not in the text/);
  assert.match(prompt, /Drop any option with no stated price/);
  assert.match(prompt, /SEARCH TEXT HERE/);
});


// ── Exact-date integrity ───────────────────────────────────────────────────────────────
// The failure this section exists to prevent: a £133 fare the source quoted for 17–20
// September being presented as an answer to "18–21 September".

const REQUESTED = { start: '2026-09-18', end: '2026-09-21' };

function flight(extra = {}) {
  return {
    airline: 'easyJet', stops: 0, priceAmount: 133, priceCurrency: 'GBP', priceBasis: 'return',
    source: 'Google Flights', matchesRequestedDates: true, ...extra
  };
}

test('a fare quoted for adjacent dates is graded adjacent, whatever the extractor claimed', () => {
  const [option] = applyDateProvenance(
    parseTravelResults('flights', JSON.stringify([flight({ observedStart: '2026-09-17', observedEnd: '2026-09-20' })])),
    REQUESTED
  );
  assert.equal(option.dateMatch, 'adjacent');
  assert.equal(option.matchesRequestedDates, false, 'the extractor said true; the observed dates say otherwise');
  assert.equal(option.offByDays, 1);
});

test('a fare quoted for exactly the requested dates is graded exact', () => {
  const [option] = applyDateProvenance(
    parseTravelResults('flights', JSON.stringify([flight({ observedStart: '2026-09-18', observedEnd: '2026-09-21' })])),
    REQUESTED
  );
  assert.equal(option.dateMatch, 'exact');
  assert.equal(option.matchesRequestedDates, true);
});

test('a matching outbound but a different return is still adjacent', () => {
  const [option] = applyDateProvenance(
    parseTravelResults('flights', JSON.stringify([flight({ observedStart: '2026-09-18', observedEnd: '2026-09-22' })])),
    REQUESTED
  );
  assert.equal(option.dateMatch, 'adjacent');
});

test('a source that never stated its dates is "unknown", not "exact"', () => {
  const [option] = applyDateProvenance(
    parseTravelResults('flights', JSON.stringify([flight({ observedStart: null, observedEnd: null })])),
    REQUESTED
  );
  assert.equal(option.dateMatch, 'unknown');
  assert.equal(option.matchesRequestedDates, false, 'an unverifiable claim is not a verified match');
});

test('with no exact match, the answer says so and offers the closest as the CLOSEST', () => {
  const options = applyDateProvenance(parseTravelResults('flights', JSON.stringify([
    flight({ priceAmount: 133, observedStart: '2026-09-17', observedEnd: '2026-09-20' }),
    flight({ airline: 'Lufthansa', stops: 1, priceAmount: 202, observedStart: '2026-09-03', observedEnd: '2026-09-06' })
  ])), REQUESTED);
  const text = formatTravelResults('flights', options, { searched: '18–21 September' });
  assert.match(text, /couldn't verify a priced result for 18–21 September/);
  assert.match(text, /closest sourced one I found was easyJet, direct — £133 return .*\[for 2026-09-17 to 2026-09-20, 1 day off\]/);
  // And the adjacent fare is never phrased as satisfying the request.
  assert.doesNotMatch(text, /For 18–21 September:/);
});

test('exact and adjacent are reported in separate sentences, never merged', () => {
  const options = applyDateProvenance(parseTravelResults('flights', JSON.stringify([
    flight({ priceAmount: 210, observedStart: '2026-09-18', observedEnd: '2026-09-21' }),
    flight({ airline: 'Ryanair', priceAmount: 46, observedStart: '2026-09-17', observedEnd: '2026-09-20' })
  ])), REQUESTED);
  const text = formatTravelResults('flights', options, { searched: '18–21 September' });
  const exactSentence = text.split('Also found')[0];
  assert.match(exactSentence, /For 18–21 September: easyJet/);
  assert.doesNotMatch(exactSentence, /Ryanair/, 'the cheaper wrong-week fare must not appear as an answer');
  assert.match(text, /priced for DIFFERENT dates: Ryanair/);
});

test('a price whose dates the source never gave is reported as exactly that', () => {
  const options = applyDateProvenance(
    parseTravelResults('flights', JSON.stringify([flight({ observedStart: null })])), REQUESTED
  );
  const text = formatTravelResults('flights', options, { searched: '18–21 September' });
  assert.match(text, /the source never said which dates it applies to/);
});

// ── Currency integrity ─────────────────────────────────────────────────────────────────
test('a budget in one currency neither passes nor silently drops a price in another', () => {
  const options = parseTravelResults('flights', JSON.stringify([
    flight({ priceAmount: 140, priceCurrency: 'GBP' }),
    flight({ airline: 'BA', priceAmount: 179, priceCurrency: 'USD' }),
    flight({ airline: 'KLM', priceAmount: 175, priceCurrency: 'GBP' })
  ]));
  const { kept, dropped } = applyConstraints(options, { maxPrice: 150, maxPriceCurrency: 'GBP' });
  // The over-budget GBP fare is genuinely out. The USD one is KEPT but flagged: no FX source
  // is configured, so the budget cannot be checked against it — and dropping it would have
  // thrown away a real option (live testing lost ten real hotels exactly this way).
  assert.deepEqual(kept.map(o => o.airline).sort(), ['BA', 'easyJet']);
  assert.equal(kept.find(o => o.airline === 'BA').budgetCheckable, false);
  assert.equal(kept.find(o => o.airline === 'easyJet').budgetCheckable, true);
  assert.deepEqual(dropped.map(d => d.option.airline), ['KLM']);
});

test('options the budget could not be checked against are called out in the answer', () => {
  const options = applyDateProvenance(parseTravelResults('hotels', JSON.stringify([
    { name: 'Hotel Praha', pricePerNight: 92, priceCurrency: 'EUR', observedStart: '2026-09-18', observedEnd: '2026-09-21', source: 'Booking.com' }
  ])), REQUESTED);
  const { kept } = applyConstraints(options, { maxPrice: 100, maxPriceCurrency: 'GBP' });
  const text = formatTravelResults('hotels', kept, { searched: 'Prague 18–21 September' });
  assert.match(text, /priced in a different currency from your budget, so I could not check/);
});

test('mixed currencies are stated and never converted in the answer', () => {
  const options = applyDateProvenance(parseTravelResults('flights', JSON.stringify([
    flight({ priceAmount: 133, priceCurrency: 'GBP', observedStart: '2026-09-18', observedEnd: '2026-09-21' }),
    flight({ airline: 'BA', priceAmount: 179, priceCurrency: 'USD', observedStart: '2026-09-18', observedEnd: '2026-09-21' })
  ])), REQUESTED);
  const text = formatTravelResults('flights', options, { searched: '18–21 September' });
  assert.match(text, /Prices are in GBP and USD — I have not converted between them/);
});

test('the cheapest is computed per currency, never across them', () => {
  const options = parseTravelResults('flights', JSON.stringify([
    flight({ priceAmount: 133, priceCurrency: 'GBP' }),
    flight({ airline: 'BA', priceAmount: 100, priceCurrency: 'USD' }),
    flight({ airline: 'KLM', priceAmount: 175, priceCurrency: 'GBP' })
  ]));
  assert.equal(groupByCurrency(options).size, 2);
  const cheapest = cheapestPerCurrency(options);
  assert.equal(cheapest.length, 2);
  assert.deepEqual(cheapest.map(o => `${o.currency}:${o.price}`).sort(), ['GBP:133', 'USD:100']);
});

// ── Hotel stay integrity ───────────────────────────────────────────────────────────────
test('a hotel priced for the wrong nights is not a match for the requested stay', () => {
  const [option] = applyDateProvenance(parseTravelResults('hotels', JSON.stringify([{
    name: 'Hotel Prague', pricePerNight: 92, priceCurrency: 'GBP',
    observedStart: '2026-09-17', observedEnd: '2026-09-20',
    matchesRequestedDates: true, availabilityStated: true, source: 'Booking.com'
  }])), REQUESTED);
  assert.equal(option.dateMatch, 'adjacent');
  assert.equal(option.matchesRequestedDates, false);
});

test('a stay of the wrong length is dropped with a stated reason', () => {
  const options = parseTravelResults('hotels', JSON.stringify([
    { name: 'Two nights', pricePerNight: 80, priceCurrency: 'GBP', source: 'S' }
  ])).map(o => ({ ...o, nights: 2 }));
  const { kept, dropped } = applyConstraints(options, { nights: 3 });
  assert.equal(kept.length, 0);
  assert.match(dropped[0].why, /priced for 2 nights, not 3/);
});

test('the extraction prompt asks the source for its own dates, not the requested ones', () => {
  const prompt = buildExtractionPrompt('flights', 'TEXT', { departDate: '2026-09-18', returnDate: '2026-09-21' });
  assert.match(prompt, /observedStart\/observedEnd: the dates the SOURCE quoted/);
  assert.match(prompt, /Do NOT copy the requested dates here/);
});

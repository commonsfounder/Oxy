const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateItinerary,
  modifyItinerary,
  itineraryToText,
  buildItineraryPrompt,
  buildModifyPrompt
} = require('../../api/services/itinerary-engine');

const { rankHotels, rankActivities, rankFlights } = require('../../api/services/travel-ranking');

// --- Prompt builders ---

test('buildItineraryPrompt includes destination and requirements', () => {
  const prompt = buildItineraryPrompt({ destination: 'Tokyo', partySize: '2', budget: '£5000' }, {}, null);
  assert.match(prompt, /Tokyo/);
  assert.match(prompt, /£5000/);
});

test('buildItineraryPrompt includes hotel and activity data when provided', () => {
  const prompt = buildItineraryPrompt(
    { destination: 'Tokyo' },
    { hotels: [{ name: 'Grand Hyatt' }], activities: [{ title: 'Tea Ceremony' }] },
    null
  );
  assert.match(prompt, /Grand Hyatt/);
  assert.match(prompt, /Tea Ceremony/);
});

test('buildModifyPrompt includes instruction', () => {
  const prompt = buildModifyPrompt({ days: [] }, 'add more nightlife', { destination: 'Tokyo' });
  assert.match(prompt, /nightlife/);
  assert.match(prompt, /Tokyo/);
});

// --- itineraryToText ---

test('itineraryToText formats day structure correctly', () => {
  const itinerary = {
    title: 'Tokyo Trip',
    totalDays: 2,
    days: [
      { day: 1, theme: 'Culture', morning: { activity: 'Senso-ji Temple' }, afternoon: { activity: 'Harajuku' }, evening: { activity: 'Shinjuku' } },
      { day: 2, theme: 'Food', morning: { activity: 'Tsukiji Market' }, afternoon: { activity: 'Ramen tasting' }, evening: { activity: 'Sake bar' } }
    ]
  };
  const text = itineraryToText(itinerary);
  assert.match(text, /Tokyo Trip/);
  assert.match(text, /Day 1/);
  assert.match(text, /Senso-ji/);
  assert.match(text, /Tsukiji/);
});

// --- generateItinerary requires callModel ---

test('generateItinerary throws when callModel is missing', async () => {
  await assert.rejects(() => generateItinerary({ destination: 'Tokyo' }, {}, null, null), /callModel/);
});

test('generateItinerary uses model output and returns structured itinerary', async () => {
  const fakeItinerary = {
    title: 'Tokyo 3-Day Trip',
    destination: 'Tokyo',
    totalDays: 3,
    estimatedBudget: { total: 2500, currency: 'GBP', breakdown: {}, note: 'approximate' },
    days: [
      { day: 1, theme: 'Arrival', morning: { activity: 'Senso-ji', why: 'Historic temple' }, afternoon: { activity: 'Shibuya' }, evening: { activity: 'Dinner' }, meals: {}, travelTips: '' }
    ]
  };
  const callModel = async () => JSON.stringify(fakeItinerary);
  const result = await generateItinerary({ destination: 'Tokyo', duration: '3' }, {}, null, callModel);
  assert.equal(result.destination, 'Tokyo');
  assert.equal(result.totalDays, 3);
  assert.ok(Array.isArray(result.days));
  assert.equal(result.days[0].morning.why, 'Historic temple');
});

test('generateItinerary throws on invalid model output', async () => {
  const callModel = async () => '{"invalid": true}'; // missing days array
  await assert.rejects(
    () => generateItinerary({ destination: 'Tokyo' }, {}, null, callModel),
    /invalid itinerary structure/
  );
});

// --- modifyItinerary ---

test('modifyItinerary applies modification and adds lastModification', async () => {
  const existing = {
    title: 'Tokyo',
    totalDays: 3,
    days: [{ day: 1, theme: 'Culture', morning: { activity: 'Museum' }, afternoon: {}, evening: {} }]
  };
  const modified = {
    changed: true,
    summary: 'Replaced museum with nightclub',
    days: [{ day: 1, theme: 'Nightlife', morning: { activity: 'Sleep in' }, afternoon: {}, evening: { activity: 'Nightclub' } }]
  };
  const callModel = async () => JSON.stringify(modified);
  const result = await modifyItinerary(existing, 'add more nightlife', {}, callModel);
  assert.equal(result.lastModification.instruction, 'add more nightlife');
  assert.match(result.lastModification.summary, /nightclub/i);
  assert.equal(result.days[0].theme, 'Nightlife');
});

// --- Ranking ---

test('rankHotels scores within-budget hotels higher', () => {
  const hotels = [
    { name: 'Cheap', totalPrice: 400 },
    { name: 'Expensive', totalPrice: 2000 }
  ];
  const ranked = rankHotels(hotels, {}, { budget: '£1000' });
  assert.equal(ranked[0].name, 'Cheap');
});

test('rankHotels boosts luxury hotels for luxury profile', () => {
  const hotels = [
    { name: 'Budget Inn', rating: 2, totalPrice: 300 },
    { name: 'Grand Hotel', rating: 5, totalPrice: 800 }
  ];
  const ranked = rankHotels(hotels, { hotel_style: 'luxury', budget_tier: 'luxury' }, {});
  assert.equal(ranked[0].name, 'Grand Hotel');
});

test('rankActivities prefers activities matching user interests', () => {
  const activities = [
    { title: 'Art Museum Tour', rating: 4.5, reviewCount: 200, categories: ['MUSEUM_ART_CULTURE'] },
    { title: 'Beach Volleyball', rating: 4.0, reviewCount: 100, categories: ['BEACH_WATER_ACTIVITIES'] }
  ];
  const ranked = rankActivities(activities, { activity_types: ['culture'] }, { activityPreferences: ['culture'] });
  assert.equal(ranked[0].title, 'Art Museum Tour');
});

test('rankFlights prefers direct flights when constraint is set', () => {
  const flights = [
    { airline: 'BA', stops: 1, totalPrice: 400 },
    { airline: 'JL', stops: 0, totalPrice: 500 }
  ];
  const ranked = rankFlights(flights, {}, { constraints: ['direct_or_fewest_changes'] });
  assert.equal(ranked[0].stops, 0);
});

test('rankFlights boosts preferred airline', () => {
  const flightsList = [
    { airline: 'EK', stops: 0, totalPrice: 600 },
    { airline: 'BA', stops: 0, totalPrice: 600 }
  ];
  const ranked = rankFlights(flightsList, { preferred_airlines: ['BA'] }, {});
  assert.equal(ranked[0].airline, 'BA');
});

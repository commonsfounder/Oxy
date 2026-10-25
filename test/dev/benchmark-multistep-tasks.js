'use strict';

// Multi-step tasks: each needs several chained steps (search then browse, look up then calculate,
// compare two places). All read-only and public, so they can be run by Adam and by hand.
//
// Checks (all optional, all must hold for a pass):
//   minSteps       fewest steps Adam must take; fewer means it answered from memory or guessed
//   expectActions  actions that must each appear at least once
//   expectAny      at least one of these actions must appear
//   expectText     patterns the answer must match   (a pattern in a [pattern, count] pair must match count times)
//   forbidText     patterns the answer must not match (generic give-ups)

const GIVE_UPS = [/action is incomplete/i, /ran out of steps/i, /could not be completed/i];
const POUNDS = /£\s?\d/g;

module.exports = [
  {
    id: 'kettle-two-shops', kind: 'compare',
    message: 'Find a kettle under £60 with at least 4 stars at John Lewis and another at Currys, then tell me which shop is cheaper and by how much.',
    minSteps: 2, expectText: [[POUNDS, 2]], forbidText: GIVE_UPS,
  },
  {
    id: 'milk-times-six', kind: 'lookup-then-math',
    message: 'How much is 2 pints of semi-skimmed milk at Tesco, and what would 6 of them cost?',
    expectAny: ['web_search', 'browser_open'], expectText: [[/£\s?\d+\.\d{2}/g, 2]], forbidText: GIVE_UPS,
  },
  {
    id: 'lisbon-budget', kind: 'plan',
    message: 'I have £400 for two nights in Lisbon from London next weekend, flights and hotel included. Is that realistic? Give me the cheapest flight, a hotel, and the total.',
    minSteps: 2, expectActions: ['search_flights', 'search_hotels'], expectText: [POUNDS], forbidText: GIVE_UPS,
  },
  {
    id: 'edinburgh-trip', kind: 'plan',
    message: "What's the weather in Edinburgh this Saturday, should I take a coat, and how long is the train from Birmingham New Street?",
    minSteps: 2, expectAny: ['get_forecast', 'get_weather', 'web_search'], expectText: [/coat|jacket|layer|umbrella|waterproof/i, /\b\d+\s*(?:h|hr|hour)/i], forbidText: GIVE_UPS,
  },
  {
    id: 'director-chain', kind: 'chain',
    message: 'Who directed Paddington 2, what is the most recent film they directed, and what year did it come out?',
    expectText: [/paul king/i, /\b20\d\d\b/], forbidText: GIVE_UPS,
  },
  {
    id: 'tallest-architect', kind: 'chain',
    message: 'Find the tallest building in Birmingham, then tell me who designed it and what year it was completed.',
    expectText: [/octagon|one eastside/i, /\b20\d\d\b/], forbidText: GIVE_UPS,
  },
  {
    id: 'museum-morning', kind: 'plan',
    message: 'Plan a Saturday morning at the British Museum: what time it opens, and how long it takes to walk there from Euston station.',
    expectText: [/\b10(?::00|\s?a\.?m)/i, /\b\d+\s*-?\s*(?:min|minute)/i], forbidText: GIVE_UPS,
  },
  {
    id: 'headline-cross-check', kind: 'compare',
    message: "What's the top headline on BBC News right now, and is the same story on the front page of The Guardian?",
    minSteps: 2, expectAny: ['browser_open', 'web_search'], forbidText: [...GIVE_UPS, /can.?t (?:reliably )?(?:identify|report|find)/i],
  },
  {
    id: 'argos-fallback', kind: 'recover',
    message: "Find the price of the cheapest kettle at Argos. If you can't get it, find the cheapest one at John Lewis instead and tell me which you used.",
    minSteps: 2, expectText: [POUNDS, /argos|john lewis/i], forbidText: GIVE_UPS,
  },
  {
    id: 'next-train', kind: 'lookup',
    message: "What's the next train from Birmingham New Street to Manchester Piccadilly, and how long is the journey?",
    minSteps: 1, expectAny: ['search_trains', 'web_search', 'plan_trip'], expectText: [/\b\d+\s*(?:h|hr|hour|min)/i], forbidText: GIVE_UPS,
  },
  {
    id: 'kettle-options', kind: 'cards',
    message: 'Find three kettles under £40 with at least 4 stars and show them to me side by side.',
    minSteps: 1, expectActions: ['show_results'], forbidText: GIVE_UPS,
  },
  {
    id: 'cheapest-over-two-searches', kind: 'compare',
    message: 'Which is cheaper right now: a 1.7 litre Bosch kettle at John Lewis or a 1.7 litre Russell Hobbs kettle at Currys? Give both prices.',
    minSteps: 2, expectText: [[POUNDS, 2]], forbidText: GIVE_UPS,
  },
];

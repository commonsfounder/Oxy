const assert = require('node:assert/strict');
const test = require('node:test');

const { inferDeterministicAction } = require('../../api/intent-router');
const { getSearchReason, needsSearch } = require('../../api/services/search-intent');

const evalCases = [
  {
    name: 'current chart playback must search before music action',
    message: 'play the most popular song on the Billboard Hot 100 right now',
    expectSearch: true,
    searchReason: 'current-music-chart',
    deterministicAction: null
  },
  {
    name: 'follow-up about played song popularity must be factual, not a new action',
    message: 'is this the most popular song',
    expectSearch: true,
    searchReason: 'current-music-chart',
    deterministicAction: null
  },
  {
    name: 'explicit correction asks the brain to re-check',
    message: 'look it up',
    expectSearch: true,
    searchReason: 'explicit-search',
    deterministicAction: null
  },
  {
    name: 'company factual question must not become local place lookup',
    message: "what is McDonald's revenue this year?",
    expectSearch: true,
    deterministicAction: null
  },
  {
    name: 'current weather must search, not guess',
    message: 'what is the weather in Solihull right now?',
    expectSearch: true,
    searchReason: 'time-sensitive',
    deterministicAction: null
  },
  {
    name: 'latest product recommendation must search',
    message: 'what is the best cheap phone to buy right now?',
    expectSearch: true,
    deterministicAction: null
  },
  {
    name: 'shopping request with budget must search, not route to a job board',
    message: 'find me a macbook under 700',
    expectSearch: true,
    searchReason: 'shopping-product',
    deterministicAction: null
  },
  {
    name: 'best-X-under-budget recommendation must search',
    message: 'whats the best laptop under 500',
    expectSearch: true,
    searchReason: 'shopping-product',
    deterministicAction: null
  },
  {
    name: 'specific known music playback does not need search',
    message: 'play California Gurls by Katy Perry',
    expectSearch: false,
    deterministicAction: null
  },
  {
    name: 'last requested song must use conversation history, not router guessing',
    message: 'play the last song i asked you to play',
    expectSearch: false,
    deterministicAction: null
  },
  {
    name: 'obvious local place action stays deterministic',
    message: "nearest McDonald's",
    expectSearch: false,
    deterministicAction: 'find_place'
  },
  {
    name: 'obvious Uber action stays deterministic',
    message: "get me an Uber to the nearest McDonald's",
    expectSearch: false,
    deterministicAction: 'book_uber'
  },
  {
    name: 'vague travel follow-up must not invent a destination',
    message: 'can i get there by 7:30',
    expectSearch: false,
    deterministicAction: null
  },
  {
    name: 'plain memory write must not trigger search or local place lookup',
    message: 'remember my usual station is Birmingham New Street',
    expectSearch: false,
    deterministicAction: null
  },
  {
    name: 'live departures use grounded search instead of stale train connector',
    message: 'next train from Milton Keynes Central to Birmingham New Street',
    expectSearch: true,
    searchReason: 'public-transport-live',
    deterministicAction: null
  },
  {
    name: 'platform follow-up searches with context instead of guessing',
    message: 'what platform',
    expectSearch: true,
    searchReason: 'public-transport-live',
    deterministicAction: null
  }
];

for (const evalCase of evalCases) {
  test(`brain eval: ${evalCase.name}`, () => {
    assert.equal(needsSearch(evalCase.message), evalCase.expectSearch, 'search decision');
    if (evalCase.searchReason) {
      assert.equal(getSearchReason(evalCase.message), evalCase.searchReason, 'search reason');
    }

    const routed = inferDeterministicAction(evalCase.message);
    const action = routed?.actions?.[0]?.type || null;
    assert.equal(action, evalCase.deterministicAction, 'deterministic action');
  });
}

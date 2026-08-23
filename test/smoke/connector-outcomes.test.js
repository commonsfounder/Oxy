const assert = require('node:assert/strict');
const test = require('node:test');

const weather = require('../../connectors/weather');
const stocks = require('../../connectors/stocks');
const amazon = require('../../connectors/amazon');
const brainProvider = require('../../api/services/brain-provider');

test('weather works through grounded search without an OpenWeather key', async () => {
  const saved = brainProvider.webSearchBrain;
  let prompt = '';
  brainProvider.webSearchBrain = async input => {
    prompt = input.prompt;
    return 'London: 18°C, light rain, feels like 17°C. Updated 10 minutes ago.';
  };
  try {
    const result = await weather.execute('user-1', 'get_weather', { city: 'London' });
    assert.equal(result.success, true);
    assert.equal(result.outcome, 'completed');
    assert.equal(result.source, 'grounded_web_search');
    assert.match(prompt, /current weather in London/i);
    assert.match(result.text, /18°C/);
  } finally {
    brainProvider.webSearchBrain = saved;
  }
});

test('stocks work through grounded search without an Alpha Vantage key', async () => {
  const saved = brainProvider.webSearchBrain;
  let prompt = '';
  brainProvider.webSearchBrain = async input => {
    prompt = input.prompt;
    return 'AAPL: $200.00, down 1.2%, quote delayed. Updated 5 minutes ago.';
  };
  try {
    const result = await stocks.execute('user-1', 'get_stock_price', { symbol: 'AAPL' });
    assert.equal(result.success, true);
    assert.equal(result.outcome, 'completed');
    assert.equal(result.source, 'grounded_web_search');
    assert.match(prompt, /current stock quote for AAPL/i);
    assert.match(result.text, /\$200\.00/);
  } finally {
    brainProvider.webSearchBrain = saved;
  }
});

test('public-data searches stay unavailable when grounded search returns no answer', async () => {
  const saved = brainProvider.webSearchBrain;
  brainProvider.webSearchBrain = async () => '';
  try {
    const [weatherResult, stockResult] = await Promise.all([
      weather.execute('user-1', 'get_weather', { city: 'London' }),
      stocks.execute('user-1', 'get_stock_price', { symbol: 'AAPL' })
    ]);
    for (const result of [weatherResult, stockResult]) {
      assert.equal(result.success, false);
      assert.equal(result.outcome, 'unavailable');
      assert.equal(result.unavailable, true);
      assert.match(result.error, /No grounded .* result/i);
    }
  } finally {
    brainProvider.webSearchBrain = saved;
  }
});

test('Amazon URL-only actions are explicit handoffs, never completed effects', async () => {
  const cases = [
    ['search_amazon', { query: 'trainers' }, /search/i],
    ['add_to_amazon_cart', { query: 'trainers' }, /open Amazon|add/i],
    ['track_amazon_order', { query: 'order 123' }, /open Amazon|order history/i]
  ];
  for (const [action, input, textPattern] of cases) {
    const result = await amazon.execute('user-1', action, input);
    assert.equal(result.success, false, action);
    assert.equal(result.outcome, 'handoff_required', action);
    assert.equal(result.handoffRequired, true, action);
    assert.doesNotMatch(result.text, /^Added .* to Amazon cart/i, action);
    assert.match(result.text, textPattern, action);
    assert.ok(result.webLink, action);
  }
});

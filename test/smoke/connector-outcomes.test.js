const assert = require('node:assert/strict');
const test = require('node:test');

const weather = require('../../connectors/weather');
const stocks = require('../../connectors/stocks');
const amazon = require('../../connectors/amazon');

test('weather without a provider key is unavailable, not a weather result', async () => {
  const saved = process.env.OPENWEATHER_API_KEY;
  delete process.env.OPENWEATHER_API_KEY;
  try {
    const result = await weather.execute('user-1', 'get_weather', { city: 'London' });
    assert.equal(result.success, false);
    assert.equal(result.outcome, 'unavailable');
    assert.equal(result.webLink, undefined);
    assert.match(result.error, /weather.*unavailable|not configured/i);
  } finally {
    if (saved === undefined) delete process.env.OPENWEATHER_API_KEY;
    else process.env.OPENWEATHER_API_KEY = saved;
  }
});

test('stocks without a provider key are unavailable, not a quote', async () => {
  const saved = process.env.ALPHA_VANTAGE_KEY;
  delete process.env.ALPHA_VANTAGE_KEY;
  try {
    const result = await stocks.execute('user-1', 'get_stock_price', { symbol: 'AAPL' });
    assert.equal(result.success, false);
    assert.equal(result.outcome, 'unavailable');
    assert.equal(result.webLink, undefined);
    assert.match(result.error, /stock.*unavailable|not configured/i);
  } finally {
    if (saved === undefined) delete process.env.ALPHA_VANTAGE_KEY;
    else process.env.ALPHA_VANTAGE_KEY = saved;
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

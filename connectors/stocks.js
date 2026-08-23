const brainProvider = require('../api/services/brain-provider');
const { defaultModelForProvider } = require('../api/services/model-routing');

function searchModel() {
  return defaultModelForProvider(process.env.OXY_BRAIN_PROVIDER || 'openai', 'fast');
}

async function groundedStockSearch(symbol, search = false) {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = search
    ? `Today's date is ${today}. Search the web for the publicly traded company or stock symbol ${symbol}. Return the best-supported current listing details and exchange, and distinguish an identity result from a live quote. Do not invent a price. Plain concise text.`
    : `Today's date is ${today}. Search the web for the current stock quote for ${symbol}. Return the current price, currency, daily change or percentage where available, whether the quote is delayed or the market is closed, and the quote time. Do not invent a price; say plainly if no current quote is supported. Plain concise text.`;
  const text = await brainProvider.webSearchBrain({ model: searchModel(), prompt });
  if (!text) {
    return {
      success: false,
      outcome: 'unavailable',
      unavailable: true,
      error: `No grounded stock result was available for ${symbol}.`
    };
  }
  return {
    success: true,
    outcome: 'completed',
    text,
    symbol,
    source: 'grounded_web_search'
  };
}

async function execute(userId, action, params) {
  const symbol = params.symbol || params.query || 'AAPL';
  try {
    if (action === 'get_stock_price') {
      return groundedStockSearch(symbol);
    }
    if (action === 'search_stocks') {
      return groundedStockSearch(symbol, true);
    }
    return { success: false, outcome: 'failed', error: 'Unknown stocks action' };
  } catch (e) {
    return { success: false, outcome: 'failed', error: `Stock search failed: ${e.message}` };
  }
}

module.exports = { execute };

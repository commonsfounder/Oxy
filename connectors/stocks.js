const axios = require('axios');

const SUPPORTED_ACTIONS = ['get_stock_price', 'search_stocks'];

async function execute(userId, action, params) {
  const key = process.env.ALPHA_VANTAGE_KEY;
  const symbol = params.symbol || params.query || 'AAPL';
  if (!key) {
    return { success: true, text: `Stock info for ${symbol} - set ALPHA_VANTAGE_KEY for live quotes (free).`, webLink: `https://finance.yahoo.com/quote/${symbol}` };
  }

  try {
    if (action === 'get_stock_price') {
      const res = await axios.get(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${key}`);
      const q = res.data['Global Quote'] || {};
      const price = q['05. price'] || 'N/A';
      const change = q['09. change'] || 'N/A';
      return { success: true, text: `${symbol}: $${price} (${change})`, price: parseFloat(price) };
    }
    if (action === 'search_stocks') {
      const res = await axios.get(`https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(symbol)}&apikey=${key}`);
      const matches = res.data.bestMatches?.slice(0,3).map(m => `${m['1. symbol']}: ${m['2. name']}`).join(', ') || 'none';
      return { success: true, text: `Stock matches for ${symbol}: ${matches}` };
    }
    return { success: false, error: 'Unknown stocks action' };
  } catch (e) {
    return { success: false, error: `Stocks error: ${e.message}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };
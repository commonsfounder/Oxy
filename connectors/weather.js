const brainProvider = require('../api/services/brain-provider');
const { defaultModelForProvider } = require('../api/services/model-routing');

function searchModel() {
  return defaultModelForProvider(process.env.OXY_BRAIN_PROVIDER || 'openai', 'fast');
}

async function groundedWeather(city, forecast = false) {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = forecast
    ? `Today's date is ${today}. Search the web for the current weather forecast for ${city}. Return the next useful forecast periods, temperatures, precipitation and wind where available, with the relevant update time. Only report facts supported by the search results; say plainly if a detail is unavailable. Plain concise text.`
    : `Today's date is ${today}. Search the web for the current weather in ${city}. Return the current temperature, conditions, feels-like temperature and precipitation or wind where available, with the relevant observation or update time. Only report facts supported by the search results; say plainly if current data is unavailable. Plain concise text.`;
  const text = await brainProvider.webSearchBrain({ model: searchModel(), prompt });
  if (!text) {
    return {
      success: false,
      outcome: 'unavailable',
      unavailable: true,
      error: `No grounded weather result was available for ${city}.`
    };
  }
  return {
    success: true,
    outcome: 'completed',
    text,
    city,
    source: 'grounded_web_search'
  };
}

async function execute(userId, action, params) {
  const city = params.city || params.location || 'London';
  try {
    if (action === 'get_weather') {
      return groundedWeather(city);
    }
    if (action === 'get_forecast') {
      return groundedWeather(city, true);
    }
    return { success: false, outcome: 'failed', error: 'Unknown weather action' };
  } catch (e) {
    return { success: false, outcome: 'failed', error: `Weather search failed: ${e.message}` };
  }
}

module.exports = { execute };

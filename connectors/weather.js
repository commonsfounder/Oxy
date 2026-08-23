const axios = require('axios');

async function execute(userId, action, params) {
  const key = process.env.OPENWEATHER_API_KEY;
  const city = params.city || params.location || 'London';
  if (!key) {
    return { success: false, outcome: 'unavailable', unavailable: true, error: `Weather is unavailable because no provider is configured for ${city}.` };
  }

  try {
    if (action === 'get_weather') {
      const res = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${key}&units=metric`);
      const w = res.data;
      return { success: true, text: `${w.name}: ${w.weather[0].description}, ${w.main.temp}°C, feels like ${w.main.feels_like}°C`, temp: w.main.temp, condition: w.weather[0].description };
    }
    if (action === 'get_forecast') {
      const res = await axios.get(`https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${key}&units=metric`);
      const forecast = res.data.list.slice(0, 5).map(f => `${new Date(f.dt * 1000).toLocaleString()}: ${f.weather[0].description} ${f.main.temp}°C`).join(' | ');
      return { success: true, text: `Forecast for ${city}: ${forecast}` };
    }
    return { success: false, error: 'Unknown weather action' };
  } catch (e) {
    return { success: false, error: `Weather error: ${e.response?.data?.message || e.message}` };
  }
}

module.exports = { execute };

const axios = require('axios');

const SUPPORTED_ACTIONS = ['get_strava_activities', 'log_strava_activity'];

async function execute(userId, action, params) {
  const token = process.env.STRAVA_ACCESS_TOKEN;
  if (!token) {
    return { success: true, text: `Strava ${action} - set STRAVA_ACCESS_TOKEN for real fitness data.`, webLink: 'https://strava.com' };
  }

  const headers = { Authorization: `Bearer ${token}` };

  try {
    if (action === 'get_strava_activities') {
      const res = await axios.get('https://www.strava.com/api/v3/athlete/activities?per_page=5', { headers });
      const acts = res.data.map(a => `${a.name} (${(a.distance/1000).toFixed(1)}km)`).join('; ');
      return { success: true, text: `Recent Strava: ${acts}` };
    }
    if (action === 'log_strava_activity') {
      // To log, use /activities endpoint (needs more params like elapsed_time)
      const payload = {
        name: params.name || 'Assistant logged workout',
        type: params.type || 'Run',
        start_date_local: new Date().toISOString(),
        elapsed_time: params.elapsed_time || 3600,
        distance: params.distance || 5000
      };
      const res = await axios.post('https://www.strava.com/api/v3/activities', payload, { headers });
      return { success: true, text: `Logged to Strava: ${res.data.name}`, id: res.data.id };
    }
    return { success: false, error: 'Unknown Strava action' };
  } catch (e) {
    return { success: false, error: `Strava error: ${e.response?.data?.message || e.message}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };
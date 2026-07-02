const axios = require('axios');

const SUPPORTED_ACTIONS = ['get_oura_sleep', 'get_oura_readiness'];

async function execute(userId, action, params) {
  const token = process.env.OURA_ACCESS_TOKEN;
  if (!token) {
    return { success: true, text: `Oura ${action} - set OURA_ACCESS_TOKEN for real wearable data.`, webLink: 'https://ouraring.com' };
  }

  const headers = { Authorization: `Bearer ${token}` };

  try {
    if (action === 'get_oura_sleep') {
      const res = await axios.get('https://api.ouraring.com/v2/usercollection/sleep?start_date=' + (params.start_date || new Date(Date.now()-86400000*7).toISOString().split('T')[0]), { headers });
      const latest = res.data.data[res.data.data.length-1];
      return { success: true, text: `Oura latest sleep: score ${latest?.score || 'N/A'}, duration ${(latest?.duration || 0)/3600}h`, score: latest?.score };
    }
    if (action === 'get_oura_readiness') {
      const res = await axios.get('https://api.ouraring.com/v2/usercollection/readiness', { headers });
      const latest = res.data.data[res.data.data.length-1];
      return { success: true, text: `Oura readiness: ${latest?.score || 'N/A'}`, score: latest?.score };
    }
    return { success: false, error: 'Unknown Oura action' };
  } catch (e) {
    return { success: false, error: `Oura error: ${e.response?.data?.detail || e.message}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };
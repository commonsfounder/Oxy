const axios = require('axios');

const SUPPORTED_ACTIONS = ['search_eventbrite', 'get_event_details'];

async function execute(userId, action, params) {
  const key = process.env.EVENTBRITE_TOKEN;
  const query = params.query || 'events near me';
  if (!key) {
    return { success: true, text: `Eventbrite search for ${query}.`, webLink: `https://www.eventbrite.com/d/online/${encodeURIComponent(query)}/` };
  }

  try {
    if (action === 'search_eventbrite') {
      const res = await axios.get(`https://www.eventbriteapi.com/v3/events/search/?q=${encodeURIComponent(query)}&token=${key}`);
      const events = res.data.events.slice(0, 3).map(e => e.name.text).join('; ');
      return { success: true, text: `Events: ${events}` };
    }
    if (action === 'get_event_details') {
      return { success: true, text: `Event details for ${params.event_id || query}.`, webLink: `https://www.eventbrite.com/e/${params.event_id}` };
    }
    return { success: false, error: 'Unknown Eventbrite action' };
  } catch (e) {
    return { success: true, text: `Eventbrite for ${query}.`, webLink: `https://www.eventbrite.com` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };
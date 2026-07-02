const SUPPORTED_ACTIONS = ['search_hotels', 'book_hotel'];

async function execute(userId, action, params) {
  const location = params.location || params.city || 'destination';
  const checkin = params.checkin || 'today';
  const url = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(location)}&checkin=${encodeURIComponent(checkin)}`;
  if (action === 'search_hotels' || action === 'book_hotel') {
    return { success: true, text: `Hotels in ${location} for ${checkin}.`, webLink: url };
  }
  return { success: false, error: 'Unknown hotels action' };
}

module.exports = { SUPPORTED_ACTIONS, execute };
// book_hotel was removed: it had no action contract (unreachable via normal tool-calling)
// and did nothing different from search_hotels — same search-link generator under a name
// that implied a real booking capability that doesn't exist here.
const SUPPORTED_ACTIONS = ['search_hotels'];

async function execute(userId, action, params) {
  const location = params.location || params.city || 'destination';
  const checkin = params.checkin || 'today';
  const url = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(location)}&checkin=${encodeURIComponent(checkin)}`;
  if (action === 'search_hotels') {
    return { success: true, text: `Hotels in ${location} for ${checkin}.`, webLink: url };
  }
  return { success: false, error: 'Unknown hotels action' };
}

module.exports = { SUPPORTED_ACTIONS, execute };
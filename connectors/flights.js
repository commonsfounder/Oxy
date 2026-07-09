// book_flight was removed: it had no action contract (unreachable via normal tool-calling)
// and did nothing different from search_flights — same search-link generator under a name
// that implied a real booking capability that doesn't exist here.
const SUPPORTED_ACTIONS = ['search_flights', 'track_flight'];

async function execute(userId, action, params) {
  const from = params.from || 'origin';
  const to = params.to || params.destination || 'destination';
  const date = params.date || 'soon';
  const query = `${from} to ${to} on ${date}`;

  if (action === 'search_flights') {
    const url = `https://www.google.com/travel/flights?q=Flights%20to%20${encodeURIComponent(to)}%20from%20${encodeURIComponent(from)}%20on%20${encodeURIComponent(date)}`;
    return { success: true, text: `Flights ${query}.`, webLink: url };
  }
  if (action === 'track_flight') {
    const flight = params.flight || query;
    return { success: true, text: `Tracking flight ${flight}.`, webLink: `https://www.google.com/search?q=flight+${encodeURIComponent(flight)}` };
  }
  return { success: false, error: 'Unknown flights action' };
}

module.exports = { SUPPORTED_ACTIONS, execute };
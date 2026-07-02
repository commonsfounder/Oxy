const SUPPORTED_ACTIONS = ['search_flights', 'book_flight', 'track_flight'];

async function execute(userId, action, params) {
  const from = params.from || 'origin';
  const to = params.to || params.destination || 'destination';
  const date = params.date || 'soon';
  const query = `${from} to ${to} on ${date}`;

  if (action === 'search_flights' || action === 'book_flight') {
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
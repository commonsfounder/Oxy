// Neither book_flight nor search_flights lives here: both only ever built a search URL and
// returned success without seeing a price. search_flights is now a real grounded search in
// executeAction, which reaches its own case before any connector dispatch.
async function execute(userId, action, params) {
  const from = params.from || 'origin';
  const to = params.to || params.destination || 'destination';
  const date = params.date || 'soon';
  const query = `${from} to ${to} on ${date}`;

  if (action === 'track_flight') {
    const flight = params.flight || query;
    return { success: false, outcome: 'handoff_required', handoffRequired: true, text: `Open a flight search to check ${flight}.`, webLink: `https://www.google.com/search?q=flight+${encodeURIComponent(flight)}` };
  }
  return { success: false, error: 'Unknown flights action' };
}

module.exports = { execute };

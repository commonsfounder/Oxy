// book_flight was removed: it had no action contract (unreachable via normal tool-calling)
// and did nothing different from search_flights — same search-link generator under a name
// that implied a real booking capability that doesn't exist here.
//
// search_flights was removed for the same reason, 2026-08-08: it built a Google Flights URL
// and returned success without ever having seen a price. It is now a real grounded search in
// api/index.js's executeAction, which reaches its own case before any connector dispatch —
// leaving the old branch here would have been dead code that still LOOKED like a flight
// search.
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

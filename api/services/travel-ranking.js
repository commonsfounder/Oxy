// Preference-weighted result ranking — runs before results are passed to the itinerary engine.
// Scores are heuristic; higher = better fit for this user.
// ponytail: no ML, no training data — just weighted rules that can be tuned when we have real data.

/**
 * Rank an array of hotel results against user profile and requirements.
 * @param {Array} hotels - from Amadeus hotels connector
 * @param {Object} profile - row from travel_preferences table
 * @param {Object} requirements - extracted from travel concierge state
 * @returns {Array} sorted hotels, highest score first, with .score added
 */
function rankHotels(hotels = [], profile = {}, requirements = {}) {
  return hotels
    .map(h => ({ ...h, score: hotelScore(h, profile, requirements) }))
    .sort((a, b) => b.score - a.score);
}

function hotelScore(hotel, profile, requirements) {
  let score = 50; // baseline

  // Price fit: full score when within budget, penalise overruns
  const budget = parseBudget(requirements.budget);
  if (budget && hotel.totalPrice) {
    if (hotel.totalPrice <= budget) score += 20;
    else score -= Math.min(30, Math.round((hotel.totalPrice - budget) / budget * 30));
  }

  // Style match
  const preferredStyle = profile.hotel_style || requirements.accommodationPreference;
  if (preferredStyle && hotel.rating) {
    if (preferredStyle === 'luxury' && hotel.rating >= 4) score += 15;
    if (preferredStyle === 'boutique' && hotel.rating >= 4 && hotel.rating <= 5) score += 15;
    if (preferredStyle === 'budget' && hotel.rating <= 3) score += 15;
  }

  // Budget tier
  const budgetTier = profile.budget_tier || requirements.budgetTier;
  if (budgetTier && hotel.rating) {
    if (budgetTier === 'luxury' && hotel.rating >= 4) score += 10;
    if (budgetTier === 'budget' && hotel.pricePerNight && hotel.pricePerNight < 80) score += 10;
    if (budgetTier === 'mid' && hotel.rating === 3 || hotel.rating === 4) score += 5;
  }

  // Rating quality
  if (hotel.rating) score += hotel.rating * 2;

  return Math.max(0, score);
}

/**
 * Rank activity results.
 * @param {Array} activities - from Viator connector
 * @param {Object} profile - travel_preferences row
 * @param {Object} requirements - concierge requirements
 * @returns {Array} sorted activities, highest score first
 */
function rankActivities(activities = [], profile = {}, requirements = {}) {
  const interests = [
    ...(profile.activity_types || []),
    ...(requirements.activityPreferences || [])
  ].map(i => i.toLowerCase());

  return activities
    .map(a => ({ ...a, score: activityScore(a, interests, requirements) }))
    .sort((a, b) => b.score - a.score);
}

function activityScore(activity, interests, requirements) {
  let score = 50;

  // Review quality: log-scaled to avoid large-number dominance
  if (activity.rating) score += activity.rating * 4;
  if (activity.reviewCount) score += Math.min(10, Math.log10(activity.reviewCount + 1) * 5);

  // Interest match: check if any interest appears in activity categories or title
  const titleLower = (activity.title || '').toLowerCase();
  const cats = (activity.categories || []).map(c => c.toLowerCase()).join(' ');
  for (const interest of interests) {
    if (titleLower.includes(interest) || cats.includes(interest)) {
      score += 20;
      break;
    }
  }

  // Budget fit
  const budget = parseBudget(requirements.budget);
  if (budget && activity.priceFrom) {
    // Activities are per-person, not per-trip, so use a fraction
    const perPersonBudget = budget / (parseInt(requirements.partySize || 1, 10) * 5);
    if (activity.priceFrom <= perPersonBudget) score += 10;
    else if (activity.priceFrom > perPersonBudget * 2) score -= 10;
  }

  return Math.max(0, score);
}

/**
 * Rank flight results.
 * @param {Array} flights - from Amadeus flights connector
 * @param {Object} profile - travel_preferences row
 * @param {Object} requirements - concierge requirements
 * @returns {Array} sorted flights, highest score first
 */
function rankFlights(flights = [], profile = {}, requirements = {}) {
  const preferredAirlines = (profile.preferred_airlines || []).map(a => a.toUpperCase());
  const wantsDirect = (requirements.constraints || []).includes('direct_or_fewest_changes');

  return flights
    .map(f => ({ ...f, score: flightScore(f, preferredAirlines, wantsDirect, requirements) }))
    .sort((a, b) => b.score - a.score);
}

function flightScore(flight, preferredAirlines, wantsDirect, requirements) {
  let score = 50;

  // Price fit
  const budget = parseBudget(requirements.budget);
  if (budget && flight.totalPrice) {
    if (flight.totalPrice <= budget * 0.4) score += 20; // flights under 40% of total budget = good value
    else if (flight.totalPrice > budget * 0.7) score -= 15;
  }

  // Direct flight preference
  if (wantsDirect && flight.stops === 0) score += 25;
  else if (wantsDirect && flight.stops > 0) score -= 10;

  // Non-stop bonus even without explicit preference
  if (flight.stops === 0) score += 10;
  else score -= flight.stops * 5;

  // Preferred airline
  if (preferredAirlines.length && preferredAirlines.includes(flight.airline)) score += 15;

  return Math.max(0, score);
}

function parseBudget(budgetStr = '') {
  if (!budgetStr) return null;
  const match = String(budgetStr).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

module.exports = {
  rankHotels,
  rankActivities,
  rankFlights
};

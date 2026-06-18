const SUPPORTED_ACTIONS = ['search_activities', 'get_activity_details'];

const VIATOR_BASE = 'https://api.viator.com/partner';

function getAxios() { return require('axios'); }

function viatorHeaders() {
  const key = process.env.VIATOR_API_KEY;
  if (!key) throw new Error('VIATOR_API_KEY is required.');
  return {
    'exp-api-key': key,
    'Accept-Language': 'en-US',
    'Accept': 'application/json;version=2.0',
    'Content-Type': 'application/json'
  };
}

// Viator interest tags → their category codes
const INTEREST_TO_TAGS = {
  culture:    ['MUSEUM_ART_CULTURE', 'HISTORICAL_HERITAGE', 'ARCHITECTURE'],
  adventure:  ['OUTDOOR_ACTIVITIES', 'EXTREME_SPORTS', 'WATER_SPORTS'],
  food:       ['FOOD_DRINK', 'COOKING_CLASSES'],
  nightlife:  ['NIGHTLIFE_CLUBS'],
  beach:      ['BEACH_WATER_ACTIVITIES', 'SNORKELING_DIVING'],
  nature:     ['NATURE_WILDLIFE', 'NATIONAL_PARKS'],
  shopping:   ['SHOPPING'],
  wellness:   ['WELLNESS_SPA', 'YOGA']
};

function interestsToTags(interests = []) {
  const tags = new Set();
  for (const interest of interests) {
    const mapped = INTEREST_TO_TAGS[interest.toLowerCase()] || [];
    mapped.forEach(t => tags.add(t));
  }
  return [...tags];
}

async function searchActivities({ destination, date, interests, budget, partySize }) {
  if (!destination) {
    return { success: false, error: 'destination is required for activity search.' };
  }

  const axios = getAxios();
  const tags = interestsToTags(Array.isArray(interests) ? interests : []);

  const body = {
    filtering: {
      destination,
      ...(tags.length ? { tags } : {}),
      ...(budget ? { price: { max: parseFloat(budget) } } : {})
    },
    sorting: { sort: 'TRAVELER_RATING', order: 'DESCENDING' },
    pagination: { start: 1, count: 12 },
    currency: 'GBP'
  };

  const resp = await axios.post(`${VIATOR_BASE}/products/search`, body, {
    headers: viatorHeaders(),
    timeout: 15000
  });

  const products = resp.data?.products || [];
  if (!products.length) {
    return { success: true, data: [], text: `No activities found in ${destination}.` };
  }

  const formatted = products.slice(0, 8).map(formatActivity);
  return {
    success: true,
    data: formatted,
    text: buildActivitySummary(formatted, destination, interests)
  };
}

async function getActivityDetails({ productCode }) {
  if (!productCode) return { success: false, error: 'productCode is required.' };
  const axios = getAxios();
  const resp = await axios.get(`${VIATOR_BASE}/products/${productCode}`, {
    headers: viatorHeaders(),
    timeout: 12000
  });
  const product = resp.data;
  if (!product) return { success: false, error: 'Activity not found.' };
  return { success: true, data: formatActivity(product) };
}

function formatActivity(product) {
  const review = product.reviews?.combinedAverageRating;
  const reviewCount = product.reviews?.totalReviews;
  const price = product.pricing?.summary?.fromPrice;
  const duration = product.duration;

  return {
    id: product.productCode,
    title: product.title,
    description: (product.description || '').slice(0, 200),
    rating: review ? Math.round(review * 10) / 10 : null,
    reviewCount: reviewCount || 0,
    priceFrom: price ? parseFloat(price) : null,
    currency: product.pricing?.currency || 'GBP',
    durationMinutes: duration?.fixedDurationInMinutes || null,
    durationLabel: duration?.label || null,
    categories: (product.tags || []).slice(0, 3),
    images: product.images?.slice(0, 1).map(i => i.variants?.[0]?.url) || [],
    bookingUrl: product.productUrl || null
  };
}

function buildActivitySummary(activities, destination, interests) {
  const interestLabel = Array.isArray(interests) && interests.length
    ? ` (${interests.join(', ')})` : '';
  const lines = [`Found ${activities.length} activities in ${destination}${interestLabel}:`];
  for (const a of activities) {
    const rating = a.rating ? ` ★${a.rating}` : '';
    const price = a.priceFrom ? ` from £${a.priceFrom}` : '';
    const dur = a.durationLabel ? ` · ${a.durationLabel}` : '';
    lines.push(`- ${a.title}${rating}${price}${dur}`);
  }
  return lines.join('\n');
}

async function execute(userId, action, params) {
  if (!process.env.VIATOR_API_KEY) {
    return { success: false, error: 'Activity search is not configured (VIATOR_API_KEY missing).' };
  }
  try {
    if (action === 'search_activities') return await searchActivities(params || {});
    if (action === 'get_activity_details') return await getActivityDetails(params || {});
    return { success: false, error: `Unknown activity action: ${action}` };
  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Activity search failed';
    return { success: false, error: msg };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };

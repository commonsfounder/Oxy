const DEFAULT_TRIP_TYPE = 'unknown';

const REQUIRED_FIELDS = ['origin', 'destination', 'date', 'partySize', 'budget', 'transportMode'];

// Full schema extracted from user messages — superset of REQUIRED_FIELDS
const EXTRACTION_SCHEMA = {
  origin: '',
  destination: '',
  date: '',
  endDate: '',
  duration: '',
  partySize: '',
  budget: '',
  budgetTier: '',               // budget | mid | luxury — inferred from context
  transportMode: '',
  accommodationPreference: '',  // hotel | boutique | airbnb | hostel | luxury
  activityPreferences: [],      // culture | adventure | food | nightlife | beach | nature | shopping
  dietaryRequirements: [],      // vegetarian | vegan | halal | kosher | gluten-free
  travelStyle: '',              // slow | balanced | fast-paced
  tripGoals: '',                // "relaxation", "sightseeing", "food tour", etc.
  constraints: [],              // direct_or_fewest_changes | accessibility_required | pet_friendly | budget_sensitive | time_sensitive
  tripType: DEFAULT_TRIP_TYPE   // leisure | business | family | couple | solo
};

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractFirst(patterns, text) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return normalizeText(match[1].replace(/[?.!,;]+$/g, ''));
  }
  return '';
}

// --- Regex extraction (fast, deterministic, always available as fallback) ---

function extractTravelRequirements(message = '', context = {}) {
  const text = normalizeText(message);
  const lower = text.toLowerCase();
  const prior = context.requirements || {};

  const requirements = {
    origin: prior.origin || extractFirst([
      /\bfrom\s+(.+?)\s+(?:to|into|towards|for)\b/i,
      /\bfrom\s+(.+?)\s+(?:today|tomorrow|tonight|this\s+weekend|next\s+weekend|next\s+\w+|with|under|by|around)\b/i,
      /\bfrom\s+(.+?)(?:[?.!,;]|$)/i,
      /\bleaving\s+(?:from\s+)?(.+?)\s+(?:to|for|on|at)\b/i,
      /\bdepart(?:ing)?\s+(?:from\s+)?(.+?)\s+(?:to|for|on|at)\b/i
    ], text),
    destination: prior.destination || extractFirst([
      /\b(?:to|in|into|visiting|visit|for)\s+(.+?)\s+(?:from|on|for|with|under|by|around|tomorrow|today|next\s+\w+|this\s+\w+)\b/i,
      /\b(?:trip|holiday|vacation|weekend|getaway)\s+(?:to|in)\s+(.+?)(?:[?.!,;]|$)/i,
      /\b(?:go|get|fly|travel|train|drive)\s+to\s+(.+?)(?:[?.!,;]|$)/i
    ], text),
    date: prior.date || extractFirst([
      /\b(today|tomorrow|tonight|this\s+weekend|next\s+weekend)\b/i,
      /\b(next\s+(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/i,
      /\b(?:on|for)\s+((?:mon|tues|wednes|thurs|fri|satur|sun)day\b[^,.;?]*)/i,
      /\b(?:on|for)\s+(\d{1,2}(?:st|nd|rd|th)?\s+\w+(?:\s+\d{4})?)\b/i,
      /\bin\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+\d{4})?\b/i
    ], text),
    endDate: prior.endDate || extractFirst([
      /\buntil\s+(.+?)(?:[?.!,;]|$)/i,
      /\breturning\s+(?:on\s+)?(.+?)(?:[?.!,;]|$)/i
    ], text),
    duration: prior.duration || extractFirst([
      /\b(\d+)\s*[-\s]?\s*(?:day|night|week)s?\s+(?:trip|holiday|vacation|stay)\b/i,
      /\b(?:for\s+)?(\d+)\s+(?:day|night|week)s?\b/i
    ], text),
    partySize: prior.partySize || extractFirst([
      /\b(?:for|with)\s+(\d+)\s+(?:people|adults|kids|children|travellers|travelers|guests)\b/i,
      /\b(\d+)\s+(?:people|adults|kids|children|travellers|travelers|guests)\b/i
    ], text),
    budget: prior.budget || extractBudget(text),
    budgetTier: prior.budgetTier || extractBudgetTier(lower),
    transportMode: prior.transportMode || extractTransportMode(lower),
    accommodationPreference: prior.accommodationPreference || extractAccommodationPreference(lower),
    activityPreferences: mergeConstraints(prior.activityPreferences, extractActivityPreferences(lower)),
    dietaryRequirements: mergeConstraints(prior.dietaryRequirements, extractDietaryRequirements(lower)),
    travelStyle: prior.travelStyle || extractTravelStyle(lower),
    tripGoals: prior.tripGoals || extractTripGoals(lower),
    constraints: mergeConstraints(prior.constraints, extractConstraints(lower)),
    tripType: prior.tripType || extractTripType(lower)
  };

  if (!requirements.destination && context.resolvedContext?.kind === 'route') {
    requirements.destination = context.resolvedContext.input?.destination || context.resolvedContext.label || '';
  }

  return compactObject(requirements);
}

function extractBudget(text) {
  const match = text.match(/\b(?:under|below|max|maximum|budget(?:\s+of)?|less\s+than|with\s+a)\s*(£|\$|€)?\s*(\d+[\d,]*(?:\.\d+)?)(?:\s*(?:budget|per\s+person|pp|total|each))?\b/i);
  if (!match) return '';
  return `${match[1] || ''}${match[2]}`;
}

function extractBudgetTier(lower) {
  if (/\b(luxury|high[- ]end|5[- ]star|five[- ]star|premium|exclusive)\b/.test(lower)) return 'luxury';
  if (/\b(mid[- ]range|moderate|comfortable|reasonable)\b/.test(lower)) return 'mid';
  if (/\b(budget|cheap|backpack|hostel|affordable|low[- ]cost)\b/.test(lower)) return 'budget';
  return '';
}

function extractTransportMode(lower) {
  if (/\b(train|rail)\b/.test(lower)) return 'train';
  if (/\b(fly|flight|plane|airport)\b/.test(lower)) return 'flight';
  if (/\b(bus|coach)\b/.test(lower)) return 'bus';
  if (/\b(drive|car|road trip)\b/.test(lower)) return 'car';
  if (/\b(walk|walking)\b/.test(lower)) return 'walking';
  return '';
}

function extractAccommodationPreference(lower) {
  if (/\b(luxury|5[- ]star|five[- ]star|high[- ]end)\b/.test(lower) && /\b(hotel|resort|stay)\b/.test(lower)) return 'luxury';
  if (/\b(boutique)\b/.test(lower)) return 'boutique';
  if (/\b(airbnb|apartment|self[- ]catering)\b/.test(lower)) return 'apartment';
  if (/\b(hostel)\b/.test(lower)) return 'hostel';
  if (/\b(hotel)\b/.test(lower)) return 'hotel';
  return '';
}

function extractActivityPreferences(lower) {
  const prefs = [];
  if (/\b(museum|gallery|culture|cultural|history|historical|art)\b/.test(lower)) prefs.push('culture');
  if (/\b(hike|hiking|outdoors|nature|trekking|adventure|climbing)\b/.test(lower)) prefs.push('adventure');
  if (/\b(food|foodie|restaurant|dining|cuisine|eat|culinary)\b/.test(lower)) prefs.push('food');
  if (/\b(nightlife|bar|club|party|drinks)\b/.test(lower)) prefs.push('nightlife');
  if (/\b(beach|sea|ocean|coast|snorkel|swim)\b/.test(lower)) prefs.push('beach');
  if (/\b(nature|wildlife|safari|national park)\b/.test(lower)) prefs.push('nature');
  if (/\b(shopping|markets|boutiques)\b/.test(lower)) prefs.push('shopping');
  if (/\b(spa|wellness|relax|yoga|mindfulness)\b/.test(lower)) prefs.push('wellness');
  return prefs;
}

function extractDietaryRequirements(lower) {
  const reqs = [];
  if (/\bvegan\b/.test(lower)) reqs.push('vegan');
  else if (/\bvegetarian\b/.test(lower)) reqs.push('vegetarian');
  if (/\bhalal\b/.test(lower)) reqs.push('halal');
  if (/\bkosher\b/.test(lower)) reqs.push('kosher');
  if (/\bgluten[- ]free\b/.test(lower)) reqs.push('gluten-free');
  if (/\bdairy[- ]free\b/.test(lower)) reqs.push('dairy-free');
  if (/\bnut[- ]free\b|\ballergy\b/.test(lower)) reqs.push('nut-free');
  return reqs;
}

function extractTravelStyle(lower) {
  if (/\bslow\b|\brelax\b|\bleisurely\b|\blaid[- ]back\b/.test(lower)) return 'slow';
  if (/\bfast[- ]paced\b|\bpack\s+in\b|\bfit\s+in\s+as\s+much\b/.test(lower)) return 'fast-paced';
  return '';
}

function extractTripGoals(lower) {
  if (/\bromantic\b|\bhoneymoon\b|\banniversary\b/.test(lower)) return 'romantic getaway';
  if (/\badventure\b|\bthrill\b/.test(lower)) return 'adventure';
  if (/\brelax\b|\bde[- ]stress\b|\brest\b/.test(lower)) return 'relaxation';
  if (/\bsightseeing\b|\btourist\b/.test(lower)) return 'sightseeing';
  if (/\bfood\b|\bcuisine\b|\bgastronomic\b/.test(lower)) return 'food tour';
  return '';
}

function extractTripType(lower) {
  if (/\b(work|business|conference|meeting)\b/.test(lower)) return 'business';
  if (/\b(family|kids|children)\b/.test(lower)) return 'family';
  if (/\b(romantic|anniversary|couple)\b/.test(lower)) return 'couple';
  if (/\b(solo|alone|by myself)\b/.test(lower)) return 'solo';
  if (/\b(weekend|getaway|holiday|vacation)\b/.test(lower)) return 'leisure';
  return DEFAULT_TRIP_TYPE;
}

function extractConstraints(lower) {
  const constraints = [];
  if (/\bdirect\b|\bno changes\b|\bwithout changes\b/.test(lower)) constraints.push('direct_or_fewest_changes');
  if (/\baccessible\b|\bwheelchair\b|\bstep[- ]free\b/.test(lower)) constraints.push('accessibility_required');
  if (/\bpet\b|\bdog\b/.test(lower)) constraints.push('pet_friendly');
  if (/\bcheap\b|\blow cost\b|\bbudget\b/.test(lower)) constraints.push('budget_sensitive');
  if (/\bquick\b|\bfastest\b|\basap\b/.test(lower)) constraints.push('time_sensitive');
  return constraints;
}

function mergeConstraints(prior = [], next = []) {
  return [...new Set([...(Array.isArray(prior) ? prior : []), ...next])];
}

function compactObject(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== null && value !== '';
  }));
}

// --- Gemini model-assisted extraction (async, used when callModel is available) ---

const EXTRACTION_PROMPT_PREFIX = `Extract travel planning requirements from the user message below. Return ONLY valid JSON matching this schema (omit keys that are unknown or empty):

Schema:
{
  "origin": "departure city or location",
  "destination": "destination city or country",
  "date": "start date or date range as stated by user",
  "endDate": "return/end date if mentioned",
  "duration": "number of days or nights if mentioned",
  "partySize": "number of travellers",
  "budget": "budget amount with currency symbol",
  "budgetTier": "budget | mid | luxury",
  "transportMode": "train | flight | car | bus | walking",
  "accommodationPreference": "hotel | boutique | airbnb | hostel | luxury",
  "activityPreferences": ["culture","adventure","food","nightlife","beach","nature","shopping","wellness"],
  "dietaryRequirements": ["vegetarian","vegan","halal","kosher","gluten-free","dairy-free"],
  "travelStyle": "slow | balanced | fast-paced",
  "tripGoals": "brief phrase describing the main goal",
  "constraints": ["direct_or_fewest_changes","accessibility_required","pet_friendly","budget_sensitive","time_sensitive"],
  "tripType": "leisure | business | family | couple | solo"
}

Retain any known context from prior turn. Only output JSON — no prose.

Prior known requirements: `;

async function extractTravelRequirementsWithModel(message, context, callModel) {
  const prior = context.requirements || {};
  const prompt = EXTRACTION_PROMPT_PREFIX + JSON.stringify(prior) + '\n\nUser message: ' + message;
  try {
    const raw = await callModel(prompt);
    if (!raw) return null;
    // Strip markdown fences if model wraps in ```json
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const parsed = JSON.parse(clean);
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    // Merge arrays with prior rather than replacing them
    if (prior.constraints) parsed.constraints = mergeConstraints(prior.constraints, parsed.constraints);
    if (prior.activityPreferences) parsed.activityPreferences = mergeConstraints(prior.activityPreferences, parsed.activityPreferences);
    if (prior.dietaryRequirements) parsed.dietaryRequirements = mergeConstraints(prior.dietaryRequirements, parsed.dietaryRequirements);
    return compactObject(parsed);
  } catch {
    return null;
  }
}

// --- State machine ---

function missingTravelFields(requirements = {}) {
  return REQUIRED_FIELDS.filter(field => {
    const value = requirements[field];
    return Array.isArray(value) ? value.length === 0 : !value;
  });
}

function generateFollowUpQuestions(requirements = {}, options = {}) {
  const missing = missingTravelFields(requirements);
  const maxQuestions = options.maxQuestions || 3;
  const questions = [];
  const push = (field, question) => {
    if (missing.includes(field) && questions.length < maxQuestions) questions.push({ field, question });
  };

  push('destination', 'Where are you travelling to?');
  push('origin', 'Where will you be starting from?');
  push('date', 'When do you want to travel?');
  push('partySize', 'How many people is this for?');
  push('budget', 'What budget should I stay within?');
  push('transportMode', 'Do you prefer train, flight, driving, or another transport mode?');
  return questions;
}

function isTravelPlanningRequest(message = '') {
  const lower = normalizeText(message).toLowerCase();
  if (!lower) return false;
  return /\b(plan|organise|organize|book|find|build|sort|help me with)\b/.test(lower)
    && /\b(trip|travel|holiday|vacation|itinerary|weekend|getaway|flight|train|hotel|stay)\b/.test(lower);
}

function mergeTravelContext(previous = {}, requirements = {}) {
  return {
    ...previous,
    requirements: {
      ...(previous.requirements || {}),
      ...requirements,
      constraints: mergeConstraints(previous.requirements?.constraints, requirements.constraints),
      activityPreferences: mergeConstraints(previous.requirements?.activityPreferences, requirements.activityPreferences),
      dietaryRequirements: mergeConstraints(previous.requirements?.dietaryRequirements, requirements.dietaryRequirements)
    },
    updatedAt: new Date().toISOString()
  };
}

// async: uses Gemini extraction when callModel is provided, falls back to regex
async function buildTravelConciergeState(message = '', previous = {}, options = {}) {
  const priorContext = { requirements: previous.requirements || {}, resolvedContext: options.resolvedContext };
  let requirements;

  if (options.callModel) {
    requirements = await extractTravelRequirementsWithModel(message, priorContext, options.callModel);
    if (!requirements) {
      // ponytail: regex fallback if model fails or returns garbage
      requirements = extractTravelRequirements(message, priorContext);
    }
  } else {
    requirements = extractTravelRequirements(message, priorContext);
  }

  const state = mergeTravelContext(previous, requirements);
  const followUps = generateFollowUpQuestions(state.requirements, { maxQuestions: options.maxQuestions || 3 });
  return {
    intent: isTravelPlanningRequest(message) || Boolean(previous.active) ? 'travel_concierge' : 'general',
    active: isTravelPlanningRequest(message) || Boolean(previous.active),
    requirements: state.requirements,
    followUps,
    missing: missingTravelFields(state.requirements),
    updatedAt: state.updatedAt
  };
}

function buildTravelContextBlock(state) {
  if (!state?.active) return '';
  const lines = [
    'Travel concierge planning state:',
    `Known requirements: ${JSON.stringify(state.requirements || {})}`,
    `Missing requirements: ${(state.missing || []).join(', ') || 'none'}`
  ];
  if (state.followUps?.length) {
    lines.push(`Ask at most one natural follow-up next, prioritising: ${state.followUps.map(q => q.question).join(' | ')}`);
  }
  lines.push('Do not invent prices, availability, schedules, or booking confirmations. Use connected actions/search when live facts are needed. Respect constraints and keep the plan revisable across turns.');
  return lines.join('\n');
}

module.exports = {
  REQUIRED_FIELDS,
  EXTRACTION_SCHEMA,
  buildTravelConciergeState,
  buildTravelContextBlock,
  extractTravelRequirements,
  extractTravelRequirementsWithModel,
  generateFollowUpQuestions,
  isTravelPlanningRequest,
  mergeTravelContext,
  missingTravelFields
};

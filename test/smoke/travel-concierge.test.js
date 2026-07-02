const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTravelConciergeState,
  buildTravelContextBlock,
  extractTravelRequirements,
  extractTravelRequirementsWithModel,
  generateFollowUpQuestions,
  isTravelPlanningRequest,
  missingTravelFields
} = require('../../api/services/travel-concierge');

test('detects natural language travel planning requests', () => {
  assert.equal(isTravelPlanningRequest('plan a weekend trip to Paris for two under £600'), true);
  assert.equal(isTravelPlanningRequest('what is the weather in Paris?'), false);
});

test('extracts destination, origin, date, budget, party size, and constraints', () => {
  const requirements = extractTravelRequirements('Plan a train trip from Birmingham to Paris next weekend for 2 people under £600, direct if possible');
  assert.equal(requirements.origin, 'Birmingham');
  assert.equal(requirements.destination, 'Paris');
  assert.equal(requirements.date, 'next weekend');
  assert.equal(requirements.partySize, '2');
  assert.equal(requirements.budget, '£600');
  assert.equal(requirements.transportMode, 'train');
  assert.ok(requirements.constraints.includes('direct_or_fewest_changes'));
});

test('extracts expanded fields: accommodation, activities, dietary, style', () => {
  const r = extractTravelRequirements('I want a luxury boutique hotel in Tokyo, I\'m vegan and love museums and nightlife, slow travel please');
  assert.equal(r.accommodationPreference, 'boutique');
  assert.ok(r.activityPreferences.includes('culture'));
  assert.ok(r.activityPreferences.includes('nightlife'));
  assert.ok(r.dietaryRequirements.includes('vegan'));
  assert.equal(r.travelStyle, 'slow');
  assert.equal(r.budgetTier, 'luxury');
});

test('generates prioritized follow-up questions for missing requirements', () => {
  const questions = generateFollowUpQuestions({ destination: 'Rome' }, { maxQuestions: 2 });
  assert.deepEqual(questions.map(item => item.field), ['origin', 'date']);
});

test('retains context across turns and fills newly supplied requirements', async () => {
  const first = await buildTravelConciergeState('Plan a holiday to Lisbon', {}, { maxQuestions: 3 });
  const second = await buildTravelConciergeState('from Birmingham next Friday with a £500 budget', first, { maxQuestions: 3 });
  assert.equal(second.active, true);
  assert.equal(second.requirements.destination, 'Lisbon');
  assert.equal(second.requirements.origin, 'Birmingham');
  assert.equal(second.requirements.date, 'next Friday');
  assert.equal(second.requirements.budget, '£500');
  assert.ok(second.missing.includes('partySize'));
  assert.ok(second.missing.includes('transportMode'));
});

test('builds a prompt block that forbids invented live facts', async () => {
  const state = await buildTravelConciergeState('Plan a trip to Edinburgh', {}, { maxQuestions: 1 });
  const block = buildTravelContextBlock(state);
  assert.match(block, /Travel concierge planning state/);
  assert.match(block, /Do not invent prices, availability, schedules, or booking confirmations/);
});

test('reports all missing fields for empty travel requirements', () => {
  assert.deepEqual(missingTravelFields({}), ['origin', 'destination', 'date', 'partySize', 'budget', 'transportMode']);
});

test('model extraction falls back to regex when callModel returns null', async () => {
  const state = await buildTravelConciergeState(
    'I want to fly from London to Tokyo in April for 2 people',
    {},
    { callModel: async () => null }
  );
  assert.equal(state.active, true);
  assert.equal(state.requirements.destination, 'Tokyo');
});

test('model extraction falls back to regex when callModel throws', async () => {
  const state = await buildTravelConciergeState(
    'Train trip from Manchester to Edinburgh next Saturday for 1 person under £100',
    {},
    { callModel: async () => { throw new Error('model unavailable'); } }
  );
  assert.equal(state.requirements.transportMode, 'train');
  assert.equal(state.requirements.budget, '£100');
});

test('model extraction merges arrays with prior state', async () => {
  const callModel = async () => JSON.stringify({
    destination: 'Tokyo',
    activityPreferences: ['nightlife'],
    constraints: ['budget_sensitive']
  });
  const prior = {
    active: true,
    requirements: { destination: 'Tokyo', activityPreferences: ['culture'], constraints: ['direct_or_fewest_changes'] }
  };
  const result = await extractTravelRequirementsWithModel('add nightlife and keep it cheap', prior, callModel);
  assert.ok(result.activityPreferences.includes('culture'));
  assert.ok(result.activityPreferences.includes('nightlife'));
  assert.ok(result.constraints.includes('direct_or_fewest_changes'));
  assert.ok(result.constraints.includes('budget_sensitive'));
});

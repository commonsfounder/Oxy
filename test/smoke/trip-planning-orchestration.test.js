// Full plan_itinerary / modify_itinerary orchestration: grounded search, generation, honest text,
// and workspace save/reload/re-save for cross-session editing. Only the outermost I/O is mocked —
// generateBrain and webSearchBrain via a Module._load intercept, agent-workspace by property
// patch — so the real orchestration and itinerary-engine.js both run.

require('dotenv').config();

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

let fakeGenerateBrain = async () => ({ text: '{}' });
let fakeWebSearchBrain = async () => '';
const originalLoad = Module._load;
Module._load = function mockBrainProviderForApiIndex(request, parent, isMain) {
  if (request === './services/brain-provider' && parent && parent.filename && parent.filename.endsWith('api/index.js')) {
    const real = originalLoad.call(this, request, parent, isMain);
    return {
      ...real,
      generateBrain: (...args) => fakeGenerateBrain(...args),
      webSearchBrain: (...args) => fakeWebSearchBrain(...args)
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const app = require('../../api/index');
const agentWorkspace = require('../../api/services/agent-workspace');
Module._load = originalLoad;

const originalReadWorkspaceFile = agentWorkspace.readWorkspaceFile;
const originalWriteWorkspaceFile = agentWorkspace.writeWorkspaceFile;

test.afterEach(() => {
  fakeGenerateBrain = async () => ({ text: '{}' });
  fakeWebSearchBrain = async () => '';
  agentWorkspace.readWorkspaceFile = originalReadWorkspaceFile;
  agentWorkspace.writeWorkspaceFile = originalWriteWorkspaceFile;
});

function fakeItinerary(overrides = {}) {
  return {
    title: 'Bath Weekend',
    destination: 'Bath',
    totalDays: 2,
    estimatedBudget: { total: 180, currency: 'GBP', breakdown: {}, note: 'approximate' },
    days: [
      { day: 1, theme: 'Roman History', morning: { activity: 'Roman Baths', duration: '2 hours', estimatedCost: 24, why: 'The main historic site, best done early before queues' }, afternoon: { activity: 'Pulteney Bridge walk' }, evening: { activity: 'Dinner in the city centre' }, meals: {}, travelTips: '' },
      { day: 2, theme: 'Relaxation', morning: { activity: 'Thermae Bath Spa' }, afternoon: { activity: 'Royal Crescent' }, evening: { activity: 'Return journey' }, meals: {}, travelTips: '' }
    ],
    ...overrides
  };
}

test('plan_itinerary requires a destination', async () => {
  const result = await app.executeAction('user-1', 'plan_itinerary', {});
  assert.equal(result.success, false);
  assert.match(result.error, /destination/);
});

test('plan_itinerary runs a real grounded search, feeds it into generation, and returns an honest itinerary with caveats', async () => {
  let searchPrompt = null;
  fakeWebSearchBrain = async ({ prompt }) => { searchPrompt = prompt; return 'Roman Baths open 9am-6pm, £24 entry. Thermae Bath Spa £40 for 2hrs. Walk from station to centre is 10 minutes.'; };

  let generationPrompt = null;
  fakeGenerateBrain = async ({ contents, config }) => {
    generationPrompt = contents[0].parts[0].text;
    assert.match(config.systemInstruction, /expert travel planner/i);
    return { text: JSON.stringify(fakeItinerary()) };
  };

  const result = await app.executeAction('user-1', 'plan_itinerary', {
    destination: 'Bath', start_date: 'Saturday', duration_days: 2, party_size: 2, budget: 200, budget_currency: '£', interests: ['culture']
  });

  assert.equal(result.success, true);
  assert.match(searchPrompt, /Bath/);
  // The grounded research actually reaches the generation prompt as ground truth.
  assert.match(generationPrompt, /Roman Baths open 9am-6pm/);
  assert.equal(result.groundedResearch, true);
  assert.equal(result.itinerary.destination, 'Bath');
  assert.match(result.text, /Roman Baths/);
  assert.match(result.text, /not live-searched or booked/);
});

test('plan_itinerary is honest when the grounded search fails, rather than silently inventing facts', async () => {
  fakeWebSearchBrain = async () => { throw new Error('search provider down'); };
  fakeGenerateBrain = async () => ({ text: JSON.stringify(fakeItinerary()) });

  const result = await app.executeAction('user-1', 'plan_itinerary', { destination: 'Bath' });
  assert.equal(result.success, true);
  assert.equal(result.groundedResearch, false);
  assert.match(result.text, /couldn't verify current opening hours/);
});

test('plan_itinerary surfaces a real generation failure rather than fabricating an itinerary', async () => {
  fakeWebSearchBrain = async () => 'some research';
  fakeGenerateBrain = async () => ({ text: 'not json' });
  const result = await app.executeAction('user-1', 'plan_itinerary', { destination: 'Bath' });
  assert.equal(result.success, false);
  assert.match(result.error, /Could not build an itinerary/);
});

test('modify_itinerary requires an instruction', async () => {
  const result = await app.executeAction('user-1', 'modify_itinerary', { itinerary: fakeItinerary() });
  assert.equal(result.success, false);
  assert.match(result.error, /instruction/);
});

test('modify_itinerary requires either an inline itinerary or a workspace_path', async () => {
  const result = await app.executeAction('user-1', 'modify_itinerary', { instruction: 'add more nightlife' });
  assert.equal(result.success, false);
  assert.match(result.error, /workspace_path/);
});

test('modify_itinerary applies a surgical edit to an inline itinerary without a workspace round-trip', async () => {
  fakeGenerateBrain = async ({ contents }) => {
    assert.match(contents[0].parts[0].text, /swap the museum/);
    return {
      text: JSON.stringify({
        changed: true,
        summary: 'Swapped the Roman Baths morning for a walk on Bathwick Meadow',
        days: [{ day: 1, theme: 'Outdoors', morning: { activity: 'Bathwick Meadow walk' }, afternoon: { activity: 'Pulteney Bridge walk' }, evening: { activity: 'Dinner in the city centre' } }, fakeItinerary().days[1]]
      })
    };
  };
  let writeCalled = false;
  agentWorkspace.writeWorkspaceFile = async () => { writeCalled = true; };

  const result = await app.executeAction('user-1', 'modify_itinerary', {
    instruction: 'swap the museum for something outdoors',
    itinerary: fakeItinerary()
  });

  assert.equal(result.success, true);
  assert.equal(result.itinerary.days[0].morning.activity, 'Bathwick Meadow walk');
  // Day 2 untouched, proving this was a surgical edit, not a full regeneration.
  assert.equal(result.itinerary.days[1].morning.activity, 'Thermae Bath Spa');
  assert.equal(result.resaved, false, 'no workspace_path was given, so nothing should be re-saved');
  assert.equal(writeCalled, false);
  assert.match(result.text, /Bathwick Meadow/);
});

test('modify_itinerary loads a previously saved trip from the workspace and re-saves the updated version to the same path', async () => {
  let readPath = null;
  agentWorkspace.readWorkspaceFile = async (supabase, userId, path) => {
    readPath = path;
    return { path, content: JSON.stringify(fakeItinerary()), version: 1 };
  };
  let writtenPath = null;
  let writtenContent = null;
  agentWorkspace.writeWorkspaceFile = async (supabase, userId, path, content) => {
    writtenPath = path;
    writtenContent = content;
  };
  fakeGenerateBrain = async () => ({
    text: JSON.stringify({ changed: true, summary: 'Moved dinner to 8pm', days: fakeItinerary().days })
  });

  const result = await app.executeAction('user-1', 'modify_itinerary', {
    instruction: 'move dinner later',
    workspace_path: 'trips/bath-2026-08-15.json'
  });

  assert.equal(result.success, true);
  assert.equal(readPath, 'trips/bath-2026-08-15.json');
  assert.equal(writtenPath, 'trips/bath-2026-08-15.json');
  assert.ok(JSON.parse(writtenContent).lastModification, 'the re-saved file is the updated, structured itinerary, not prose');
  assert.equal(result.resaved, true);
  assert.match(result.text, /re-saved to trips\/bath-2026-08-15\.json/);
});

test('modify_itinerary is honest when the saved file is not valid itinerary JSON', async () => {
  agentWorkspace.readWorkspaceFile = async () => ({ path: 'trips/bath.json', content: 'Day 1: Roman Baths...' });
  const result = await app.executeAction('user-1', 'modify_itinerary', { instruction: 'add nightlife', workspace_path: 'trips/bath.json' });
  assert.equal(result.success, false);
  assert.match(result.error, /isn't valid itinerary JSON/);
});

test('modify_itinerary is honest when a passed-in itinerary is not valid JSON', async () => {
  const result = await app.executeAction('user-1', 'modify_itinerary', { instruction: 'add nightlife', itinerary: 'not json {' });
  assert.equal(result.success, false);
  assert.match(result.error, /not valid JSON/);
});

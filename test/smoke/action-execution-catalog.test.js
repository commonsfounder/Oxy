const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const {
  ACTION_CONTRACTS,
  buildToolsForGemini,
  actionPromptBlock
} = require('../../api/action-contracts');
const {
  getExecutableActionCatalog,
  validateActionCatalog,
  assertValidActionCatalog,
  buildPublicActionCatalog,
  buildAgentToolsCatalog,
  buildPublicConnectorCatalog,
  buildAgentToolsResponse
} = require('../../api/services/action-catalog');
const { createActionExecution } = require('../../api/services/action-execution');
const { createDeclaredAdapterInvoker } = require('../../api/services/declared-adapter-invoker');
const { IMPLEMENTED_CONNECTORS } = require('../../connectors');

test('every advertised contract has exactly one executable adapter', () => {
  const catalog = getExecutableActionCatalog();
  const ids = new Set(catalog.map(item => item.type));
  assert.equal(ids.size, catalog.length);
  for (const [type, contract] of Object.entries(ACTION_CONTRACTS)) {
    assert.equal(Object.hasOwn(contract, 'adapter'), true, `${type} must declare adapter in its literal`);
    if (contract.availability === 'unavailable') {
      assert.equal(contract.modelVisible, false, `${type} unavailable visibility must be explicit`);
      assert.equal(contract.availability, 'unavailable', `${type} unavailable status must be explicit`);
    }
  }
  for (const item of catalog) {
    assert.ok(item.adapter);
    assert.ok(item.adapter.kind === 'inline' || item.adapter.kind === 'connector');
    assert.notEqual(item.modelVisible, false);
  }
  assert.deepEqual(validateActionCatalog(), []);
});

test('capability discovery does not load runtime connector modules', () => {
  const before = Object.keys(require.cache).filter(path => path.includes('/connectors/'));
  getExecutableActionCatalog();
  const after = Object.keys(require.cache).filter(path => path.includes('/connectors/'));
  assert.deepEqual(after, before);
});

test('fresh catalog child process needs no runtime secrets or connector imports', () => {
  const env = { ...process.env };
  for (const key of ['SUPABASE_URL', 'SUPABASE_KEY', 'OXY_SESSION_SECRET', 'NOTION_TOKEN']) delete env[key];
  const child = spawnSync(process.execPath, ['-e', `
    const catalog = require('./api/services/action-catalog');
    const actions = catalog.getExecutableActionCatalog();
    const loaded = Object.keys(require.cache).filter(file => file.includes('/connectors/') && !file.endsWith('/connectors/index.js'));
    if (!actions.length || loaded.length) process.exit(2);
  `], { cwd: path.resolve(__dirname, '../..'), env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test('startup validation accepts every canonical connector module and each named adapter resolves to it', () => {
  assert.equal(assertValidActionCatalog(), true);
  for (const action of getExecutableActionCatalog()) {
    if (action.adapter.kind === 'connector') {
      assert.ok(action.adapter.id);
      assert.equal(typeof action.adapter.requiresConnection, 'boolean');
    }
  }
});

test('explicit startup validation accepts every real connector descriptor', () => {
  const child = spawnSync(process.execPath, ['-e', "require('./api/services/action-catalog').assertValidActionCatalog({ loadConnectors: true });"], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, SUPABASE_URL: 'https://example.supabase.co', SUPABASE_KEY: 'test-key', OXY_SESSION_SECRET: 'test-secret' },
    encoding: 'utf8'
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test('tools and prompt exclude explicitly unavailable contracts', () => {
  const original = ACTION_CONTRACTS.web_search.modelVisible;
  const originalAvailability = ACTION_CONTRACTS.web_search.availability;
  ACTION_CONTRACTS.web_search.modelVisible = false;
  ACTION_CONTRACTS.web_search.availability = 'unavailable';
  try {
    assert.equal(buildToolsForGemini()[0].functionDeclarations.some(item => item.name === 'web_search'), false);
    assert.equal(actionPromptBlock().includes('"type": "web_search"'), false);
  } finally {
    ACTION_CONTRACTS.web_search.modelVisible = original;
    ACTION_CONTRACTS.web_search.availability = originalAvailability;
  }
});

test('public action catalog is exactly the executable catalog', () => {
  assert.deepEqual(Object.keys(buildPublicActionCatalog()).sort(), getExecutableActionCatalog().map(item => item.type).sort());
  assert.equal(Object.prototype.hasOwnProperty.call(buildPublicActionCatalog(), 'mcp_tool'), false);
});

test('agent tools are derived from the executable catalog', () => {
  const catalog = getExecutableActionCatalog();
  const { tools, connectorIds } = buildAgentToolsCatalog(['google']);
  assert.deepEqual(tools.map(tool => tool.id).sort(), catalog.map(item => item.type).sort());
  assert.deepEqual([...connectorIds].sort(), [...new Set(catalog
    .filter(item => item.adapter.kind === 'connector')
    .map(item => item.adapter.id))].sort());
  assert.equal(tools.find(tool => tool.id === 'get_emails').available, true);
  assert.equal(tools.find(tool => tool.id === 'search_amazon').available, true);
  assert.equal(tools.some(tool => tool.id === 'mcp_tool'), false);

  const emptyTools = Object.fromEntries(buildAgentToolsCatalog().tools.map(tool => [tool.id, tool]));
  for (const type of ['book_uber', 'search_amazon', 'get_weather', 'track_flight', 'find_place']) {
    assert.equal(emptyTools[type].available, true, `${type} is public functionality and needs no connector row`);
  }
  assert.equal(emptyTools.get_emails.available, false);
  assert.equal(emptyTools.save_to_notion.available, false);
});

test('implemented connector ids come only from named executable adapters', () => {
  const named = new Set(getExecutableActionCatalog()
    .filter(item => item.adapter.kind === 'connector')
    .map(item => item.adapter.id));
  assert.deepEqual([...IMPLEMENTED_CONNECTORS].sort(), [...named].sort());
  assert.equal(IMPLEMENTED_CONNECTORS.has('spotify'), false);
  assert.equal(IMPLEMENTED_CONNECTORS.has('hotels'), false);
});

test('shared public connector payload derives implementation for routes', () => {
  const presentation = [
    { id: 'google', name: 'Google', implemented: true },
    { id: 'reminders', name: 'Reminders', implemented: true },
    { id: 'imessage', name: 'iMessage', implemented: true },
    { id: 'spotify', name: 'Spotify', implemented: true },
    { id: 'hotels', name: 'Hotels', implemented: true },
    { id: 'concierge_account', name: 'Concierge', implemented: true }
  ];
  const payload = buildPublicConnectorCatalog(presentation, ['google']);
  const byId = Object.fromEntries(payload.map(item => [item.id, item]));
  assert.equal(byId.google.implemented, true);
  assert.equal(byId.google.connected, true);
  assert.equal(byId.reminders.implemented, true);
  assert.equal(byId.imessage.implemented, true);
  assert.equal(byId.spotify.implemented, false, 'Apple Music inline actions must not claim Spotify ownership');
  assert.equal(byId.hotels.implemented, false);
  assert.equal(byId.concierge_account.implemented, false);
  assert.equal(byId.concierge_account.connected, false);
});

test('agent tools route payload uses the shared executable connector surface', () => {
  const payload = buildAgentToolsResponse([
    { id: 'google', name: 'Google', icon: 'google', type: 'api', implemented: true },
    { id: 'reminders', name: 'Reminders', icon: 'reminders', type: 'api', implemented: true },
    { id: 'imessage', name: 'iMessage', icon: 'imessage', type: 'handoff', implemented: true },
    { id: 'spotify', name: 'Spotify', icon: 'spotify', type: 'handoff', implemented: true },
    { id: 'hotels', name: 'Hotels', icon: 'hotel', type: 'api', implemented: true },
    { id: 'concierge_account', name: 'Concierge', icon: 'card', type: 'api', implemented: true }
  ], ['google']);
  const byId = Object.fromEntries(payload.connectors.map(item => [item.id, item]));
  assert.equal(payload.tools.some(tool => tool.id === 'mcp_tool'), false);
  assert.equal(byId.google.implemented, true);
  assert.equal(byId.reminders.implemented, true);
  assert.equal(byId.imessage.implemented, true);
  assert.equal(byId.spotify.implemented, false);
  assert.equal(byId.hotels.implemented, false);
  assert.equal(byId.concierge_account.implemented, false);
  assert.equal(Object.hasOwn(byId.google, 'icon'), false, 'route shape should preserve its existing connector fields');
});

test('unknown execution is unavailable without invoking raw effects', async () => {
  let invoked = false;
  const execute = createActionExecution({
    invokeAdapter: async () => { invoked = true; return { success: true }; },
    setPendingAction: async () => {},
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });
  const result = await execute('user-1', [{ type: 'not_registered', input: {} }]);
  assert.equal(invoked, false);
  assert.equal(result[0].result.outcome, 'unavailable');
  assert.equal(result[0].result.unavailable, true);
});

test('invalid adapter registration is reported instead of silently advertised', () => {
  const contract = ACTION_CONTRACTS.calculate;
  const original = contract.adapter;
  contract.adapter = { kind: 'connector', id: 'does-not-exist' };
  try {
    assert.match(validateActionCatalog().join('\n'), /calculate references unknown connector|calculate has no valid/);
    assert.throws(() => assertValidActionCatalog(), /Invalid action catalog/);
  } finally {
    contract.adapter = original;
  }
});

test('api startup assertion rejects a malformed explicit adapter', () => {
  const child = spawnSync(process.execPath, ['-e', `
    const contracts = require('./api/action-contracts');
    contracts.ACTION_CONTRACTS.calculate.adapter = { kind: 'connector', id: 'missing' };
    require('./api/index');
  `], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, SUPABASE_URL: 'https://example.supabase.co', SUPABASE_KEY: 'test-key', OXY_SESSION_SECRET: 'test-secret', GEMINI_API_KEY: 'test-key' },
    encoding: 'utf8'
  });
  assert.notEqual(child.status, 0);
  assert.match(`${child.stderr}${child.stdout}`, /Invalid action catalog/);
});

test('sequential and parallel dry-runs never invoke raw effects', async () => {
  let invocations = 0;
  const execute = createActionExecution({
    invokeAdapter: async () => { invocations += 1; return { success: true }; },
    setPendingAction: async () => {},
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });
  const actions = [
    { type: 'calculate', input: { expression: '1+1' } },
    { type: 'mcp_tool', input: { name: 'x' } }
  ];
  const [parallel, sequential] = await Promise.all([
    execute('user-1', actions, { dryRun: true }),
    execute('user-1', actions, { dryRun: true, sequential: true })
  ]);
  assert.equal(invocations, 0);
  assert.deepEqual(parallel.map(item => item.result.outcome), ['simulated', 'unavailable']);
  assert.deepEqual(sequential.map(item => item.result.outcome), ['simulated', 'unavailable']);
});

test('declared adapter reaches the injected boundary without a second routing decision', async () => {
  const seen = [];
  const execute = createActionExecution({
    invokeAdapter: async payload => {
      seen.push(payload);
      return { success: false, outcome: 'handoff_required', handoffRequired: true, text: 'Open it.' };
    },
    setPendingAction: async () => {},
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });
  await execute('user-1', [{ type: 'search_amazon', input: { query: 'headphones' } }]);
  assert.equal(seen[0].adapter.kind, 'connector');
  assert.equal(seen[0].adapter.id, 'amazon');
  assert.equal(seen[0].type, 'search_amazon');
});

test('queued display content remains incomplete until a display acknowledges it', async () => {
  const execute = createActionExecution({
    invokeAdapter: async () => ({
      success: false,
      outcome: 'incomplete',
      incomplete: true,
      text: 'Queued for the paired display.'
    }),
    setPendingAction: async () => {},
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });
  const [entry] = await execute('user-1', [{
    type: 'render_to_display',
    input: { display_id: 'display-1', title: 'Dinner', body: '7:30pm' }
  }], { userMessage: 'Put dinner on my display' });
  assert.equal(entry.result.outcome, 'incomplete');
  assert.equal(entry.result.success, false);
});

test('a durable delegation owns the turn and prevents sibling effects', async () => {
  const invoked = [];
  const execute = createActionExecution({
    invokeAdapter: async ({ type }) => {
      invoked.push(type);
      return type === 'create_agent_task'
        ? { success: false, outcome: 'incomplete', delegatedTask: true, text: 'Queued.' }
        : { success: true, text: 'Should not run.' };
    },
    setPendingAction: async () => {},
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });

  const results = await execute('user-1', [
    { type: 'create_agent_task', input: { goal: 'Keep checking this' } },
    { type: 'calculate', input: { expression: '1+1' } }
  ]);

  assert.deepEqual(invoked, ['create_agent_task']);
  assert.equal(results.length, 1);
  assert.equal(results[0].result.delegatedTask, true);
});

test('review-gated dry-run never parks or invokes, in either scheduler mode', async () => {
  let pending = 0;
  let invoked = 0;
  const execute = createActionExecution({
    invokeAdapter: async () => { invoked += 1; return { success: true }; },
    setPendingAction: async () => { pending += 1; },
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });
  const action = { type: 'create_calendar_event', input: { title: 'x', start_date: '2026-09-01T10:00:00Z', end_date: '2026-09-01T11:00:00Z' } };
  const [parallel, sequential] = await Promise.all([
    execute('u', [action], { dryRun: true }),
    execute('u', [action], { dryRun: true, sequential: true })
  ]);
  assert.equal(pending, 0);
  assert.equal(invoked, 0);
  assert.equal(parallel[0].result.outcome, 'simulated');
  assert.equal(sequential[0].result.outcome, 'simulated');
});

test('representative inline, connector, handoff, browser, Stripe and reminder seams use declared adapters', async () => {
  const seen = [];
  const execute = createActionExecution({
    invokeAdapter: async payload => {
      seen.push(payload);
      return { success: true, text: 'injected proof' };
    },
    setPendingAction: async () => { throw new Error('review should be bypassed in this seam test'); },
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });
  const result = await execute('u', [
    { type: 'find_place', input: { query: 'coffee' } },
    { type: 'book_uber', input: { destination: 'home' } },
    { type: 'run_browser_task', input: {} },
    { type: 'stripe_charge', input: { amount: 500, description: 'test' } },
    { type: 'create_reminder', input: { title: 'Call Mum', due_date: '2026-09-01' } }
  ], { bypassReview: true, sequential: true });
  assert.equal(result.length, 5);
  assert.deepEqual(seen.map(item => [item.type, item.adapter.kind, item.adapter.id || null]), [
    ['find_place', 'connector', 'maps'],
    ['book_uber', 'connector', 'uber'],
    ['run_browser_task', 'inline', null],
    ['stripe_charge', 'inline', null],
    ['create_reminder', 'inline', null]
  ]);
});

test('Action Execution reaches production adapter routing and preserves real outcomes', async () => {
  const pending = [];
  const effects = [];
  const inline = async ({ type }) => {
    effects.push(type);
    if (type === 'run_browser_task') return { success: false, outcome: 'handoff_required', handoffRequired: true, text: 'Browser is ready.' };
    if (type === 'stripe_charge') return { success: true, receipt: { id: 'pi_fake_once', amount: 1200 } };
    if (type === 'create_reminder') return { success: false, outcome: 'handoff_required', handoffRequired: true, nativeExecution: 'reminder', text: 'Reminder ready.' };
    throw new Error(`unexpected inline action: ${type}`);
  };
  const connector = async ({ connectorId, type }) => {
    effects.push(`${connectorId}:${type}`);
    if (connectorId === 'maps') return { success: true, places: [{ name: 'Cafe' }], text: 'Cafe found.' };
    if (connectorId === 'notion') return { success: true, pageId: 'page_fake', text: 'Saved.' };
    if (connectorId === 'uber') return { success: false, outcome: 'handoff_required', handoffRequired: true, deepLink: 'uber://ride', text: 'Uber opened.' };
    if (connectorId === 'google') return { success: true, eventId: 'event_fake', text: 'Calendar updated.' };
    throw new Error(`unexpected connector: ${connectorId}`);
  };
  const invokeAdapter = createDeclaredAdapterInvoker({
    executeInline: inline,
    dispatchConnector: connector,
    getEnabledConnectors: async () => ['notion', 'uber', 'google']
  });
  const execute = createActionExecution({
    invokeAdapter,
    setPendingAction: async (_userId, action) => pending.push(action.type),
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });

  const completed = await execute('u', [
    { type: 'save_to_notion', input: { content: 'Remember this.' } },
    { type: 'find_place', input: { query: 'coffee' } },
    { type: 'book_uber', input: { destination: 'home' } },
    { type: 'run_browser_task', input: { goal: 'find shoes' } },
    { type: 'create_reminder', input: { title: 'Call Mum', due_date: '2026-09-01' } }
  ], { sequential: true });
  assert.deepEqual(completed.map(item => item.result.outcome), [
    'completed', 'completed', 'handoff_required', 'handoff_required', 'handoff_required'
  ]);
  assert.equal(completed[0].result.pageId, 'page_fake');
  assert.equal(completed[2].result.handoffRequired, true);
  assert.equal(completed[4].result.nativeExecution, 'reminder');

  const calendar = { type: 'create_calendar_event', input: { title: 'Dentist', start_date: '2026-09-01T10:00:00Z', end_date: '2026-09-01T11:00:00Z' } };
  const review = await execute('u', [calendar]);
  assert.equal(review[0].result.outcome, 'awaiting_user');
  assert.deepEqual(pending, ['create_calendar_event']);
  const approved = await execute('u', [calendar], { bypassReview: true });
  assert.equal(approved[0].result.outcome, 'completed');
  assert.equal(approved[0].result.eventId, 'event_fake');

  const beforeStripe = effects.filter(effect => effect === 'stripe_charge').length;
  const stripeReview = await execute('u', [{ type: 'stripe_charge', input: { amount: 1200, description: 'test' } }]);
  assert.equal(stripeReview[0].result.outcome, 'awaiting_user');
  const stripeApproved = await execute('u', [{ type: 'stripe_charge', input: { amount: 1200, description: 'test' } }], { bypassReview: true });
  assert.equal(stripeApproved[0].result.outcome, 'completed');
  assert.deepEqual(stripeApproved[0].result.receipt, { id: 'pi_fake_once', amount: 1200 });
  assert.equal(effects.filter(effect => effect === 'stripe_charge').length - beforeStripe, 1);
});

test('public functionality connectors execute without an enabled account row', async () => {
  const invoked = [];
  const invokeAdapter = createDeclaredAdapterInvoker({
    executeInline: async () => ({ success: true }),
    dispatchConnector: async ({ connectorId }) => {
      invoked.push(connectorId);
      return { success: true, text: `${connectorId} result` };
    },
    getEnabledConnectors: async () => []
  });
  const execute = createActionExecution({
    invokeAdapter,
    setPendingAction: async () => {},
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });
  const results = await execute('u', [
    { type: 'book_uber', input: { destination: 'home' } },
    { type: 'search_amazon', input: { query: 'headphones' } },
    { type: 'get_weather', input: { city: 'London' } },
    { type: 'track_flight', input: { flight: 'BA123' } }
  ], { sequential: true });
  assert.deepEqual(invoked, ['uber', 'amazon', 'weather', 'flights']);
  assert.deepEqual(results.map(item => item.result.outcome), ['completed', 'completed', 'completed', 'completed']);
});

test('account connectors remain unavailable without authorization', async () => {
  let invoked = 0;
  const invokeAdapter = createDeclaredAdapterInvoker({
    executeInline: async () => ({ success: true }),
    dispatchConnector: async () => { invoked += 1; return { success: true }; },
    getEnabledConnectors: async () => []
  });
  const execute = createActionExecution({
    invokeAdapter,
    setPendingAction: async () => {},
    logAction: async () => {},
    invalidateUserContextCache: () => {}
  });
  const results = await execute('u', [
    { type: 'save_to_notion', input: { content: 'note' } },
    { type: 'get_emails', input: {} }
  ], { sequential: true });
  assert.deepEqual(results.map(item => item.result.outcome), ['unavailable', 'unavailable']);
  assert.equal(invoked, 0);
});

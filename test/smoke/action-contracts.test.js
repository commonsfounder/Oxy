const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ACTION_CONTRACTS,
  actionPromptBlock,
  buildActionRecovery,
  applyActionContractResultMetadata,
  validateActionWithContract
} = require('../../api/action-contracts');

test('Core 20 actions have contracts for reliability work', () => {
  const expected = [
    'find_place',
    'book_uber',
    'send_message',
    'send_email',
    'get_emails',
    'search_emails',
    'create_reminder',
    'create_calendar_event',
    'get_calendar_events',
    'search_trains',
    'play_music',
    'order_uber_eats',
    'order_deliveroo',
    'search_netflix_title',
    'add_to_netflix_list',
    'send_telegram',
    'get_telegram_contacts',
    'forget_memory',
    'make_call',
    'generate_visual',
    'create_diagram',
    'create_presentation'
  ];

  for (const action of expected) {
    assert.ok(ACTION_CONTRACTS[action], `${action} missing action contract`);
    assert.ok(ACTION_CONTRACTS[action].risk, `${action} missing risk`);
    assert.ok(ACTION_CONTRACTS[action].successSummary, `${action} missing success summary`);
    assert.ok(ACTION_CONTRACTS[action].failureSummary, `${action} missing failure summary`);
  }
});

test('Core actions validate required fields consistently', () => {
  for (const [type, contract] of Object.entries(ACTION_CONTRACTS)) {
    const input = {};
    for (const field of contract.required || []) input[field] = `sample ${field}`;
    const result = validateActionWithContract({ type, input }, `${type} smoke`);
    assert.equal(result, null, `${type} rejected complete sample input`);
  }
});

test('high-risk communication actions require review', () => {
  for (const action of ['send_message', 'send_email', 'book_uber', 'make_call']) {
    assert.equal(ACTION_CONTRACTS[action].confirmation, 'review_required');
    assert.equal(ACTION_CONTRACTS[action].executionMode, 'review');
  }
});

test('email saying Y can omit subject but not body', () => {
  assert.equal(validateActionWithContract({
    type: 'send_email',
    input: { to: 'josh@example.com', body: 'Can we meet tomorrow?' }
  }, 'email Josh saying can we meet tomorrow'), null);

  const missing = validateActionWithContract({
    type: 'send_email',
    input: { to: 'josh@example.com' }
  }, 'email Josh');
  assert.match(missing.error, /body/);
});

test('send_email prompt contract tells the model to draft a complete email', () => {
  const prompt = actionPromptBlock();
  assert.match(prompt, /polished complete email draft/);
  assert.match(prompt, /Do not ask for a subject/);
  assert.match(prompt, /Do not use stiff cliches/);
});

test('nearby place failures return one-tap recovery metadata', () => {
  const recovery = buildActionRecovery(
    { type: 'find_place', input: { query: "nearest McDonald's" } },
    { success: false, error: 'I need your current location to find a nearby McDonald’s.' }
  );
  assert.equal(recovery.cardText, 'Enable location and try again.');
  assert.equal(recovery.retryable, true);
  assert.equal(recovery.retryAction.type, 'find_place');
});

test('Places server setup failure is explicit and not retryable', () => {
  const recovery = buildActionRecovery(
    { type: 'book_uber', input: { destination: "nearest McDonald's" } },
    { success: false, error: 'Google Places is not configured. Set GOOGLE_PLACES_API_KEY.' }
  );
  assert.equal(recovery.cardText, 'Nearby ranking needs Places setup.');
  assert.equal(recovery.retryable, false);
});

test('connector fallback summaries are not overwritten by generic contract text', () => {
  const result = applyActionContractResultMetadata(
    { type: 'find_place', input: { query: "the nearest mcdonald's" } },
    {
      success: true,
      text: "I can open Maps for the nearest mcdonald's.",
      actionSummary: 'Maps search ready',
      cardText: 'Open search in Maps'
    }
  );

  assert.equal(result.actionSummary, 'Maps search ready');
});

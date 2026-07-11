const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ACTION_CONTRACTS,
  actionPromptBlock,
  buildActionRecovery,
  applyActionContractResultMetadata,
  validateActionWithContract,
  getActionContract
} = require('../../api/action-contracts');

test('every money-moving action routes through human review (executionMode: review)', () => {
  // Regression guard for the P0: the action-runner gates review on executionMode === 'review'.
  // These actions move (or purport to move) real money; if any resolves to direct-execute, the
  // agent could spend without confirmation. getActionContract must fail them safe.
  const moneyActions = [
    'spend_from_concierge_account',
    'top_up_concierge_account',
    'receive_to_concierge_account',
    'fund_opportunity',
    'stripe_charge',
    'stripe_payout_to_user',
    'spend_from_concierge_via_stripe',
    'transfer_to_concierge_account'
  ];
  for (const type of moneyActions) {
    const contract = getActionContract(type);
    assert.ok(contract, `${type} must have a contract (no contract = direct execute)`);
    assert.equal(contract.executionMode, 'review', `${type} must be review-gated`);
  }
});

test('getActionContract leaves non-review actions as direct execute', () => {
  assert.equal(getActionContract('check_concierge_balance').executionMode, undefined);
  assert.equal(getActionContract('get_weather').executionMode, undefined);
  assert.equal(getActionContract('nonexistent_action'), null);
});

test('run_browser_task and its payment follow-ups stay direct-execute despite risk:high', () => {
  // These are the one deliberate exception to "high risk = review" (see the money-actions
  // test above): run_browser_task MUST actually browse before it's known what there even is
  // to review, so gating the whole call behind upfront review (like stripe_charge) would
  // mean it never runs at all. The review happens INSIDE the api/index.js case handler, at
  // the moment the loop reaches ready_for_payment — this test just locks in that none of the
  // three accidentally fall into the fail-safe auto-review gate (getActionContract routes
  // risk:'high' to executionMode:'review' UNLESS executionMode is already set explicitly).
  for (const type of ['run_browser_task', 'confirm_browser_payment', 'cancel_browser_payment']) {
    const contract = getActionContract(type);
    assert.ok(contract, `${type} must have a contract`);
    assert.equal(contract.executionMode, 'direct', `${type} must stay direct-execute`);
  }
});

test('run_browser_task does not require goal (empty goal = continue an open order)', () => {
  const contract = getActionContract('run_browser_task');
  assert.deepEqual(contract.required, []);
});

test('Core actions (incl. new agentic) have contracts for reliability work', () => {
  const expected = [
    'find_place',
    'book_uber',
    'get_directions',
    'plan_trip',
    'send_message',
    'send_email',
    'get_emails',
    'search_emails',
    'create_reminder',
    'create_calendar_event',
    'get_calendar_events',
    'search_trains',
    'station_board',
    'play_music',
    'web_browse',
    'calculate',
    'create_agent_task',
    'simulate_actions',
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
  for (const action of ['send_email', 'make_call']) {
    assert.equal(ACTION_CONTRACTS[action].confirmation, 'review_required');
    assert.equal(ACTION_CONTRACTS[action].executionMode, 'review');
  }
});

test('SMS uses native composer instead of chat review', () => {
  assert.equal(ACTION_CONTRACTS.send_message.confirmation, 'none');
  assert.equal(ACTION_CONTRACTS.send_message.executionMode, 'direct');
});

test('Uber open action executes directly because payment is confirmed in Uber', () => {
  assert.equal(ACTION_CONTRACTS.book_uber.risk, 'low');
  assert.equal(ACTION_CONTRACTS.book_uber.confirmation, 'none');
  assert.equal(ACTION_CONTRACTS.book_uber.executionMode, 'direct');
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
  assert.equal(recovery.cardText, "Turn location on and I'll try again.");
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

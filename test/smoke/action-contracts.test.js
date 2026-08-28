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
  // Regression guard for the P0: action-execution gates review on executionMode === 'review'.
  // These actions move (or purport to move) real money; if any resolves to direct-execute, the
  // agent could spend without confirmation. getActionContract must fail them safe.
  const moneyActions = [
    'spend_from_concierge_account',
    'top_up_concierge_account',
    'receive_to_concierge_account',
    'fund_opportunity',
    'stripe_charge',
    'stripe_payout_to_user',
    'spend_from_concierge_via_stripe'
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

test('browsing is direct, but committing a payment goes through the contract review gate', () => {
  // Looking is not spending: the agent must be able to browse and read a price without
  // interrupting the person, or it can never find out what there is to approve.
  for (const type of ['browser_open', 'browser_act', 'transaction_prepare']) {
    const contract = getActionContract(type);
    assert.ok(contract, `${type} must have a contract`);
    assert.equal(contract.executionMode, 'direct', `${type} must stay direct-execute`);
  }

  // Committing the charge is the money action, and it is gated exactly like every other one.
  // It used to be 'direct', with the browser loop electing to ask for approval from inside
  // itself — which meant authority over a purchase lived in the probabilistic loop rather
  // than in the deterministic gate.
  const confirm = getActionContract('transaction_authorize');
  assert.equal(confirm.executionMode, 'review', 'paying must go through the review gate');
  assert.equal(confirm.confirmation, 'review_required');
});

test('the browser primitives require only what they genuinely cannot infer', () => {
  // browser_open needs somewhere to go; observing and closing need nothing at all.
  // browser_open takes a url OR a known site name, so neither is unconditionally required.
  assert.deepEqual(getActionContract('browser_open').required, []);
  assert.ok(getActionContract('browser_open').optional.includes('url'));
  assert.deepEqual(getActionContract('browser_observe').required, []);
  assert.deepEqual(getActionContract('transaction_prepare').required, []);
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

test('background watches require an explicit instruction and remain low-risk', () => {
  assert.equal(ACTION_CONTRACTS.create_scheduled_task.risk, 'low');
  assert.equal(ACTION_CONTRACTS.create_scheduled_task.executionMode, 'direct');
  assert.match(
    validateActionWithContract(
      { type: 'create_scheduled_task', input: { title: 'Flight prices' } },
      'watch flights'
    ).error,
    /instruction/
  );
  assert.equal(validateActionWithContract({
    type: 'create_scheduled_task',
    input: { title: 'Flight prices', instruction: 'Check weekly and tell me if they drop', recurrence: 'weekly' }
  }, 'watch flight prices'), null);
  assert.equal(ACTION_CONTRACTS.cancel_scheduled_task.confirmation, 'none');
});

test('Core actions validate required fields consistently', () => {
  for (const [type, contract] of Object.entries(ACTION_CONTRACTS)) {
    const input = {};
    for (const field of contract.required || []) input[field] = `sample ${field}`;
    const originalMessage = type === 'render_to_display' ? 'Put this on my display' : `${type} smoke`;
    const result = validateActionWithContract({ type, input }, originalMessage);
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

// Regression: a paused-for-you state (ready_for_payment, a 3DS wait mid-confirm) sets
// success:false — only 'completed' is ever true — but is not a failure. Before this guard,
// buildActionRecovery fell through to the action's generic contract.failureSummary and
// labelled a live, still-open checkout waiting on the user's own "yes" as "Order task
// failed" / "Payment confirmation failed".
test('an awaiting_user pause does not inherit the contract\'s generic failure cardText', () => {
  const readyForPayment = buildActionRecovery(
    { type: 'browser_open', input: { url: 'https://shop.example' } },
    { success: false, outcome: 'awaiting_user', pending: true, text: 'Ready to pay: £48.75.' }
  );
  assert.deepEqual(readyForPayment, {});

  const bankApproval = buildActionRecovery(
    { type: 'confirm_browser_payment', input: {} },
    { success: false, pending: true, text: 'Your bank wants you to approve this one.' }
  );
  assert.deepEqual(bankApproval, {});
});

test('a genuine failure still gets the contract\'s failureSummary cardText', () => {
  const recovery = buildActionRecovery(
    { type: 'transaction_authorize', input: {} },
    { success: false, error: 'The payment was declined by the card issuer.' }
  );
  assert.equal(recovery.cardText, 'Payment did not complete');
});

// Regression, found live 2026-08-27: a browser task that timed out mid-step but is still
// resumable ("Say 'keep going' and I'll resume from here") sets outcome:'incomplete' — not a
// failure — but the guard above only checked for 'awaiting_user'/pending, so this state still
// fell through to the generic failureSummary and rendered "Order task failed" on a checkout
// that was, per its own text, still open and picking back up.
test('an incomplete/resumable browser pause does not inherit the failure cardText either', () => {
  const timedOutButResumable = buildActionRecovery(
    { type: 'browser_open', input: { url: 'https://shop.example' } },
    { success: false, outcome: 'incomplete', incomplete: true, continuesBrowsing: true, text: "The site took too long to respond, so I paused safely before checkout. Say “keep going” and I'll resume from here." }
  );
  assert.deepEqual(timedOutButResumable, {});

  // Also guard on the boolean flags alone, in case a future caller sets one without the
  // outcome string — inferActionOutcome treats either as sufficient.
  const flagOnly = buildActionRecovery(
    { type: 'browser_observe', input: {} },
    { success: false, continuesBrowsing: true, text: 'Still working on it.' }
  );
  assert.deepEqual(flagOnly, {});
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

// ── Default identity selection: Millie's own address for external outreach, the user's own
// connected mailbox for personal correspondence. Not a UI mode — pure model guidance, so the
// only thing testable here is that the steering text actually exists in the right places
// (model tool-selection behavior itself needs live verification, not a unit test).
test('send_millie_email/send_millie_sms guidance names the external-outreach cases and defers personal correspondence to the user\'s own mailbox', () => {
  for (const type of ['send_millie_email', 'send_millie_sms']) {
    const contract = getActionContract(type);
    assert.ok(contract.guidance, `${type} must have guidance steering the model toward it for external outreach`);
    const g = contract.guidance.toLowerCase();
    for (const term of ['business', 'support', 'restaurant', 'vendor', 'stranger']) {
      assert.match(g, new RegExp(term), `${type} guidance should mention "${term}"`);
    }
    // Must also say when NOT to use it, not just when to.
    assert.match(g, /personal|friend|family|manager|colleague/i, `${type} guidance must defer personal correspondence to the user's own mailbox`);
  }
});

test('send_email/send_outlook_email guidance scopes them to the user\'s own personal correspondence', () => {
  for (const type of ['send_email', 'send_outlook_email']) {
    const contract = getActionContract(type);
    assert.ok(contract.guidance, `${type} must have guidance`);
    const g = contract.guidance.toLowerCase();
    assert.match(g, /personal|friend|family/i, `${type} guidance should scope it to the user's own correspondence`);
    // Must point the model at the Millie-identity alternative for business/external outreach.
    assert.match(g, /send_millie_email/, `${type} guidance should redirect business/external outreach to send_millie_email`);
  }
});

test('actionPromptBlock (the plain-text tool list the model also sees) carries the identity-selection guidance', () => {
  const block = actionPromptBlock();
  assert.match(block, /send_millie_email/);
  assert.match(block, /business/i);
});

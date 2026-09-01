// The surviving deterministic shortcuts, one test per matcher.
//
// Each keys off a literal signal. preroute-boundary.test.js owns the other half of the
// contract: that ordinary prose is never answered here at all.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  inferDeterministicAction,
  inferPersonalAdminAction,
  inferOutboundCommunicationAction,
} = require('../../api/intent-router');

test('ordinary personal-admin reads reach their declared actions', () => {
  assert.deepEqual(inferPersonalAdminAction('Show me my active responsibilities.'), {
    reason: 'list_responsibilities',
    spoken: "I'll check what I'm handling.",
    actions: [{ type: 'list_responsibilities', input: {} }]
  });
  assert.deepEqual(inferPersonalAdminAction('What do you remember about Alex?'), {
    reason: 'find_people',
    spoken: "I'll look up Alex.",
    actions: [{ type: 'find_people', input: { query: 'Alex' } }]
  });
  assert.deepEqual(inferPersonalAdminAction('Find the email with my Amazon receipt from last month.'), {
    reason: 'search_emails',
    spoken: "I'll search your email.",
    actions: [{ type: 'search_emails', input: { query: 'my Amazon receipt from last month', max_results: 10 } }]
  });
});

test('an explicit web URL reaches the shared browsing capability instead of relying on a model claim', () => {
  assert.deepEqual(
    inferDeterministicAction('Open https://www.gov.uk/apply-first-provisional-driving-licence and tell me the first step.'),
    {
      reason: 'browse_explicit_url',
      spoken: "I'll open that.",
      actions: [{
        type: 'web_browse',
        input: {
          url: 'https://www.gov.uk/apply-first-provisional-driving-licence',
          query: 'tell me the first step'
        }
      }]
    }
  );
  assert.equal(inferDeterministicAction('I found https://www.gov.uk/apply-first-provisional-driving-licence yesterday.'), null);
});

test('an explicit uppercase ticker price reaches stocks rather than weather or forecast', () => {
  assert.deepEqual(
    inferDeterministicAction('What is the current price of AAPL?'),
    {
      reason: 'stock_price',
      spoken: "I'll check the current price.",
      actions: [{ type: 'get_stock_price', input: { symbol: 'AAPL' } }]
    }
  );
  assert.equal(inferDeterministicAction('What is the price of a wireless mouse?'), null);
});

test('an explicit trivia request reaches the conversation-first play capability', () => {
  assert.deepEqual(inferDeterministicAction("Let's play a quick trivia game."), {
    reason: 'play_trivia',
    spoken: "Let's play a quick one.",
    actions: [{ type: 'play_game', input: { game: 'trivia' } }]
  });
  assert.notEqual(inferDeterministicAction('Play some calm instrumental music.')?.actions?.[0]?.type, 'play_game');
});

test('an outbound request that names its own channel reaches the review-gated action', () => {
  assert.deepEqual(inferOutboundCommunicationAction('Send Alex a telegram message saying I am running ten minutes late.'), {
    reason: 'send_telegram',
    spoken: 'I’ll prepare that message for review.',
    actions: [{ type: 'send_telegram', input: { contact: 'Alex', message: 'I am running ten minutes late.' } }]
  });
  assert.deepEqual(inferOutboundCommunicationAction('Send #general a slack message saying the deploy is done.'), {
    reason: 'send_slack_message',
    spoken: 'I’ll prepare that message for review.',
    actions: [{ type: 'send_slack_message', input: { channel: '#general', message: 'the deploy is done.' } }]
  });
});

// These used to be shortcut with a prose-scanning regex that mangled them: the recipient came
// out as a noun phrase ("the gym"), and the actual request was truncated or dropped entirely.
test('a bare call/email/text request is left for the model to resolve against real contacts', () => {
  for (const message of [
    'Email the gym and ask them to freeze my membership.',
    'Call the dentist and ask for their next available appointment.',
    'Text Alex that I am running ten minutes late.',
  ]) {
    assert.equal(inferOutboundCommunicationAction(message), null, message);
  }
});

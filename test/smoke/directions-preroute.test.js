const assert = require('node:assert/strict');
const test = require('node:test');

const { inferDeterministicAction } = require('../../api/intent-router');

const NAVIGATIONAL = [
  'Directions to the gym.',
  'How do I get to Birmingham New Street?',
  'What bus goes to the hospital?',
  'Navigate to 10 Downing Street.',
];

// Each of these contains a travel word but is not asking for a route. They reached
// get_directions in production, which answered "Driving directions to <the whole sentence>".
const NOT_NAVIGATIONAL = [
  'Cancel my driving lesson on Tuesday.',
  'Remind me to walk the dog at 6pm.',
  'Email the garage about my driving licence renewal.',
  'Find me a walking jacket under 100 pounds.',
  'Renew my driving licence online.',
  'What is the best route to market for our product?',
  'Order a new drive belt for the washing machine.',
  'Open the official GOV.UK page for applying for a provisional driving licence.',
];

test('a real route request still gets the deterministic answer', () => {
  for (const message of NAVIGATIONAL) {
    const routed = inferDeterministicAction(message);
    assert.ok(routed, `"${message}" should still pre-route`);
  }
});

test('a travel word inside an ordinary request never pre-empts the loop', () => {
  const hijacked = NOT_NAVIGATIONAL
    .map((message) => ({ message, actions: inferDeterministicAction(message)?.actions?.map((a) => a.type) }))
    .filter((row) => row.actions?.length);

  assert.deepEqual(hijacked, [], `pre-routed before the model got a turn:\n${hijacked.map((r) => `  ${r.actions} ← ${r.message}`).join('\n')}`);
});

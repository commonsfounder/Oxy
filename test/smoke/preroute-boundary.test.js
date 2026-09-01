// The boundary the pre-router must respect.
//
// A deterministic shortcut is only safe when it keys off something literal and unambiguous —
// a URL, an uppercase ticker, an anchored command form. The moment it interprets ordinary
// prose it competes with the model, and it loses: it cannot weigh context, and it silently
// discards the parameters the action contract asks for.
//
// Every message below is ordinary prose. None may be answered by a regex.

const assert = require('node:assert/strict');
const test = require('node:test');

const { inferDeterministicAction } = require('../../api/intent-router');

// Prose that mentions a place, a journey, a purchase or a thing to keep an eye on, but whose
// real intent only the model can settle. Several of these were live hijacks.
const MUST_REACH_THE_MODEL = [
  // travel words inside a request that is not asking for a route
  'Cancel my driving lesson on Tuesday.',
  'Remind me to walk the dog at 6pm.',
  'Email the garage about my driving licence renewal.',
  'Find me a walking jacket under 100 pounds.',
  'Renew my driving licence online.',
  'What is the best route to market for our product?',
  'Order a new drive belt for the washing machine.',
  'Open the official GOV.UK page for applying for a provisional driving licence.',
  // a genuine route question — the model owns this now, with the destination in context
  'Directions to the gym.',
  'How do I get to Birmingham New Street?',
  'What bus goes to the hospital?',
  // a place noun inside a task that is not a place lookup
  'Book me a table at the restaurant near London Bridge for Friday.',
  'Is there a good coffee shop near the office I could take a client to?',
  'Email the gym and ask them to freeze my membership.',
  'Complain to the hotel about the room they gave us.',
  'What time does the pharmacy on the high street shut?',
  // a watch whose real parameters (threshold, source, end state) a regex cannot capture
  'Watch the price of the Sony headphones and tell me if it drops below £250.',
  'Keep an eye on flight prices to Lagos and tell me when they fall under 400 pounds.',
  'Tell me when the PS5 is back in stock at Argos.',
  'Stop watching the flight prices.',
];

test('ordinary prose is never answered by a regex', () => {
  const hijacked = MUST_REACH_THE_MODEL
    .map(message => ({ message, routed: inferDeterministicAction(message, { settings: {} }) }))
    .filter(row => row.routed)
    .map(row => `  ${row.routed.actions.map(a => a.type).join(',')} <- ${row.message}`);

  assert.deepEqual(hijacked, [], `these were decided before the model got a turn:\n${hijacked.join('\n')}`);
});

// The surviving shortcuts. Each keys off something literal that cannot be mistaken for prose.
test('a literal URL with a browsing verb still shortcuts', () => {
  const routed = inferDeterministicAction('Open https://example.com/pricing and tell me what the plans cost', { settings: {} });
  assert.equal(routed?.actions?.[0]?.type, 'web_browse');
  assert.equal(routed.actions[0].input.url, 'https://example.com/pricing');
});

test('an uppercase ticker with an explicit price request still shortcuts', () => {
  const routed = inferDeterministicAction('What is the current price of AAPL?', { settings: {} });
  assert.equal(routed?.actions?.[0]?.type, 'get_stock_price');
  assert.equal(routed.actions[0].input.symbol, 'AAPL');
});

test('an anchored command form still shortcuts', () => {
  const routed = inferDeterministicAction('who is Marcus Fenwick', { settings: {} });
  assert.equal(routed?.actions?.[0]?.type, 'find_people');
});

test('a mention of a URL without a browsing verb does not shortcut', () => {
  assert.equal(inferDeterministicAction('I found it on https://example.com yesterday', { settings: {} }), null);
});

test('an ordinary product price does not reach the market-data connector', () => {
  assert.equal(inferDeterministicAction('what is the price of a decent mouse', { settings: {} }), null);
});

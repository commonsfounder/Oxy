const assert = require('node:assert/strict');
const test = require('node:test');

// index.js builds real service clients at load; give them harmless values so the
// module imports without reaching out to anything.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
process.env.OXY_SESSION_SECRET = process.env.OXY_SESSION_SECRET || 'test-secret';

const { parseActions, mentionsActionCommitment, parsePrice, decidePaymentByCap, runAgentLoop } = require('../../api/index.js');

// Build a fake model that returns scripted replies in order, and an executor that returns
// scripted result batches — so we can drive runAgentLoop's control flow deterministically.
function scriptedLoop({ replies, batches = [] }) {
  let r = 0; let b = 0;
  return {
    generate: async () => ({ text: replies[r++] ?? '' }),
    execute: async () => batches[b++] ?? [],
    confirm: async () => ({ success: true, text: 'Paid.' })
  };
}
const ACT = '<action>{"actions":[{"type":"x"}]}</action>';

test('parseActions extracts a single action block and strips it from spoken text', () => {
  const { spoken, actions, parseError } = parseActions(
    'Setting that up now. <action>{"actions":[{"type":"create_reminder","input":{"title":"call mom"}}]}</action>'
  );
  assert.equal(spoken, 'Setting that up now.');
  assert.equal(parseError, false);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'create_reminder');
});

test('parseActions captures multiple action blocks, not just the first', () => {
  const { actions } = parseActions(
    '<action>{"actions":[{"type":"a"}]}</action> and <action>{"actions":[{"type":"b"}]}</action>'
  );
  assert.deepEqual(actions.map(a => a.type), ['a', 'b']);
});

test('parseActions flags malformed JSON instead of silently dropping it', () => {
  const { actions, parseError } = parseActions('Done. <action>{not json}</action>');
  assert.equal(actions.length, 0);
  assert.equal(parseError, true);
});

test('parseActions tolerates code-fenced JSON', () => {
  const { actions } = parseActions('<action>```json\n{"actions":[{"type":"x"}]}\n```</action>');
  assert.equal(actions[0].type, 'x');
});

test('mentionsActionCommitment catches phantom promises', () => {
  assert.equal(mentionsActionCommitment("I'll set that reminder for 8am."), true);
  assert.equal(mentionsActionCommitment('Done — reminder set.'), true);
  assert.equal(mentionsActionCommitment("I'll send the email shortly."), true);
});

test('mentionsActionCommitment ignores non-action phrasing', () => {
  assert.equal(mentionsActionCommitment("I'll be honest, that's tricky."), false);
  assert.equal(mentionsActionCommitment('The weather is nice today.'), false);
  assert.equal(mentionsActionCommitment(''), false);
});

test('parsePrice extracts amounts from real checkout strings', () => {
  assert.equal(parsePrice('£150'), 150);
  assert.equal(parsePrice('$5.00'), 5);
  assert.equal(parsePrice('1,299.99 USD'), 1299.99);
  assert.equal(parsePrice('Total: £42.50'), 42.5);
  assert.equal(parsePrice('free'), null);
  assert.equal(parsePrice(''), null);
});

test('decidePaymentByCap auto-pays only within a set cap', () => {
  assert.equal(decidePaymentByCap('£80', 100).decision, 'pay');
  assert.equal(decidePaymentByCap('£100', 100).decision, 'pay'); // boundary inclusive
  assert.equal(decidePaymentByCap('£150', 100).decision, 'approve'); // over cap
  assert.equal(decidePaymentByCap('sold out', 100).decision, 'approve'); // unparseable → never pay
  assert.equal(decidePaymentByCap('£10', 0).decision, 'approve'); // no cap → never auto-pay
  assert.equal(decidePaymentByCap('£10', null).decision, 'approve');
});

test('runAgentLoop stops when the model emits no action (done)', async () => {
  const s = scriptedLoop({ replies: ['All finished.'] });
  const out = await runAgentLoop({ userId: 'u', contents: [{ role: 'user', parts: [{ text: 'go' }] }], ...s });
  assert.equal(out.status, 'done');
  assert.equal(out.spoken, 'All finished.');
  assert.equal(out.steps, 1);
});

test('runAgentLoop chains: acts, feeds results back, then finishes', async () => {
  const s = scriptedLoop({
    replies: [`Looking it up. ${ACT}`, 'Here is the answer.'],
    batches: [[{ action: 'x', result: { text: 'data' } }]]
  });
  const out = await runAgentLoop({ userId: 'u', contents: [{ role: 'user', parts: [{ text: 'go' }] }], ...s });
  assert.equal(out.status, 'done');
  assert.equal(out.spoken, 'Here is the answer.');
  assert.equal(out.steps, 2);
});

test('runAgentLoop pauses when an action needs the user (review_required)', async () => {
  const s = scriptedLoop({
    replies: [`Working. ${ACT}`],
    batches: [[{ action: 'send_email', result: { confirmation: 'review_required', text: 'Send this?' } }]]
  });
  const out = await runAgentLoop({ userId: 'u', contents: [{ role: 'user', parts: [{ text: 'go' }] }], ...s });
  assert.equal(out.status, 'paused');
});

test('runAgentLoop auto-pays a browser purchase under the cap', async () => {
  const s = scriptedLoop({
    replies: [`Buying. ${ACT}`, 'Booked your tickets.'],
    batches: [[{ action: 'run_browser_task', result: { confirmation: 'review_required', total: '£80' } }]]
  });
  const out = await runAgentLoop({ userId: 'u', budgetCap: 100, contents: [{ role: 'user', parts: [{ text: 'go' }] }], ...s });
  assert.equal(out.status, 'done');
  assert.equal(out.spoken, 'Booked your tickets.');
});

test('runAgentLoop pauses a browser purchase over the cap (no auto-pay)', async () => {
  let confirmed = false;
  const s = scriptedLoop({
    replies: [`Buying. ${ACT}`],
    batches: [[{ action: 'run_browser_task', result: { confirmation: 'review_required', total: '£150' } }]]
  });
  s.confirm = async () => { confirmed = true; return { success: true }; };
  const out = await runAgentLoop({ userId: 'u', budgetCap: 100, contents: [{ role: 'user', parts: [{ text: 'go' }] }], ...s });
  assert.equal(out.status, 'paused');
  assert.equal(confirmed, false); // never paid over cap
});

test('runAgentLoop is bounded by maxSteps', async () => {
  const s = scriptedLoop({
    replies: Array(10).fill(`More. ${ACT}`),
    batches: Array(10).fill([{ action: 'x', result: { text: 'ok' } }])
  });
  const out = await runAgentLoop({ userId: 'u', maxSteps: 3, contents: [{ role: 'user', parts: [{ text: 'go' }] }], ...s });
  assert.equal(out.status, 'maxSteps');
});

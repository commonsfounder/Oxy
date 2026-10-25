const assert = require('node:assert/strict');
const test = require('node:test');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
process.env.OXY_SESSION_SECRET = process.env.OXY_SESSION_SECRET || 'test-secret';

const { reconcileSpokenWithActions } = require('../../api');

const ok = (action, text) => ({ action, result: { success: true, outcome: 'completed', text } });
const handoff = (action, text) => ({ action, result: { success: false, outcome: 'handoff_required', text } });
const failed = (action, error) => ({ action, result: { success: false, outcome: 'failed', error } });
const MODEL = 'The 08:01 train gets in at 09:29, about 1h28 after leaving Birmingham. The walk is roughly 12 minutes.';

test('a hand-off side step keeps the model answer and adds the link line', () => {
  const out = reconcileSpokenWithActions(MODEL, [ok('web_search', 'times'), handoff('get_directions', 'Walking directions to the gallery are ready.')]);
  assert.ok(out.startsWith(MODEL));
  assert.match(out, /Walking directions to the gallery are ready\./);
});

test('a failed side step does not wipe out a good answer', () => {
  const out = reconcileSpokenWithActions(MODEL, [ok('get_forecast', 'x'), failed('search_trains', 'could not get a route')]);
  assert.equal(out, MODEL);
});

test('when nothing worked, the honest failure line replaces the answer', () => {
  const out = reconcileSpokenWithActions('All sorted, it is booked!', [failed('book_appointment', 'could not book')]);
  assert.doesNotMatch(out, /booked!/);
});

test('a waiting approval always replaces the answer so the user sees it exactly', () => {
  const pending = { action: 'send_email', result: { success: false, outcome: 'awaiting_user', pending: true, text: 'Say confirm to send.' } };
  const out = reconcileSpokenWithActions(MODEL, [ok('web_search', 'x'), pending]);
  assert.match(out, /confirm/i);
  assert.doesNotMatch(out, /08:01/);
});

test('no actions or all clean successes leave the answer alone', () => {
  assert.equal(reconcileSpokenWithActions(MODEL, []), MODEL);
});

test('a remember-then-ask message is not handled by the memory shortcut', () => {
  const { hasFollowOnRequest } = require('../../api');
  assert.equal(hasFollowOnRequest("Remember that my sister Ada's birthday is on 3 March, then tell me how many days it is until then."), true);
  assert.equal(hasFollowOnRequest('Remember that I like oat milk and then show me the nearest shop'), true);
  assert.equal(hasFollowOnRequest('Remember that my sister Ada birthday is on 3 March'), false);
  assert.equal(hasFollowOnRequest('Remember I prefer window seats'), false);
});

test('a short model line is replaced by what the working steps found, with the hand-off line added', () => {
  const found = 'The 08:01 from Birmingham New Street gets into Manchester Piccadilly at 09:29, a journey of 1h28.';
  const out = reconcileSpokenWithActions("I'll check.", [ok('web_search', found), handoff('get_directions', 'Walking directions to the gallery are ready.')]);
  assert.ok(out.startsWith(found));
  assert.match(out, /Walking directions to the gallery are ready\./);
});

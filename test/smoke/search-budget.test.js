const test = require('node:test');
const assert = require('node:assert');
process.env.SUPABASE_URL ||= 'http://127.0.0.1:1';
process.env.SUPABASE_KEY ||= 'test-key';
const { createSearchBudget, normaliseQuery } = require('../../api/services/search-budget');
const { handlers } = require('../../api/actions/browser');

test('a repeated search is answered from memory, ignoring case and punctuation', () => {
  const budget = createSearchBudget();
  budget.record('u', 'question', 'Tallest building in Manchester?', 'Deansgate Square South Tower, 201 m');
  assert.strictEqual(budget.cached('u', 'tallest   building in manchester'), 'Deansgate Square South Tower, 201 m');
  assert.strictEqual(budget.cached('other-user', 'tallest building in manchester'), null);
  assert.strictEqual(normaliseQuery('A, b!  C'), 'a b c');
});

test('one question is stopped after its cap, and a different question is not', () => {
  const budget = createSearchBudget({ cap: 3 });
  for (let i = 0; i < 3; i += 1) { assert.strictEqual(budget.allow('u', 'find kettles'), true); budget.record('u', 'find kettles', `q${i}`, 'x'); }
  assert.strictEqual(budget.allow('u', 'find kettles'), false);
  assert.strictEqual(budget.allow('u', 'something else'), true);
});

test('remembered answers and counts expire', () => {
  let t = 0;
  const budget = createSearchBudget({ cap: 1, ttlMs: 1000, now: () => t });
  budget.record('u', 'q', 'a query', 'answer');
  assert.strictEqual(budget.allow('u', 'q'), false);
  t = 2000;
  assert.strictEqual(budget.allow('u', 'q'), true);
  assert.strictEqual(budget.cached('u', 'a query'), null);
});

test('web_search makes one real call for a repeated query and stops at the cap', async () => {
  let calls = 0;
  const deps = { FAST_MODEL: 'x', webSearchBrain: async () => { calls += 1; return `Result number ${calls}: a long enough answer about the thing that was asked.`; } };
  const ctx = { userMessage: 'Find me a very specific thing please' };
  const run = (query, userId = 'budget-user') => handlers.web_search({ userId, params: { query }, context: ctx, deps });
  const first = await run('best kettle uk');
  const again = await run('Best kettle, UK');
  assert.strictEqual(first.success, true);
  assert.strictEqual(again.cached, true);
  assert.strictEqual(calls, 1);
  let last;
  for (let i = 0; i < 10; i += 1) last = await run(`distinct query ${i}`);
  assert.strictEqual(last.success, false);
  assert.strictEqual(last.outcome, 'unavailable');
  assert.match(last.error, /enough searching/i);
  assert.ok(calls <= 6, `made ${calls} real searches`);
  const otherUser = await run('best kettle uk', 'someone-else');
  assert.strictEqual(otherUser.success, true);
});

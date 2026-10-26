const test = require('node:test');
const assert = require('node:assert');
process.env.SUPABASE_URL ||= 'http://127.0.0.1:1';
process.env.SUPABASE_KEY ||= 'test-key';
process.env.OXY_USAGE_LOG = 'off';
const { exaEnabled, exaSearch, answerPrompt } = require('../../api/services/search-provider');
const usageMeter = require('../../api/services/usage-meter');
const { handlers } = require('../../api/actions/browser');

const EXA_BODY = { results: [
  { title: 'Deansgate Square', url: 'https://example.com/ds', publishedDate: '2026-09-01T00:00:00Z', highlights: ['The South Tower is 201 m tall.'] },
  { title: 'No text', url: 'https://example.com/none', highlights: [] },
], costDollars: { total: 0.0052 } };

test('Exa is used only when chosen and keyed', () => {
  assert.strictEqual(exaEnabled({}), false);
  assert.strictEqual(exaEnabled({ OXY_SEARCH_PROVIDER: 'exa' }), false);
  assert.strictEqual(exaEnabled({ OXY_SEARCH_PROVIDER: 'exa', EXA_API_KEY: 'k' }), true);
  assert.strictEqual(exaEnabled({ OXY_SEARCH_PROVIDER: 'openai', EXA_API_KEY: 'k' }), false);
});

test('the request asks for highlights and the reply is reduced to usable results, with the fee metered', async () => {
  let sent;
  const fetchImpl = async (url, init) => { sent = { url, init }; return { ok: true, json: async () => EXA_BODY }; };
  const before = usageMeter.lifetimeReport().estimatedUsd;
  const results = await exaSearch('tallest building in Manchester', { fetchImpl, env: { EXA_API_KEY: 'secret' } });
  assert.strictEqual(sent.url, 'https://api.exa.ai/search');
  assert.strictEqual(sent.init.headers['x-api-key'], 'secret');
  assert.ok(JSON.parse(sent.init.body).contents.highlights);
  assert.strictEqual(results.length, 1);
  assert.match(results[0].text, /201 m/);
  assert.ok(Math.abs(usageMeter.lifetimeReport().estimatedUsd - before - 0.0052) < 1e-9);
});

test('the answer prompt carries the question, the date and the sources', () => {
  const prompt = answerPrompt({ question: 'tallest in Manchester', today: '2026-10-26', results: [{ title: 'T', url: 'https://example.com/ds', date: null, text: '201 m' }] });
  assert.match(prompt, /2026-10-26/);
  assert.match(prompt, /tallest in Manchester/);
  assert.match(prompt, /https:\/\/example\.com\/ds/);
});

test('web_search answers from Exa when chosen, and falls back to OpenAI search when Exa fails', async (t) => {
  const savedFetch = global.fetch;
  const saved = { p: process.env.OXY_SEARCH_PROVIDER, k: process.env.EXA_API_KEY };
  process.env.OXY_SEARCH_PROVIDER = 'exa'; process.env.EXA_API_KEY = 'k';
  t.after(() => { global.fetch = savedFetch; process.env.OXY_SEARCH_PROVIDER = saved.p || ''; process.env.EXA_API_KEY = saved.k || ''; });
  let openaiCalls = 0;
  const deps = {
    FAST_MODEL: 'x',
    generateBrain: async () => ({ text: 'Manchester\'s tallest building is the Deansgate Square South Tower at about 201 metres.' }),
    webSearchBrain: async () => { openaiCalls += 1; return 'OpenAI fallback answer that is long enough to count as an answer.'; },
  };
  global.fetch = async () => ({ ok: true, json: async () => EXA_BODY });
  const viaExa = await handlers.web_search({ userId: 'exa-user', params: { query: 'tallest manchester one' }, context: { userMessage: 'q1' }, deps });
  assert.strictEqual(viaExa.provider, 'exa');
  assert.match(viaExa.text, /201 metres/);
  assert.strictEqual(openaiCalls, 0);
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const fallback = await handlers.web_search({ userId: 'exa-user', params: { query: 'tallest manchester two' }, context: { userMessage: 'q2' }, deps });
  assert.strictEqual(fallback.success, true);
  assert.match(fallback.text, /OpenAI fallback/);
  assert.strictEqual(openaiCalls, 1);
});

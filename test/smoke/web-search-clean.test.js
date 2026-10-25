const test = require('node:test');
const assert = require('node:assert');
process.env.SUPABASE_URL ||= 'http://127.0.0.1:1';
process.env.SUPABASE_KEY ||= 'test-key';
const { handlers } = require('../../api/actions/browser');

test('search answers never carry tracking tags in their links', async () => {
  const result = await handlers.web_search({
    params: { query: 'population of Reykjavik' },
    deps: { FAST_MODEL: 'x', webSearchBrain: async () => 'Reykjavik has 139,804 people. ([en.wikipedia.org](https://en.wikipedia.org/wiki/Reykjav%C3%ADk?utm_source=openai))' }
  });
  assert.strictEqual(result.success, true);
  assert.doesNotMatch(result.text, /utm_/);
  assert.match(result.text, /wikipedia\.org\/wiki\/Reykjav%C3%ADk\)/);
});

test('a site that just blocked the browser is not opened again', async () => {
  const env = require('../../api/services/browser-environment');
  const original = env.open;
  let opens = 0;
  env.open = async () => { opens += 1; return { url: 'https://walled.example/', blocked: true, elements: [], elementLines: [], text: '' }; };
  try {
    const first = await handlers.browser_open({ userId: 'u-wall', params: { url: 'https://walled.example/' }, context: {} });
    const second = await handlers.browser_open({ userId: 'u-wall', params: { url: 'https://walled.example/search' }, context: {} });
    assert.strictEqual(first.success, false);
    assert.strictEqual(second.success, false);
    assert.match(second.error, /not trying it again/);
    assert.strictEqual(opens, 1);
  } finally { env.open = original; }
});

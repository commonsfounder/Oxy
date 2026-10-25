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

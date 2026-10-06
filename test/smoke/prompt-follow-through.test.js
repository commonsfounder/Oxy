// Adam must do what it says in the same turn, treat "that's not what I asked" as a correction to
// redo, and never hand over an address it built itself as if it were the thing requested.

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildSystemPrompt } = require('../../api/prompts');
const { ACTION_CONTRACTS } = require('../../api/action-contracts');

function squash(text) {
  return String(text).replace(/\s+/g, ' ');
}

test('a complaint that the result missed the ask is a correction to redo, not a question to answer', () => {
  const prompt = squash(buildSystemPrompt({ surface: 'chat', context: {} }));
  assert.match(prompt, /I asked for a specific tweet/);
  assert.match(prompt, /correction, not a question about the result/);
  assert.match(prompt, /do the original work properly now, in this turn/);
  assert.match(prompt, /A recent result that missed what they asked for does not count as done/);
  assert.match(prompt, /never apologise or explain instead of searching/);
});

test('challenging an earlier answer gets fixed with real data, not only an apology', () => {
  const prompt = squash(buildSystemPrompt({ surface: 'chat', context: { memory: 'x' } }));
  assert.match(prompt, /get it with a tool in this same turn rather than only apologising/);
});

test('the older rule still stops "bruh" from triggering a repeat action', () => {
  const prompt = squash(buildSystemPrompt({ surface: 'chat', context: {} }));
  assert.match(prompt, /"bruh"\), answer or re-check the claim/);
});

test('Adam is told never to announce a search without making it', () => {
  const prompt = squash(buildSystemPrompt({ surface: 'chat', context: {} }));
  assert.match(prompt, /Never end a turn by saying you are about to search/);
  assert.match(prompt, /make the tool call in the same turn/);
});

test('a specific post, clip or page gets its real link, never a self-built search address', () => {
  const prompt = squash(buildSystemPrompt({ surface: 'chat', context: {} }));
  assert.match(prompt, /Never build a search-page or browse-page address yourself/);
  assert.match(prompt, /say that plainly and offer the closest real link/);

  const guidance = squash(ACTION_CONTRACTS.web_search.guidance || '');
  assert.match(guidance, /give the real link taken from the results/);
  assert.match(guidance, /Never write a search-page or browse-page URL yourself/);
});

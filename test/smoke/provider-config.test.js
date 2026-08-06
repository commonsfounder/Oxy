const assert = require('node:assert/strict');
const test = require('node:test');

const {
  defaultModelForProvider,
  modelMatchesProvider,
  providerConfiguration
} = require('../../api/services/model-routing');
const { formatProviderFailure } = require('../../api/services/user-facing-copy');

test('provider defaults do not send a Gemini model to OpenAI', () => {
  const savedProvider = process.env.OXY_BRAIN_PROVIDER;
  const savedReasoning = process.env.OXY_REASONING_MODEL;
  const savedOpenAI = process.env.OXY_OPENAI_MODEL;
  process.env.OXY_BRAIN_PROVIDER = 'openai';
  process.env.OXY_REASONING_MODEL = 'gemini-3-flash-preview';
  delete process.env.OXY_OPENAI_MODEL;

  assert.equal(defaultModelForProvider('openai'), 'gpt-5.6-luna');
  assert.equal(modelMatchesProvider('openai', 'gemini-3-flash-preview'), false);

  if (savedProvider === undefined) delete process.env.OXY_BRAIN_PROVIDER;
  else process.env.OXY_BRAIN_PROVIDER = savedProvider;
  if (savedReasoning === undefined) delete process.env.OXY_REASONING_MODEL;
  else process.env.OXY_REASONING_MODEL = savedReasoning;
  if (savedOpenAI === undefined) delete process.env.OXY_OPENAI_MODEL;
  else process.env.OXY_OPENAI_MODEL = savedOpenAI;
});

test('provider configuration reports a model-provider mismatch without exposing secrets', () => {
  const savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const status = providerConfiguration('openai', 'gemini-3-flash-preview');
  assert.equal(status.ready, false);
  assert.match(status.issue, /model does not match/i);
  assert.doesNotMatch(JSON.stringify(status), /test-key/);
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
});

test('provider failures become useful safe copy', () => {
  assert.equal(
    formatProviderFailure('openai 401: Incorrect API key provided'),
    'Millie is unavailable right now. Try again later.'
  );
  assert.equal(
    formatProviderFailure('openai 404: model does not exist'),
    'Millie needs a model connection before she can answer. Try again later.'
  );
  assert.doesNotMatch(formatProviderFailure('openai 401: Incorrect API key provided'), /api key|openai/i);
});

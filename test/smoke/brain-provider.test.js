const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getBrainProvider,
  toOpenAIMessages,
  openAIRequestFromConfig
} = require('../../api/services/brain-provider');

test('getBrainProvider defaults to openai and is case-insensitive', () => {
  const saved = process.env.OXY_BRAIN_PROVIDER;
  delete process.env.OXY_BRAIN_PROVIDER;
  assert.equal(getBrainProvider(), 'openai');
  process.env.OXY_BRAIN_PROVIDER = 'GEMINI';
  assert.equal(getBrainProvider(), 'gemini');
  process.env.OXY_BRAIN_PROVIDER = 'GROQ';
  assert.equal(getBrainProvider(), 'groq');
  if (saved === undefined) delete process.env.OXY_BRAIN_PROVIDER;
  else process.env.OXY_BRAIN_PROVIDER = saved;
});

// The Groq path re-shapes Gemini contents into OpenAI messages. If this translation
// drifts, search/chat turns silently degrade on the flagged provider — so pin the shape.
test('toOpenAIMessages maps Gemini roles to OpenAI roles and joins parts', () => {
  const contents = [
    { role: 'user', parts: [{ text: 'Hello ' }, { text: 'there' }] },
    { role: 'model', parts: [{ text: 'Hi!' }] }
  ];
  const out = toOpenAIMessages(contents, 'You are helpful.');
  assert.deepEqual(out, [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello there' },
    { role: 'assistant', content: 'Hi!' }
  ]);
});

test('toOpenAIMessages omits the system message when there is no system instruction', () => {
  const out = toOpenAIMessages([{ role: 'user', parts: [{ text: 'hi' }] }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
});

test('toOpenAIMessages drops empty turns and tolerates missing parts', () => {
  const contents = [
    { role: 'user', parts: [{ text: '' }] },
    { role: 'model' },
    { role: 'user', parts: [{ text: 'real' }] }
  ];
  const out = toOpenAIMessages(contents);
  assert.deepEqual(out, [{ role: 'user', content: 'real' }]);
});

// /chat-with-image sends Gemini inlineData parts. If these stop becoming image_url
// data URIs the attachment is silently dropped and the model answers about nothing.
test('toOpenAIMessages converts inlineData parts to image_url data URIs', () => {
  const contents = [{
    role: 'user',
    parts: [
      { text: 'what is this?' },
      { inlineData: { mimeType: 'image/png', data: 'AAAB' } }
    ]
  }];
  const out = toOpenAIMessages(contents);
  assert.deepEqual(out, [{
    role: 'user',
    content: [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' } }
    ]
  }]);
});

test('toOpenAIMessages keeps an image turn that has no text', () => {
  const contents = [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'ZZ' } }] }];
  const out = toOpenAIMessages(contents);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].content, [
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,ZZ' } }
  ]);
});

// Reasoning models spend max_completion_tokens on reasoning before emitting text, so
// the chat path's 32-token quick-turn cap would return an empty string. Pin the floor.
test('openAIRequestFromConfig floors tiny maxOutputTokens and omits temperature', () => {
  const body = openAIRequestFromConfig({ maxOutputTokens: 32, temperature: 0.1, topK: 20 });
  assert.ok(body.max_completion_tokens >= 768, 'quick-turn cap must be floored');
  assert.equal('temperature' in body, false, 'reasoning models reject temperature');
  assert.equal('max_tokens' in body, false, 'legacy max_tokens errors on gpt-5.x');
});

test('openAIRequestFromConfig respects a larger explicit cap', () => {
  const body = openAIRequestFromConfig({ maxOutputTokens: 4096 });
  assert.equal(body.max_completion_tokens, 4096);
});

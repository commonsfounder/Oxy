const assert = require('node:assert/strict');
const test = require('node:test');

const { getBrainProvider, toOpenAIMessages } = require('../../api/services/brain-provider');

test('getBrainProvider defaults to gemini and is case-insensitive', () => {
  const saved = process.env.OXY_BRAIN_PROVIDER;
  delete process.env.OXY_BRAIN_PROVIDER;
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

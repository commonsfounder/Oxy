const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getVoiceProvider,
  resolveOpenAIVoice,
  OPENAI_VOICES,
  DEFAULT_OPENAI_VOICE,
  GEMINI_TO_OPENAI_VOICE
} = require('../../api/services/voice-provider');

test('getVoiceProvider defaults to openai and is case-insensitive', () => {
  const saved = process.env.OXY_VOICE_PROVIDER;
  delete process.env.OXY_VOICE_PROVIDER;
  assert.equal(getVoiceProvider(), 'openai');
  process.env.OXY_VOICE_PROVIDER = 'GEMINI';
  assert.equal(getVoiceProvider(), 'gemini');
  if (saved === undefined) delete process.env.OXY_VOICE_PROVIDER;
  else process.env.OXY_VOICE_PROVIDER = saved;
});

// Saved user settings still hold Gemini voice names. If the mapping stops resolving them
// every existing user silently drops to the default voice on their next spoken reply.
test('resolveOpenAIVoice maps stored Gemini voice names to real OpenAI voices', () => {
  for (const [gemini, openai] of Object.entries(GEMINI_TO_OPENAI_VOICE)) {
    assert.equal(resolveOpenAIVoice(gemini), openai, `${gemini} should map to ${openai}`);
    assert.ok(OPENAI_VOICES.has(openai), `${openai} must be a real OpenAI voice id`);
  }
});

test('resolveOpenAIVoice passes through OpenAI ids and falls back for unknown names', () => {
  assert.equal(resolveOpenAIVoice('coral'), 'coral');
  assert.equal(resolveOpenAIVoice('SHIMMER'), 'shimmer');
  assert.equal(resolveOpenAIVoice('not-a-voice'), DEFAULT_OPENAI_VOICE);
  assert.equal(resolveOpenAIVoice(undefined), DEFAULT_OPENAI_VOICE);
});

test('OXY_TTS_VOICE overrides the mapping, but only with a real voice id', () => {
  const saved = process.env.OXY_TTS_VOICE;
  process.env.OXY_TTS_VOICE = 'onyx';
  assert.equal(resolveOpenAIVoice('Aoede'), 'onyx');
  process.env.OXY_TTS_VOICE = 'bogus-voice';
  assert.equal(resolveOpenAIVoice('Aoede'), GEMINI_TO_OPENAI_VOICE.Aoede);
  if (saved === undefined) delete process.env.OXY_TTS_VOICE;
  else process.env.OXY_TTS_VOICE = saved;
});

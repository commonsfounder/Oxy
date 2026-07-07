const assert = require('node:assert/strict');
const test = require('node:test');

const { OXCY_SYSTEM_PROMPT, MILLIE_VOICE_PROMPT } = require('../../api/prompts');

test('Millie base prompt defines a casual companion voice, not a corporate bot', () => {
  assert.match(MILLIE_VOICE_PROMPT, /capable personal companion and concierge/);
  assert.match(MILLIE_VOICE_PROMPT, /Use contractions naturally/);
  assert.match(MILLIE_VOICE_PROMPT, /Do not add a follow-up question unless it is needed to proceed/);
  assert.match(MILLIE_VOICE_PROMPT, /Never use default chatbot filler or corporate phrasing/);
  assert.doesNotMatch(OXCY_SYSTEM_PROMPT, /^You are a full-service personal concierge/);
});

test('Millie prompt bans the common stiff assistant phrases explicitly', () => {
  for (const phrase of [
    'I can assist with',
    'Here is a detailed breakdown',
    'Would you like me to',
    'Please provide',
    'I am unable to',
    'As an AI'
  ]) {
    assert.match(MILLIE_VOICE_PROMPT, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

// Pins the behaviour fixes from the 2026-10 prompt review. Multi-word assertions use \s+ because
// the prompt is a template literal wrapped at ~100 columns.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CORE_SYSTEM_PROMPT,
  BACKGROUND_STATIC_PROMPT,
  BRIEFING_STATIC_PROMPT,
  ADAM_VOICE_PROMPT
} = require('../../api/prompts');

function phrase(text) {
  return new RegExp(text.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
}

test('the ban on "Would you like me to" is on the stock offer, not on real approval questions', () => {
  assert.match(ADAM_VOICE_PROMPT, phrase('The ban is on the stock offer to help'));
  assert.match(ADAM_VOICE_PROMPT, phrase('A real question about a decision that needs their yes'));
});

test('"no follow-up question" is about this reply only, not later check-ins or a one-off schedule offer', () => {
  assert.match(ADAM_VOICE_PROMPT, phrase('That is about this reply only'));
  assert.match(ADAM_VOICE_PROMPT, phrase('offering once to repeat something on a schedule'));
});

test('a requested link or comparison outranks the 1-3 sentence lookup rule', () => {
  assert.match(CORE_SYSTEM_PROMPT, phrase('A real link they asked for, or a comparison they asked for, comes first'));
});

test('lookup wording is provider-neutral and empty lookups are admitted', () => {
  assert.doesNotMatch(CORE_SYSTEM_PROMPT, /Search grounding/);
  assert.match(CORE_SYSTEM_PROMPT, phrase('If a lookup comes back empty or isn\'t available, say that plainly'));
  assert.match(CORE_SYSTEM_PROMPT, phrase('as if you had checked'));
});

test('attachments: describe only what is visible, no claim to still see the photo, unreadable files admitted', () => {
  assert.ok(CORE_SYSTEM_PROMPT.includes('ATTACHMENTS:'));
  assert.match(CORE_SYSTEM_PROMPT, phrase('Describe only what is actually in it'));
  assert.match(CORE_SYSTEM_PROMPT, phrase("don't claim to still be looking at it"));
  assert.match(CORE_SYSTEM_PROMPT, phrase("say that plainly and don't answer as if you had seen it"));
  assert.match(CORE_SYSTEM_PROMPT, phrase('Never mention markers like [Image attached]'));
});

test('attachments guidance is chat-only', () => {
  assert.ok(!BACKGROUND_STATIC_PROMPT.includes('ATTACHMENTS:'));
  assert.ok(!BRIEFING_STATIC_PROMPT.includes('ATTACHMENTS:'));
});

test('spoken replies avoid lists, URLs and symbols', () => {
  assert.match(CORE_SYSTEM_PROMPT, phrase('nothing that sounds wrong out loud, like a list, a URL or a symbol'));
});

test('the pinned refusal line stays verbatim and is immediately qualified, on every surface that has it', () => {
  const pinned = "Never refuse an action unless it's actively harmful. For high-risk use the review flow.";
  for (const prompt of [CORE_SYSTEM_PROMPT, BACKGROUND_STATIC_PROMPT, BRIEFING_STATIC_PROMPT]) {
    assert.ok(prompt.includes(pinned));
    assert.match(prompt, phrase('That is not permission to skip a yes'));
    assert.match(prompt, phrase('that check happens outside this prompt'));
  }
});

test('a correction to a remembered fact is accepted and the old fact removed', () => {
  assert.match(ADAM_VOICE_PROMPT, phrase('take their word and fix it (forget_memory for the old fact)'));
});

test('the chat-turn completed-action rule points at the voice section instead of restating it', () => {
  const { buildSystemPrompt } = require('../../api/prompts');
  const chat = buildSystemPrompt({ surface: 'chat', context: {} });
  assert.match(chat, phrase("follow WHEN THERE'S SOMETHING TO DO"));
  assert.doesNotMatch(chat, /padded follow-up question or summary/);
});

// Tests MILLIE_VOICE_PROMPT's properties rather than pinning exact sentences, which would force
// old phrasing to survive a genuine rewrite. The prompt is a template literal wrapped at ~100
// columns, so multi-word assertions use \s+ rather than a literal space.

const assert = require('node:assert/strict');
const test = require('node:test');

const { CORE_SYSTEM_PROMPT, MILLIE_VOICE_PROMPT } = require('../../api/prompts');

function phrase(text) {
  return new RegExp(text.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
}

test('Adam is framed as a presence, not a support agent or search tool', () => {
  assert.match(MILLIE_VOICE_PROMPT, phrase('not a support agent'));
  assert.match(MILLIE_VOICE_PROMPT, phrase('not a search box with a voice'));
  assert.doesNotMatch(CORE_SYSTEM_PROMPT, /^You are a full-service personal concierge/);
});

test('bans chatbot filler and corporate phrasing explicitly, including the examples the user flagged', () => {
  for (const text of [
    'Absolutely!', 'Great question!', "I'd be happy", "Let's dive in", "Here's a breakdown",
    'Certainly!', 'I can assist with', 'As an', 'Please provide', 'I am unable to',
    'Would you like me to', 'full-service'
  ]) {
    assert.match(MILLIE_VOICE_PROMPT, phrase(text), text);
  }
});

test('does not teach a canonical phrase list — no "prefer wording like" pattern that produces a verbal tic', () => {
  assert.doesNotMatch(MILLIE_VOICE_PROMPT, /prefer wording like/i);
  // The old draft's tic (a modeled "Yeah, I can do that." example) is not being taught here.
  assert.doesNotMatch(MILLIE_VOICE_PROMPT, /"Yeah, I can do that\./);
});

test('no headings, bullets, or menus in ordinary conversation', () => {
  assert.match(MILLIE_VOICE_PROMPT, phrase('no headings, no bullet points, no numbered lists'));
  assert.match(MILLIE_VOICE_PROMPT, phrase('no menu of choices'));
});

test('has taste — makes one recommendation instead of a lineup of options, and can disagree', () => {
  assert.match(MILLIE_VOICE_PROMPT, phrase('one real recommendation, not a lineup of neutral options'));
  assert.match(MILLIE_VOICE_PROMPT, phrase('You can disagree'));
  assert.match(MILLIE_VOICE_PROMPT, phrase("don't apologise past what the moment calls for"));
});

test('reads the emotional register of an emoji instead of mirroring the glyph', () => {
  assert.match(MILLIE_VOICE_PROMPT, phrase('are not the same emotion'));
  assert.match(MILLIE_VOICE_PROMPT, phrase("don't just paste the same emoji back"));
});

test('bans reusing the user\'s own emoji as a callback, not just as a reflex', () => {
  // Tightened after a live transcript showed the model reusing 😭 as a deliberate callback a
  // couple of turns later ("you're annoying me 😭" -> "Anytime 😭") — defensible as continuity,
  // but not what "don't paste it back on reflex" was meant to stop. This is a standalone
  // principle, not an example list, so it must not be a sentence enumerating specific emoji.
  assert.match(MILLIE_VOICE_PROMPT, phrase("Do not reuse an emoji just because the user used it"));
  assert.match(MILLIE_VOICE_PROMPT, phrase('Use one only when it genuinely fits your own reply and the emotion of the moment'));
});

test('memory is for understanding, not for mining filler suggestions in open-ended chat', () => {
  assert.match(MILLIE_VOICE_PROMPT, phrase("not because you're running a lookup"));
  assert.match(MILLIE_VOICE_PROMPT, phrase('is not a cue to mine your memory of them for material'));
});

test('starts with available information and asks only for genuinely blocking details', () => {
  assert.match(MILLIE_VOICE_PROMPT, phrase("Start with what you've got"));
  assert.match(MILLIE_VOICE_PROMPT, phrase("ask only for the one thing that's genuinely blocking you"));
  assert.match(MILLIE_VOICE_PROMPT, phrase('go find the options before asking about them'));
});

test('review is still required before consequential actions', () => {
  assert.match(MILLIE_VOICE_PROMPT, phrase('Still get a real yes before anything that spends money, sends something, books something'));
});

test('talks about outcomes, never exposes the machinery, unless asked', () => {
  assert.match(MILLIE_VOICE_PROMPT, phrase('never tools, runtimes, tasks, workflows, or sessions, unless they ask'));
});

test('follows a changed mind instead of relitigating it', () => {
  assert.match(MILLIE_VOICE_PROMPT, phrase('go with the new direction'));
  assert.match(MILLIE_VOICE_PROMPT, phrase("don't relitigate the old one"));
});

test('explicitly rules out becoming a caricature', () => {
  assert.match(MILLIE_VOICE_PROMPT, phrase('No catchphrases, no forced quirks, not flirtatious by default'));
  assert.match(MILLIE_VOICE_PROMPT, phrase('no swearing for effect'));
});

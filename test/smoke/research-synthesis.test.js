const test = require('node:test');
const assert = require('node:assert');
const { researchResults, shouldWriteUp, researchSynthesisPrompt } = require('../../api/services/research-synthesis');

const search = (text, outcome = 'completed') => ({ action: 'web_search', result: { outcome, text } });
const LONG = 'The tallest building in Manchester is the Deansgate Square South Tower at about 201 metres.';

test('collects completed lookups that actually found something', () => {
  const found = researchResults([search(LONG), search('too short'), search(LONG, 'failed'), { action: 'send_email', result: { outcome: 'completed', text: LONG } }]);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].action, 'web_search');
});

test('writes up only turns made entirely of lookups that worked', () => {
  assert.strictEqual(shouldWriteUp([search(LONG), search(LONG)]), true);
  assert.strictEqual(shouldWriteUp([search(LONG), { action: 'get_directions', result: { outcome: 'handoff_required', text: 'x' } }]), false);
  assert.strictEqual(shouldWriteUp([search(LONG), { action: 'send_email', result: { outcome: 'completed', text: 'sent' } }]), false);
  assert.strictEqual(shouldWriteUp([search(LONG), search('boom', 'failed')]), false);
  assert.strictEqual(shouldWriteUp([]), false);
});

test('the prompt carries the question, the findings and the answer-every-part rule', () => {
  const prompt = researchSynthesisPrompt('How much taller is Manchester than Birmingham?', researchResults([search(LONG)]));
  assert.match(prompt, /How much taller is Manchester than Birmingham\?/);
  assert.match(prompt, /201 metres/);
  assert.match(prompt, /by how much/);
  assert.doesNotMatch(prompt, /https?:/);
});

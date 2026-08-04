const assert = require('node:assert/strict');
const test = require('node:test');

const { buildDecisionPrompt, buildTextOnlyDecisionPrompt, parseModelDecision } = require('../../api/services/browser-task');

// Regression for the asos.com "repeat-click ADD TO BAG forever" root cause (2026-08-04): the
// real required control was a native <select id="variantSelector"> — CLICKABLE_SELECTOR now
// matches it (browser-task.js + browser-recipes.js, kept in sync by a separate test) and the
// model needs a "select" action with the exact option text, not "click"/"fill". These tests
// pin the prompt-rendering and parsing halves without needing a real browser page.

const dropdownElements = [
  { id: 0, text: 'ADD TO BAG', isInput: false },
  {
    id: 1,
    text: 'Please select',
    isInput: false,
    isSelect: true,
    options: ['Please select', 'W24 L30 - UK 4', 'W25 L30 - UK 6 (unavailable)'],
  },
];

test('buildDecisionPrompt renders a [dropdown, options: ...] tag with the exact option strings', () => {
  const prompt = buildDecisionPrompt('order jeans', [], dropdownElements);
  assert.ok(prompt.includes('#1 [dropdown, options: "Please select", "W24 L30 - UK 4", "W25 L30 - UK 6 (unavailable)"] "Please select"'));
  assert.ok(prompt.includes('#0 "ADD TO BAG"'), 'a plain element still renders with no tag');
  assert.ok(/"select".*use "select" with "value"/is.test(prompt) || /never "click" or "fill" a \[dropdown\]/.test(prompt));
  assert.ok(prompt.includes('{"action":"select","elementId":<number>,"value":"<exact option text from its options list>"}'));
});

test('buildTextOnlyDecisionPrompt renders the same dropdown tag and select instruction', () => {
  const prompt = buildTextOnlyDecisionPrompt('order jeans', [], dropdownElements);
  assert.ok(prompt.includes('#1 [dropdown, options: "Please select", "W24 L30 - UK 4", "W25 L30 - UK 6 (unavailable)"] "Please select"'));
  assert.ok(prompt.includes('{"action":"select","elementId":<number>,"value":"<exact option text from its options list>"}'));
});

test('parseModelDecision accepts a well-formed "select" action', () => {
  const decision = parseModelDecision('{"action":"select","elementId":1,"value":"W24 L30 - UK 4"}');
  assert.deepEqual(decision, { action: 'select', elementId: 1, value: 'W24 L30 - UK 4' });
});

test('parseModelDecision still rejects an unrecognized action', () => {
  const decision = parseModelDecision('{"action":"choose","elementId":1}');
  assert.equal(decision.action, 'invalid');
});

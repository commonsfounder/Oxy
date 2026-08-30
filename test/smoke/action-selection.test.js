const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_OPTIONS,
  createActionSelection,
  normalizeActionSelection,
  resolveActionSelectionOption
} = require('../../api/services/action-selection');

test('action selections preserve exact safe action and option inputs', () => {
  const selection = createActionSelection({
    actionType: 'browser_act',
    actionInput: { sessionId: 'session-1', action: 'click' },
    options: [
      { id: 'button-7', label: 'Continue', command: 'choose option 1', input: { elementId: 'button-7' } }
    ]
  });
  assert.deepEqual(resolveActionSelectionOption(selection, 0), {
    type: 'browser_act',
    input: { sessionId: 'session-1', action: 'click', elementId: 'button-7' },
    option: selection.options[0]
  });
});

test('action selections reject secrets, nested payloads, duplicate IDs, and unbounded lists', () => {
  const base = { action: { type: 'browser_act', input: {} }, options: [{ id: 'a', label: 'A', command: 'choose option 1', input: {} }] };
  assert.equal(normalizeActionSelection({ ...base, action: { type: 'browser_act', input: { token: 'secret' } } }), null);
  assert.equal(normalizeActionSelection({ ...base, options: [{ ...base.options[0], input: { nested: { value: true } } }] }), null);
  assert.equal(normalizeActionSelection({ ...base, options: [base.options[0], base.options[0]] }), null);
  assert.equal(normalizeActionSelection({ ...base, options: Array.from({ length: MAX_OPTIONS + 1 }, (_, index) => ({
    id: String(index), label: `Choice ${index}`, command: `choose option ${index + 1}`, input: {}
  })) }), null);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCalendarReadAction,
  calendarIntentKind,
  isExplicitCalendarWrite
} = require('../../api/services/calendar-intent');
const { getActionContract } = require('../../api/action-contracts');

test('read-only calendar language is read intent, never write', () => {
  const prompts = [
    'Check my emails for anything important today, then check my calendar for tomorrow and tell me what I need to prepare for.',
    'I want to go to London tomorrow. Check my calendar first, then help me figure out when I should leave.',
    "What's on my calendar tomorrow?",
    'Show me my calendar today',
    'Check my schedule tomorrow'
  ];

  for (const prompt of prompts) {
    assert.equal(calendarIntentKind(prompt), 'read', prompt);
    assert.equal(isExplicitCalendarWrite(prompt), false, prompt);
    const action = buildCalendarReadAction(prompt).actions[0];
    assert.equal(action.type, 'get_calendar_events');
  }
});

test('calendar writes require explicit create language', () => {
  const prompts = [
    'Add dentist to my calendar tomorrow at 3pm',
    'Create a calendar event for lunch today at 12',
    'Schedule prep time tomorrow at 9am',
    'Can you schedule dentist for tomorrow at 3pm',
    'Put team sync on my calendar tomorrow'
  ];

  for (const prompt of prompts) {
    assert.equal(calendarIntentKind(prompt), 'write', prompt);
    assert.equal(isExplicitCalendarWrite(prompt), true, prompt);
  }
});

test('calendar creation action is review-gated by contract', () => {
  const contract = getActionContract('create_calendar_event');
  assert.equal(contract.executionMode, 'review');
  assert.equal(contract.confirmation, 'review_required');
});

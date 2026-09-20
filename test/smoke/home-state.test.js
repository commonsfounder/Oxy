const assert = require('node:assert/strict');
const test = require('node:test');

const { activityTitle, isConversationalTask } = require('../../api/services/home-state');

test('activity titles keep the actual request subject but never become a transcript', () => {
  assert.equal(
    activityTitle('Can you find the latest repair update for the washing machine? I need the reference too.'),
    'find the latest repair update for the washing machine?'
  );
  assert.equal(
    activityTitle('Please research a very long request that keeps going past the compact activity label boundary with details that belong in the work view.'),
    'research a very long request that keeps going past the compact activity…'
  );
});

test('channel-bound chat tasks stay in conversation history, not Home', () => {
  assert.equal(isConversationalTask({ metadata: { channel: 'telegram_bot' } }), true);
  assert.equal(isConversationalTask({ metadata: { channel: '  telegram_bot  ' } }), true);
});

test('legacy Telegram task results are excluded without guessing from the title', () => {
  assert.equal(isConversationalTask({
    goal: 'Tell Arina the update',
    results: [{ action: 'send_telegram' }]
  }), true);
  assert.equal(isConversationalTask({ goal: 'Tell Arina the update', results: [] }), false);
});

test('ordinary durable work remains visible on Home', () => {
  assert.equal(isConversationalTask({ metadata: { routineId: 'routine-1' }, status: 'completed' }), false);
  assert.equal(isConversationalTask({ metadata: {}, status: 'running' }), false);
});

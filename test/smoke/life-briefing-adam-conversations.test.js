const assert = require('node:assert/strict');
const test = require('node:test');

const { buildLifeBriefing, normalizeConversationUpdate } = require('../../api/services/life-briefing');

test('normalizeConversationUpdate surfaces the participant name and latest reply body', () => {
  const item = normalizeConversationUpdate({
    id: 'conv-1',
    participantDisplayName: 'The Bistro',
    latestEventBody: 'We can do 8:15, does that work?',
    needsDecision: true,
    lastActivityAt: new Date().toISOString()
  });
  assert.equal(item.kind, 'conversation_update');
  assert.equal(item.title, 'The Bistro');
  assert.match(item.detail, /8:15/);
  assert.equal(item.urgency, 'soon');
});

test('normalizeConversationUpdate ranks a surface-only update lower than one needing a decision', () => {
  const needsDecision = normalizeConversationUpdate({
    id: 'conv-1', participantDisplayName: 'The Bistro', latestEventBody: 'We can do 8:15.',
    needsDecision: true, lastActivityAt: new Date().toISOString()
  });
  const surfaceOnly = normalizeConversationUpdate({
    id: 'conv-2', participantDisplayName: 'The Bistro', latestEventBody: "We're closed Mondays.",
    needsDecision: false, lastActivityAt: new Date().toISOString()
  });
  assert.ok(needsDecision.priority > surfaceOnly.priority);
  assert.equal(surfaceOnly.urgency, 'background');
});

test('buildLifeBriefing includes conversation updates alongside existing item types', () => {
  const briefing = buildLifeBriefing({
    conversationUpdates: [{
      id: 'conv-1', participantDisplayName: 'The Bistro', latestEventBody: 'We can do 8:15.',
      needsDecision: true, lastActivityAt: new Date().toISOString()
    }]
  });
  assert.ok(briefing.items.some(i => i.kind === 'conversation_update'));
  assert.equal(briefing.coverage.conversations, true);
});

test('buildLifeBriefing coverage.conversations is false when there are none', () => {
  const briefing = buildLifeBriefing({});
  assert.equal(briefing.coverage.conversations, false);
});

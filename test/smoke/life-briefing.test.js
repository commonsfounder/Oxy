const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildLifeBriefing,
  formatLifeBriefing
} = require('../../api/services/life-briefing');

const now = new Date('2026-08-05T09:00:00.000Z');

test('ranks approval, imminent calendar, actionable message, then background goal', () => {
  const briefing = buildLifeBriefing({
    now,
    approvals: [{
      approvalId: 'approval-1',
      taskId: 'task-approval',
      taskGoal: 'Send the supplier reply',
      action: {
        type: 'send_email',
        input: {
          to: 'sales@supplier.example',
          subject: 'Could you review the price?',
          body: 'Could you reduce the price?'
        }
      }
    }],
    events: [{ id: 'event-1', summary: 'Dentist', start: '2026-08-05T10:00:00.000Z' }],
    emails: [{
      messageId: 'message-1',
      from: 'Dana Kim <dana@example.com>',
      subject: 'The review deck',
      summary: 'Wants the deck before the afternoon review',
      cta: 'Reply'
    }],
    tasks: [{ id: 'task-2', goal: 'Keep the prototype moving', status: 'running' }]
  });

  assert.equal(briefing.items.length, 3);
  assert.deepEqual(briefing.items.map(item => item.kind), ['approval', 'calendar', 'message']);
  assert.equal(briefing.items[0].taskId, 'task-approval');
  assert.deepEqual(briefing.items[0].review, {
    action: 'send_email',
    recipient: 'sales@supplier.example',
    subject: 'Could you review the price?',
    body: 'Could you reduce the price?'
  });
  assert.match(briefing.items[1].detail, /Today at|In /);
  assert.equal(briefing.items[2].title, 'The review deck');
});

test('does not expose raw email addresses, body text, or connector payloads', () => {
  const briefing = buildLifeBriefing({
    now,
    emails: [{
      messageId: 'message-2',
      from: 'Jamie Example <jamie@example.com>',
      subject: 'Account update',
      snippet: 'PRIVATE BODY THAT MUST NOT ESCAPE',
      summary: 'Jamie needs a reply',
      cta: 'Reply'
    }],
    tasks: [{
      id: 'task-3',
      goal: 'Review https://private.example/project',
      status: 'running',
      results: [{ result: { raw: 'connector payload' } }]
    }]
  });

  const encoded = JSON.stringify(briefing);
  assert.doesNotMatch(encoded, /jamie@example\.com|PRIVATE BODY|private\.example|connector payload/);
  assert.equal(briefing.items[0].detail, 'Jamie needs a reply');
});

test('deduplicates a task approval and keeps a quiet empty state', () => {
  const briefing = buildLifeBriefing({
    now,
    approvals: [{ approvalId: 'approval-1', taskId: 'task-1', taskGoal: 'Book the appointment' }],
    tasks: [{ id: 'task-1', goal: 'Book the appointment', status: 'paused', awaiting_approval: true }]
  });
  assert.equal(briefing.items.length, 1);
  assert.equal(briefing.items[0].kind, 'approval');

  const empty = buildLifeBriefing({ now });
  assert.equal(empty.empty, true);
  assert.equal(empty.headline, 'Nothing pressing right now.');
  assert.match(formatLifeBriefing(empty), /Nothing pressing right now/);
});

test('ignores stale and informational items', () => {
  const briefing = buildLifeBriefing({
    now,
    events: [{ id: 'old', summary: 'Yesterday', start: '2026-08-04T10:00:00.000Z' }],
    emails: [
      { subject: 'Newsletter', summary: 'Nothing needed', cta: 'Ignore' },
      { subject: 'Older FYI', summary: 'For your information' }
    ]
  });
  assert.equal(briefing.items.length, 0);
});

test('keeps an active background watch visible when there is room', () => {
  const briefing = buildLifeBriefing({
    now,
    scheduledTasks: [{
      id: 'watch-1',
      title: 'Cheaper flights to Turkey',
      recurrence: 'poll',
      condition: 'the price drops',
      next_run_at: '2026-08-05T12:00:00.000Z',
      active: true
    }]
  });
  assert.equal(briefing.items[0].kind, 'watch');
  assert.match(briefing.items[0].detail, /Until the price drops/);
  assert.equal(briefing.coverage.watches, true);
});

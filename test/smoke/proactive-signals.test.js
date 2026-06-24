const assert = require('node:assert/strict');
const test = require('node:test');

// index.js builds real service clients at load; give them harmless values so the
// module imports without reaching out to anything.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';

const { parseSignalsResponse, classifySignalTier, executeSafeSignals } = require('../../api/index.js');

test('parseSignalsResponse reads a clean JSON object', () => {
  const { lead, signals } = parseSignalsResponse('{"lead":"Morning.","signals":[{"title":"Leave by 8:40","detail":"Rain expected"}]}');
  assert.equal(lead, 'Morning.');
  assert.equal(signals.length, 1);
  assert.equal(signals[0].title, 'Leave by 8:40');
});

test('parseSignalsResponse tolerates ```json fences and trailing prose', () => {
  const raw = 'Sure!\n```json\n{"lead":"","signals":[{"title":"Reply to Sarah","detail":"Waiting since yesterday","action":{"type":"send_email","label":"Reply","prompt":"Reply to Sarah"}}]}\n```\nHope that helps.';
  const { signals } = parseSignalsResponse(raw);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].action.type, 'send_email');
});

test('parseSignalsResponse caps at 4 signals and drops untitled ones', () => {
  const items = [1, 2, 3, 4, 5].map(n => ({ title: `t${n}`, detail: '' }));
  items.push({ detail: 'no title' });
  const { signals } = parseSignalsResponse(JSON.stringify({ lead: '', signals: items }));
  assert.equal(signals.length, 4);
});

test('parseSignalsResponse falls back to prose when JSON is unparseable', () => {
  const { lead, signals } = parseSignalsResponse('Just a plain paragraph with no JSON at all.');
  assert.equal(lead, 'Just a plain paragraph with no JSON at all.');
  assert.deepEqual(signals, []);
});

test('parseSignalsResponse treats NOTHING / empty as no content', () => {
  assert.deepEqual(parseSignalsResponse('NOTHING'), { lead: '', signals: [] });
  assert.deepEqual(parseSignalsResponse('   '), { lead: '', signals: [] });
  assert.deepEqual(parseSignalsResponse('{"lead":"","signals":[]}'), { lead: '', signals: [] });
});

test('classifySignalTier: reversible & private actions are safe', () => {
  assert.equal(classifySignalTier({ type: 'create_reminder', params: { title: 'x', due_date: 'y' } }), 'safe');
  assert.equal(classifySignalTier({ type: 'create_calendar_event', params: { title: 'x', start: 'y' } }), 'safe');
});

test('classifySignalTier: outward-facing actions are sensitive; calendar-with-attendees leaves safe; unknown fails safe', () => {
  assert.equal(classifySignalTier({ type: 'send_email', params: {} }), 'sensitive');
  assert.equal(classifySignalTier({ type: 'book_uber', params: {} }), 'sensitive');
  assert.equal(classifySignalTier({ type: 'create_calendar_event', params: { attendees: ['a@b.com'] } }), 'sensitive');
  assert.equal(classifySignalTier({ type: 'wipe_everything', params: {} }), 'sensitive');
  assert.equal(classifySignalTier(null), 'none');
});

test('executeSafeSignals runs the safe tier once and is idempotent across re-sweeps', async () => {
  let calls = 0;
  const exec = async () => { calls += 1; return { success: true, actionSummary: 'Reminder set' }; };
  const signals = [{ title: 'Leave by 8:40', detail: '', action: { type: 'create_reminder', params: { title: 'Leave', due_date: '2026-06-24T08:40:00+01:00' } } }];

  const first = await executeSafeSignals('u1', JSON.parse(JSON.stringify(signals)), [], exec);
  assert.equal(calls, 1);
  assert.equal(first.signals[0].status, 'done');
  assert.equal(first.signals[0].receipt, 'Reminder set');
  assert.equal(first.executed.length, 1);

  // A later sweep proposing the same action must not execute it again.
  const second = await executeSafeSignals('u1', JSON.parse(JSON.stringify(signals)), first.executed, exec);
  assert.equal(calls, 1, 'safe action should not run twice');
  assert.equal(second.signals[0].status, 'done');
});

test('executeSafeSignals attaches an undo descriptor to reminders but not calendar events', async () => {
  const exec = async () => ({ success: true, actionSummary: 'Done' });
  const reminder = [{ title: 'Leave by 8:40', detail: '', action: { type: 'create_reminder', params: { title: 'Leave for the dentist', due_date: 'x' } } }];
  const cal = [{ title: 'Focus block', detail: '', action: { type: 'create_calendar_event', params: { title: 'Focus', start: 'x' } } }];

  const r = await executeSafeSignals('u1', reminder, [], exec);
  assert.equal(r.signals[0].undo.type, 'cancel_scheduled_task');
  assert.equal(r.signals[0].undo.params.title, 'Leave for the dentist');

  const c = await executeSafeSignals('u1', cal, [], exec);
  assert.equal(c.signals[0].status, 'done');
  assert.equal(c.signals[0].undo, undefined);
});

test('executeSafeSignals leaves sensitive actions pending with a tap prompt and never executes them', async () => {
  let calls = 0;
  const exec = async () => { calls += 1; return { success: true }; };
  const signals = [{ title: 'Reply to Sarah', detail: '', action: { type: 'send_email', label: 'Reply', prompt: 'Reply to Sarah confirming Friday' } }];
  const { signals: out } = await executeSafeSignals('u1', signals, [], exec);
  assert.equal(calls, 0);
  assert.equal(out[0].status, 'pending');
  assert.equal(out[0].label, 'Reply');
  assert.equal(out[0].prompt, 'Reply to Sarah confirming Friday');
});

test('executeSafeSignals degrades a failed safe action to an info signal', async () => {
  const exec = async () => { throw new Error('boom'); };
  const signals = [{ title: 'Leave by 8:40', detail: '', action: { type: 'create_reminder', params: { title: 'Leave', due_date: 'x' } } }];
  const { signals: out, executed } = await executeSafeSignals('u1', signals, [], exec);
  assert.equal(out[0].status, 'info');
  assert.equal(out[0].action, undefined);
  assert.equal(executed.length, 0);
});

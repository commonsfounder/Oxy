const assert = require('node:assert/strict');
const test = require('node:test');

// index.js builds real service clients at load; give them harmless values so the
// module imports without reaching out to anything.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
process.env.OXY_SESSION_SECRET = process.env.OXY_SESSION_SECRET || 'test-secret';

const {
  parseActions,
  mentionsActionCommitment,
  parsePrice,
  decidePaymentByCap,
  runAgentLoop,
  inferCompoundReadOnlyTurn,
  summarizeReadOnlyActionResults,
  getStructuredDataResults,
  guardVisibleDataResponse,
  triageEmailsForRequest,
  normalizeActionResultsForClient,
  validatePendantTranscriptionUpload
} = require('../../api/index.js');

// Build a fake model that returns scripted replies in order, and an executor that returns
// scripted result batches — so we can drive runAgentLoop's control flow deterministically.
function scriptedLoop({ replies, batches = [] }) {
  let r = 0; let b = 0;
  return {
    generate: async () => ({ text: replies[r++] ?? '' }),
    execute: async () => batches[b++] ?? [],
    confirm: async () => ({ success: true, text: 'Paid.' })
  };
}
const ACT = '<action>{"actions":[{"type":"x"}]}</action>';

test('parseActions extracts a single action block and strips it from spoken text', () => {
  const { spoken, actions, parseError } = parseActions(
    'Setting that up now. <action>{"actions":[{"type":"create_reminder","input":{"title":"call mom"}}]}</action>'
  );
  assert.equal(spoken, 'Setting that up now.');
  assert.equal(parseError, false);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'create_reminder');
});

test('parseActions captures multiple action blocks, not just the first', () => {
  const { actions } = parseActions(
    '<action>{"actions":[{"type":"a"}]}</action> and <action>{"actions":[{"type":"b"}]}</action>'
  );
  assert.deepEqual(actions.map(a => a.type), ['a', 'b']);
});

test('compound read-only routing preserves email then calendar order', () => {
  const turn = inferCompoundReadOnlyTurn('Check my emails for anything important today, then check my calendar for tomorrow and tell me what I need to prepare for.');
  assert.equal(turn.reason, 'compound_read_only');
  assert.deepEqual(turn.actions.map(action => action.type), ['search_emails', 'get_calendar_events']);
  assert.equal(turn.actions[1].input.when, 'tomorrow');
});

test('compound read-only routing preserves calendar then email order', () => {
  const turn = inferCompoundReadOnlyTurn('Check my calendar tomorrow, then check my emails today and give me one combined summary.');
  assert.equal(turn.reason, 'compound_read_only');
  assert.deepEqual(turn.actions.map(action => action.type), ['get_calendar_events', 'search_emails']);
});

test('compound read-only summary uses bounded synthesis context instead of raw payloads', () => {
  const spoken = summarizeReadOnlyActionResults([
    { action: 'search_emails', result: { success: true, emails: [{
      from: 'Alice Example <alice@example.com>',
      subject: 'Budget',
      body: 'Bring numbers. https://tracking.example.com/open?id=abc Unsubscribe from this list. '.repeat(20)
    }] } },
    { action: 'get_calendar_events', result: { success: true, events: [{ title: 'Planning', start: '2026-07-05T09:00:00', end: '2026-07-05T10:00:00' }] } }
  ]);
  assert.doesNotMatch(spoken, /https?:\/\//);
  assert.doesNotMatch(spoken, /alice@example\.com/);
  assert.doesNotMatch(spoken, /Unsubscribe/i);
  assert.doesNotMatch(spoken, /2026-07-05T09:00:00/);
  assert.match(spoken, /Budget/);
  assert.match(spoken, /Planning/);
});

test('compound read-only summary threads the original message so broad email triage actually applies', () => {
  // Regression: this is the exact QA repro ("check my emails for anything important
  // today, then check my calendar for tomorrow") — it routes through the deterministic
  // compound-read-only fastpath, which calls summarizeReadOnlyActionResults directly.
  // Without the user's message threaded through, triage can't tell the request was
  // broad and would dump every job-alert email back into the answer.
  const spoken = summarizeReadOnlyActionResults([
    { action: 'search_emails', result: { success: true, emails: [
      { from: 'Indeed <alert@indeed.com>', subject: 'New jobs 1', snippet: 'Recommended jobs. Manage preferences.' },
      { from: 'WorkCircle <alerts@workcircle.co.uk>', subject: 'Job alert digest', snippet: 'New vacancies.' },
      { from: 'FindEveryJob <jobs@findeveryjob.com>', subject: 'Latest job alerts', snippet: 'Recommended roles.' }
    ] } },
    { action: 'get_calendar_events', result: { success: true, events: [] } }
  ], 'Check my emails for anything important today, then check my calendar for tomorrow and tell me what I need to prepare for.');
  assert.match(spoken, /Nothing urgent needs your attention/i);
  assert.doesNotMatch(spoken, /Indeed|WorkCircle|FindEveryJob/);
});

test('compound read-only summary surfaces a failed half instead of pretending it succeeded', () => {
  const spoken = summarizeReadOnlyActionResults([
    { action: 'search_emails', result: { success: false, error: 'Auth expired.' } },
    { action: 'get_calendar_events', result: { success: true, events: [{ title: 'Planning', start: '2026-07-05T09:00:00', end: '2026-07-05T10:00:00' }] } }
  ]);
  assert.doesNotMatch(spoken, /Upcoming events:/);
  assert.match(spoken, /Planning/);
  assert.match(spoken, /Search Emails failed/i);
});

test('structured email context strips URLs boilerplate and raw addresses', () => {
  const [context] = getStructuredDataResults([
    { action: 'search_emails', result: { success: true, emails: [{
      from: 'Jobs Bot <jobs@example.com>',
      subject: 'New roles',
      body: '<p>Apply here https://tracking.example.com/a?utm_source=x</p> Manage preferences. Privacy policy. Relevant: interview tomorrow.'
    }] } }
  ]);
  assert.match(context.text, /Jobs Bot/);
  assert.match(context.text, /New roles/);
  assert.match(context.text, /Relevant: interview tomorrow/);
  assert.doesNotMatch(context.text, /https?:\/\//);
  assert.doesNotMatch(context.text, /jobs@example\.com/);
  assert.doesNotMatch(context.text, /Manage preferences|Privacy policy/i);
});

test('broad important email triage deprioritises repetitive automated bulk alerts', () => {
  const triage = triageEmailsForRequest([
    { from: 'Indeed <alert@indeed.com>', subject: '12 new jobs for software engineer', snippet: 'Recommended jobs. Manage preferences.' },
    { from: 'WorkCircle Alerts <alerts@workcircle.co.uk>', subject: 'Job alert digest', snippet: 'New vacancies matching your search.' },
    { from: 'FindEveryJob <jobs@findeveryjob.com>', subject: 'Latest job alerts', snippet: 'Recommended roles and unsubscribe links.' }
  ], 'Check my emails for anything important today');
  assert.equal(triage.primary.length, 0);
  assert.equal(triage.groups.some(group => group.category === 'job alerts' && group.count === 3), true);
});

test('direct actionable email outranks generic newsletters and job-alert digests', () => {
  const triage = triageEmailsForRequest([
    { from: 'Newsletter <news@example.com>', subject: 'Weekly digest', snippet: 'Roundup and offers.' },
    { from: 'Indeed <alert@indeed.com>', subject: 'New jobs for you', snippet: 'Recommended jobs. Manage preferences.' },
    { from: 'Sam <sam@example.com>', subject: 'Can you confirm tomorrow?', snippet: 'Can you confirm the numbers before 3pm today?' }
  ], 'Anything important in my email?');
  assert.equal(triage.primary[0].sender, 'Sam');
  assert.match(triage.primary[0].subject, /confirm tomorrow/i);
});

test('contextual job request allows relevant job-alert emails to surface', () => {
  const triage = triageEmailsForRequest([
    { from: 'Indeed <alert@indeed.com>', subject: 'Interview-ready backend roles', snippet: 'New jobs matching your applications.' },
    { from: 'Retailer <sale@example.com>', subject: 'Summer sale', snippet: 'Offer ends soon.' }
  ], 'Check my job opportunities today');
  assert.equal(triage.primary.some(email => /backend roles/i.test(email.subject)), true);
});

test('structured broad email context groups low-value emails rather than dumping each one', () => {
  const [context] = getStructuredDataResults([
    { action: 'search_emails', result: { success: true, emails: [
      { from: 'Indeed <alert@indeed.com>', subject: 'New jobs 1', snippet: 'Recommended jobs. Manage preferences.' },
      { from: 'WorkCircle <alerts@workcircle.co.uk>', subject: 'Job alert digest', snippet: 'New vacancies.' },
      { from: 'FindEveryJob <jobs@findeveryjob.com>', subject: 'Latest job alerts', snippet: 'Recommended roles.' }
    ] } }
  ], 'Check my emails for anything important today');
  assert.match(context.text, /Primary items: none clearly urgent/i);
  assert.match(context.text, /Grouped low-priority material: 3 job alerts/i);
  assert.doesNotMatch(context.text, /1\.|2\.|3\.|Sender:/);
});

test('structured calendar context filters tomorrow-only events and formats natural times', () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(tomorrow).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  const target = `${ymd.year}-${ymd.month}-${ymd.day}`;
  const [context] = getStructuredDataResults([
    { action: 'get_calendar_events', input: { when: 'tomorrow' }, result: { success: true, events: [
      { title: 'Actual tomorrow', start: `${target}T09:00:00+01:00`, end: `${target}T10:00:00+01:00` },
      { title: 'Future unrelated', start: '2030-01-01T09:00:00+00:00', end: '2030-01-01T10:00:00+00:00' }
    ] } }
  ]);
  assert.match(context.text, /Actual tomorrow/);
  assert.doesNotMatch(context.text, /Future unrelated/);
  assert.doesNotMatch(context.text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
});

test('visible data response guard replaces raw tool-result leakage', () => {
  const contexts = getStructuredDataResults([
    { action: 'search_emails', result: { success: true, emails: [{ from: 'A <a@example.com>', subject: 'Budget', body: 'Bring numbers.' }] } }
  ]);
  const spoken = guardVisibleDataResponse('Email results:\nBody: Bring numbers. https://tracking.example.com/open', contexts);
  assert.match(spoken, /Budget/);
  assert.doesNotMatch(spoken, /Email results:|Body:|https?:\/\//);
});

test('compound email and calendar fallback leads with the conclusion', () => {
  const contexts = getStructuredDataResults([
    { action: 'search_emails', result: { success: true, emails: [
      { from: 'Indeed <alert@indeed.com>', subject: 'New jobs', snippet: 'Recommended jobs. Manage preferences.' }
    ] } },
    { action: 'get_calendar_events', input: { when: 'tomorrow' }, result: { success: true, events: [] } }
  ], 'Check my emails for anything important today, then check my calendar for tomorrow and tell me what I need to prepare for.');
  const spoken = guardVisibleDataResponse('Email results:\nBody: raw leak', contexts);
  assert.match(spoken.split('\n')[0], /Nothing urgent needs your attention/i);
  assert.doesNotMatch(spoken, /Indeed.*New jobs.*Recommended jobs/i);
});

test('client action normalization removes raw data payloads but keeps receipt metadata', () => {
  const [emailAction, calendarAction] = normalizeActionResultsForClient([
    { action: 'search_emails', result: { success: true, emails: [{ from: 'A <a@example.com>', subject: 'Budget', body: 'secret body' }] } },
    { action: 'get_calendar_events', result: { success: true, events: [{ title: 'Planning', start: '2030-01-01T09:00:00Z' }] } }
  ]);
  assert.equal(emailAction.result.cardText, '1 email reviewed');
  assert.equal(emailAction.result.emailCount, 1);
  assert.equal(emailAction.result.emails, undefined);
  assert.equal(calendarAction.result.cardText, '1 calendar item checked');
  assert.equal(calendarAction.result.eventCount, 1);
  assert.equal(calendarAction.result.events, undefined);
});

test('compound read-only routing keeps a qualifier that precedes its own trigger word', () => {
  const turn = inferCompoundReadOnlyTurn('Anything important in my emails today, then check my calendar for tomorrow.');
  assert.equal(turn.reason, 'compound_read_only');
  assert.deepEqual(turn.actions.map(action => action.type), ['search_emails', 'get_calendar_events']);
  assert.equal(turn.actions[0].input.max_results, 20);
  assert.equal(turn.actions[1].input.when, 'tomorrow');
});

test('parseActions flags malformed JSON instead of silently dropping it', () => {
  const { actions, parseError } = parseActions('Done. <action>{not json}</action>');
  assert.equal(actions.length, 0);
  assert.equal(parseError, true);
});

test('parseActions tolerates code-fenced JSON', () => {
  const { actions } = parseActions('<action>```json\n{"actions":[{"type":"x"}]}\n```</action>');
  assert.equal(actions[0].type, 'x');
});

test('mentionsActionCommitment catches phantom promises', () => {
  assert.equal(mentionsActionCommitment("I'll set that reminder for 8am."), true);
  assert.equal(mentionsActionCommitment('Done — reminder set.'), true);
  assert.equal(mentionsActionCommitment("I'll send the email shortly."), true);
});

test('mentionsActionCommitment ignores non-action phrasing', () => {
  assert.equal(mentionsActionCommitment("I'll be honest, that's tricky."), false);
  assert.equal(mentionsActionCommitment('The weather is nice today.'), false);
  assert.equal(mentionsActionCommitment(''), false);
});

test('parsePrice extracts amounts from real checkout strings', () => {
  assert.equal(parsePrice('£150'), 150);
  assert.equal(parsePrice('$5.00'), 5);
  assert.equal(parsePrice('1,299.99 USD'), 1299.99);
  assert.equal(parsePrice('Total: £42.50'), 42.5);
  assert.equal(parsePrice('free'), null);
  assert.equal(parsePrice(''), null);
});

test('decidePaymentByCap auto-pays only within a set cap', () => {
  assert.equal(decidePaymentByCap('£80', 100).decision, 'pay');
  assert.equal(decidePaymentByCap('£100', 100).decision, 'pay'); // boundary inclusive
  assert.equal(decidePaymentByCap('£150', 100).decision, 'approve'); // over cap
  assert.equal(decidePaymentByCap('sold out', 100).decision, 'approve'); // unparseable → never pay
  assert.equal(decidePaymentByCap('£10', 0).decision, 'approve'); // no cap → never auto-pay
  assert.equal(decidePaymentByCap('£10', null).decision, 'approve');
});

test('runAgentLoop stops when the model emits no action (done)', async () => {
  const s = scriptedLoop({ replies: ['All finished.'] });
  const out = await runAgentLoop({ userId: 'u', contents: [{ role: 'user', parts: [{ text: 'go' }] }], ...s });
  assert.equal(out.status, 'done');
  assert.equal(out.spoken, 'All finished.');
  assert.equal(out.steps, 1);
});

test('runAgentLoop chains: acts, feeds results back, then finishes', async () => {
  const s = scriptedLoop({
    replies: [`Looking it up. ${ACT}`, 'Here is the answer.'],
    batches: [[{ action: 'x', result: { text: 'data' } }]]
  });
  const out = await runAgentLoop({ userId: 'u', contents: [{ role: 'user', parts: [{ text: 'go' }] }], ...s });
  assert.equal(out.status, 'done');
  assert.equal(out.spoken, 'Here is the answer.');
  assert.equal(out.steps, 2);
});

test('runAgentLoop pauses when an action needs the user (review_required)', async () => {
  const s = scriptedLoop({
    replies: [`Working. ${ACT}`],
    batches: [[{ action: 'send_email', result: { confirmation: 'review_required', text: 'Send this?' } }]]
  });
  const out = await runAgentLoop({ userId: 'u', contents: [{ role: 'user', parts: [{ text: 'go' }] }], ...s });
  assert.equal(out.status, 'paused');
});

test('runAgentLoop auto-pays a browser purchase under the cap', async () => {
  const s = scriptedLoop({
    replies: [`Buying. ${ACT}`, 'Booked your tickets.'],
    batches: [[{ action: 'run_browser_task', result: { confirmation: 'review_required', total: '£80' } }]]
  });
  const out = await runAgentLoop({ userId: 'u', budgetCap: 100, contents: [{ role: 'user', parts: [{ text: 'go' }] }], ...s });
  assert.equal(out.status, 'done');
  assert.equal(out.spoken, 'Booked your tickets.');
});

test('runAgentLoop pauses a browser purchase over the cap (no auto-pay)', async () => {
  let confirmed = false;
  const s = scriptedLoop({
    replies: [`Buying. ${ACT}`],
    batches: [[{ action: 'run_browser_task', result: { confirmation: 'review_required', total: '£150' } }]]
  });
  s.confirm = async () => { confirmed = true; return { success: true }; };
  const out = await runAgentLoop({ userId: 'u', budgetCap: 100, contents: [{ role: 'user', parts: [{ text: 'go' }] }], ...s });
  assert.equal(out.status, 'paused');
  assert.equal(confirmed, false); // never paid over cap
});

test('runAgentLoop is bounded by maxSteps', async () => {
  const s = scriptedLoop({
    replies: Array(10).fill(`More. ${ACT}`),
    batches: Array(10).fill([{ action: 'x', result: { text: 'ok' } }])
  });
  const out = await runAgentLoop({ userId: 'u', maxSteps: 3, contents: [{ role: 'user', parts: [{ text: 'go' }] }], ...s });
  assert.equal(out.status, 'maxSteps');
});

test('pendant transcription upload validation rejects empty and accepts wav audio field payloads', () => {
  assert.deepEqual(validatePendantTranscriptionUpload(null), { ok: false, status: 400, error: 'No audio file received.' });
  assert.deepEqual(validatePendantTranscriptionUpload({ originalname: 'voice.wav', mimetype: 'audio/wav', buffer: Buffer.alloc(0) }), {
    ok: false,
    status: 400,
    error: 'Audio file was empty.'
  });
  const valid = validatePendantTranscriptionUpload({ originalname: 'voice.wav', mimetype: 'audio/wav', buffer: Buffer.alloc(44) });
  assert.equal(valid.ok, true);
  assert.equal(valid.size, 44);
});

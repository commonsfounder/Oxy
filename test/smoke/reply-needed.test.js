// The deterministic parts of "who's waiting on me?" — the pre-filter, thread grouping, response
// parsing and prioritised summary. The judgment call and real thread-fetching are covered in
// find-reply-needed-orchestration.test.js.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isObviouslyNoReplyNeeded,
  latestMessagePerThread,
  buildReplyNeededPrompt,
  parseReplyNeededResponse,
  formatReplyNeededSummary
} = require('../../api/services/reply-needed');

// The prompt is a template literal wrapped for readability, so a multi-word assertion must
// tolerate a line break landing between words — same convention as millie-voice.test.js.
function phrase(text) {
  return new RegExp(text.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
}

// ── isObviouslyNoReplyNeeded (cheap pre-filter before the LLM call) ────────────────────────
test('isObviouslyNoReplyNeeded filters newsletters, receipts, and automated notifications', () => {
  assert.equal(isObviouslyNoReplyNeeded({ senderAddress: 'noreply@example.com', subject: 'Your receipt' }), true);
  assert.equal(isObviouslyNoReplyNeeded({ senderAddress: 'deals@temu.com', listUnsubscribe: '<https://x/unsub>' }), true);
  assert.equal(isObviouslyNoReplyNeeded({ senderAddress: 'shop@example.com', subject: 'Your order has shipped' }), true);
  assert.equal(isObviouslyNoReplyNeeded({ senderAddress: 'news@example.com', subject: 'Weekly digest' }), true);
});

test('isObviouslyNoReplyNeeded does not filter an ordinary personal email', () => {
  assert.equal(isObviouslyNoReplyNeeded({ senderAddress: 'sam@example.com', subject: 'Can you confirm tomorrow?' }), false);
});

// ── latestMessagePerThread ──────────────────────────────────────────────────────────────
test('latestMessagePerThread keeps only the most recent message per thread', () => {
  const emails = [
    { threadId: 't1', id: 'm1', date: 'Mon, 01 Jun 2026 09:00:00 +0100', subject: 'old' },
    { threadId: 't1', id: 'm2', date: 'Wed, 03 Jun 2026 09:00:00 +0100', subject: 'newest' },
    { threadId: 't2', id: 'm3', date: 'Tue, 02 Jun 2026 09:00:00 +0100', subject: 'other thread' }
  ];
  const out = latestMessagePerThread(emails);
  assert.equal(out.length, 2);
  const t1 = out.find(e => e.threadId === 't1');
  assert.equal(t1.subject, 'newest');
});

test('latestMessagePerThread tolerates messages with no threadId by using their own id', () => {
  const out = latestMessagePerThread([{ id: 'solo1', subject: 'x' }]);
  assert.equal(out.length, 1);
});

// ── buildReplyNeededPrompt ──────────────────────────────────────────────────────────────
test('buildReplyNeededPrompt includes every thread, keeps them independently labeled, and never blends thread content', () => {
  const prompt = buildReplyNeededPrompt([
    { threadId: 't1', senderName: 'Sam', subject: 'Numbers?', threadText: 'Can you send the Q3 numbers?' },
    { threadId: 't2', senderName: 'Jo', subject: 'Lunch', threadText: 'Thanks, all sorted!' }
  ]);
  assert.match(prompt, /THREAD 0/);
  assert.match(prompt, /THREAD 1/);
  assert.match(prompt, /Can you send the Q3 numbers\?/);
  assert.match(prompt, /Thanks, all sorted!/);
  // The prompt explicitly instructs independent, per-thread judgment.
  assert.match(prompt, /Judge each thread independently/);
});

test('buildReplyNeededPrompt instructs excluding threads the user already answered, and including unfulfilled self-commitments', () => {
  const prompt = buildReplyNeededPrompt([]);
  assert.match(prompt, phrase("does NOT need a response — even if the other person hasn't replied again yet"));
  assert.match(prompt, phrase('DOES still need something from the user — they are the blocker'));
});

// ── parseReplyNeededResponse ─────────────────────────────────────────────────────────────
const THREADS = [
  { threadId: 't1', senderName: 'Sam', subject: 'Numbers?', date: '2026-06-01' },
  { threadId: 't2', senderName: 'Newsletter', subject: 'Digest', date: '2026-06-02' }
];

test('parseReplyNeededResponse keeps only threads judged needsResponse:true', () => {
  const raw = JSON.stringify([
    { needsResponse: true, kind: 'reply', whatTheyNeed: 'confirm the Q3 numbers', reasoning: 'asked a direct question', urgency: 'soon' },
    { needsResponse: false, kind: null, whatTheyNeed: '', reasoning: 'newsletter', urgency: null }
  ]);
  const items = parseReplyNeededResponse(raw, THREADS);
  assert.equal(items.length, 1);
  assert.equal(items[0].threadId, 't1');
  assert.equal(items[0].sender, 'Sam');
  assert.equal(items[0].whatTheyNeed, 'confirm the Q3 numbers');
  assert.equal(items[0].kind, 'reply');
  assert.equal(items[0].urgency, 'soon');
});

test('parseReplyNeededResponse tolerates malformed/missing JSON without throwing', () => {
  assert.deepEqual(parseReplyNeededResponse('not json at all', THREADS), []);
  assert.deepEqual(parseReplyNeededResponse('', THREADS), []);
  assert.deepEqual(parseReplyNeededResponse('{"not":"an array"}', THREADS), []);
});

test('parseReplyNeededResponse defaults an unrecognised kind to "reply" and a missing whatTheyNeed to a safe fallback', () => {
  const raw = JSON.stringify([{ needsResponse: true, kind: 'weird', whatTheyNeed: '', reasoning: '' }]);
  const items = parseReplyNeededResponse(raw, [THREADS[0]]);
  assert.equal(items[0].kind, 'reply');
  assert.equal(items[0].whatTheyNeed, 'a response');
});

// ── formatReplyNeededSummary ──────────────────────────────────────────────────────────────
test('formatReplyNeededSummary is honest when nobody is waiting on the user', () => {
  assert.match(formatReplyNeededSummary([]), /Nobody's waiting on you right now/);
});

test('formatReplyNeededSummary prioritizes urgency and gives a real, specific list', () => {
  const text = formatReplyNeededSummary([
    { sender: 'Recruiter', whatTheyNeed: 'confirm your interview availability', kind: 'reply', urgency: 'now', waitingSince: null },
    { sender: 'Landlord', whatTheyNeed: 'sign the renewal form', kind: 'action', urgency: 'soon', waitingSince: null }
  ]);
  assert.match(text, /^2 things need your attention/);
  assert.match(text, /Recruiter is waiting on you to confirm your interview availability/);
  assert.match(text, /Landlord needs you to sign the renewal form/);
  // Urgency-first ordering: 'now' item appears before the 'soon' item.
  assert.ok(text.indexOf('Recruiter') < text.indexOf('Landlord'));
});

test('formatReplyNeededSummary caps the list and notes how many more exist, rather than dumping everything', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ sender: `Person${i}`, whatTheyNeed: 'reply', kind: 'reply', urgency: 'whenever', waitingSince: null }));
  const text = formatReplyNeededSummary(items, { maxItems: 8 });
  assert.match(text, /\(\+4 more\)/);
});

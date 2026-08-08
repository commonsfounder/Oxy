// Pure decision logic for "clean my inbox" (api/services/gmail-cleanup.js). Deliberately
// reuses the shared email triage classifier (emailTriageSignals in api/index.js) rather than
// building a parallel one — these tests exercise the DECISION layer on top of it: what to do
// with a triage verdict, and how to talk about the result truthfully. The real Gmail I/O is
// covered separately in test/smoke/gmail-cleanup-mutations.test.js (mutation primitives) and
// test/smoke/clean-inbox-orchestration.test.js (the full search->classify->archive->
// unsubscribe->summarize pipeline).

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildCleanupQuery,
  classifyForCleanup,
  dedupeSendersForUnsubscribe,
  senderLabel,
  summarizeCleanupResult
} = require('../../api/services/gmail-cleanup');
const { emailTriageSignals } = require('../../api/index');

// ── buildCleanupQuery ───────────────────────────────────────────────────────────────────
test('buildCleanupQuery defaults to scoping the inbox only, nothing else', () => {
  assert.equal(buildCleanupQuery({}), 'in:inbox');
});

test('buildCleanupQuery scopes to one sender without touching the rest of the inbox', () => {
  assert.equal(buildCleanupQuery({ sender: 'temu.com' }), 'in:inbox from:temu.com');
});

test('buildCleanupQuery adds real Gmail date operators for a "since"/"before" window', () => {
  const q = buildCleanupQuery({ since: '2026-05-01', before: '2026-08-01' });
  assert.match(q, /^in:inbox after:2026\/05\/01 before:2026\/08\/01$/);
});

test('buildCleanupQuery combines sender + date scope ("archive newsletters from X older than a month")', () => {
  const q = buildCleanupQuery({ sender: 'newsletter@example.com', before: '2026-07-08' });
  assert.equal(q, 'in:inbox from:newsletter@example.com before:2026/07/08');
});

test('buildCleanupQuery lets an explicit query override everything else (the escape hatch)', () => {
  assert.equal(buildCleanupQuery({ sender: 'ignored.com', query: 'category:promotions' }), 'category:promotions');
});

test('buildCleanupQuery ignores an unparsable date rather than emitting a broken operator', () => {
  assert.equal(buildCleanupQuery({ since: 'not a date' }), 'in:inbox');
});

// ── classifyForCleanup ──────────────────────────────────────────────────────────────────
function triageFor(email, message = '') {
  return emailTriageSignals(email, message);
}

test('classifyForCleanup never archives something that looks like it needs a reply', () => {
  const email = { from: 'Sam <sam@example.com>', subject: 'Can you confirm tomorrow?', snippet: 'Can you confirm the numbers before 3pm today?' };
  const decision = classifyForCleanup(email, triageFor(email));
  assert.equal(decision.archive, false);
});

test('classifyForCleanup archives genuine promotional/bulk mail and flags it unsubscribe-eligible when it carries List-Unsubscribe', () => {
  const email = {
    from: 'Temu <deals@temu.com>',
    subject: '70% OFF everything - Limited time offer!',
    snippet: 'Shop now and save. Unsubscribe from these emails.',
    listUnsubscribe: '<https://temu.com/unsub>'
  };
  const decision = classifyForCleanup(email, triageFor(email));
  assert.equal(decision.archive, true);
  assert.equal(decision.unsubscribeCandidate, true);
});

test('classifyForCleanup does not offer to unsubscribe from a promotional email with no List-Unsubscribe header', () => {
  const email = { from: 'Temu <deals@temu.com>', subject: '70% OFF everything - offer', snippet: 'Shop now and save. Unsubscribe from these emails.' };
  const decision = classifyForCleanup(email, triageFor(email));
  assert.equal(decision.archive, true);
  assert.equal(decision.unsubscribeCandidate, false);
});

test('classifyForCleanup preserves a receipt from an automated sender instead of archiving it as junk', () => {
  const email = { from: 'Amazon <auto-confirm@amazon.co.uk>', subject: 'Your order has shipped', snippet: 'Your order #123 has shipped. Tracking number: ABC123' };
  const decision = classifyForCleanup(email, triageFor(email));
  assert.equal(decision.archive, false, 'a settled receipt is not junk, even from a no-reply-shaped address');
});

test('classifyForCleanup preserves ordinary uncertain mail by default ("if uncertain, preserve")', () => {
  const email = { from: 'Old Friend <friend@example.com>', subject: 'hey', snippet: 'long time no see, how have you been' };
  const decision = classifyForCleanup(email, triageFor(email));
  assert.equal(decision.archive, false);
});

test('classifyForCleanup: a sender is not globally junk — the SAME sender\'s receipt and promo are judged independently', () => {
  const promo = { from: 'Boohoo <deals@boohoo.com>', subject: '50% off everything this weekend', snippet: 'Sale ends Sunday. Unsubscribe anytime.', listUnsubscribe: '<https://boohoo.com/unsub>' };
  const receipt = { from: 'Boohoo <deals@boohoo.com>', subject: 'Your order has shipped', snippet: 'Order confirmation: your order has shipped, tracking number XYZ', listUnsubscribe: '<https://boohoo.com/unsub>' };
  const promoDecision = classifyForCleanup(promo, triageFor(promo));
  const receiptDecision = classifyForCleanup(receipt, triageFor(receipt));
  assert.equal(promoDecision.archive, true);
  assert.equal(receiptDecision.archive, false, 'the receipt from the exact same sender must survive');
});

test('classifyForCleanup tolerates a missing triage signal without throwing', () => {
  const decision = classifyForCleanup({}, null);
  assert.equal(decision.archive, false);
});

// ── dedupeSendersForUnsubscribe ─────────────────────────────────────────────────────────
test('dedupeSendersForUnsubscribe collapses many messages from the same sender to one attempt', () => {
  const candidates = [
    { email: { senderAddress: 'deals@temu.com', id: 'm1' } },
    { email: { senderAddress: 'deals@temu.com', id: 'm2' } },
    { email: { senderAddress: 'deals@temu.com', id: 'm3' } },
    { email: { senderAddress: 'news@other.com', id: 'm4' } }
  ];
  const out = dedupeSendersForUnsubscribe(candidates);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(c => c.email.id), ['m1', 'm4']);
});

test('dedupeSendersForUnsubscribe is case-insensitive on the sender address', () => {
  const candidates = [
    { email: { senderAddress: 'Deals@Temu.com', id: 'm1' } },
    { email: { senderAddress: 'deals@temu.com', id: 'm2' } }
  ];
  assert.equal(dedupeSendersForUnsubscribe(candidates).length, 1);
});

// ── senderLabel / summarizeCleanupResult ────────────────────────────────────────────────
test('senderLabel prefers a real display name over a bare address', () => {
  assert.equal(senderLabel({ senderName: 'Temu', senderAddress: 'deals@temu.com' }), 'Temu');
  assert.equal(senderLabel({ senderAddress: 'deals@temu.com' }), 'deals@temu.com');
});

test('summarizeCleanupResult reports real counts and reasons, not a dump of every message', () => {
  const text = summarizeCleanupResult({
    scanned: 160,
    archived: 143,
    unsubscribed: [{ sender: 'Temu', method: 'one-click' }],
    preservedCount: 9
  });
  assert.match(text, /Archived 143 emails/);
  assert.match(text, /unsubscribed from 1 mailing list \(Temu\)/);
  assert.match(text, /kept 9 because they looked important/);
});

test('summarizeCleanupResult names what could not be completed and why', () => {
  const text = summarizeCleanupResult({
    scanned: 20,
    archived: 5,
    unsubscribeFailed: [{ sender: 'Old List', reason: 'endpoint returned status 500' }],
    needsBrowserUnsubscribe: [{ sender: 'Manual Retailer', url: 'https://example.com/manage' }]
  });
  assert.match(text, /1 unsubscribe attempt failed \(Old List: endpoint returned status 500\)/);
  assert.match(text, /1 more need a real page visit to finish unsubscribing \(Manual Retailer\)/);
});

test('summarizeCleanupResult is honest when nothing needed doing', () => {
  const text = summarizeCleanupResult({ scanned: 12 });
  assert.equal(text, 'Checked 12 emails — nothing looked safe to clean up.');
});

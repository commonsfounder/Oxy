// Commitment capture, due-date handling and resolution. Most of these guard the conservative
// direction: the cost of missing one is a reminder you did not get, the cost of inventing one
// is being nagged about something you never promised.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  looksLikeCommitment, extractDueDate, isOverdue, isDueToday,
  matchesSentEvidence, describeDue, sortCommitments, formatCommitmentList,
  reconcileSentEmail
} = require('../../api/services/commitments');
const { normalizeCommitmentItem, buildDailyDigest } = require('../../api/services/daily-digest');

const NOW = new Date('2026-08-09T10:00:00.000Z'); // a Sunday

// ── What counts ────────────────────────────────────────────────────────────────────────
test('a real undertaking with a concrete action is a commitment', () => {
  assert.equal(looksLikeCommitment("I'll send that tonight"), true);
  assert.equal(looksLikeCommitment("I'll get the documents to him tomorrow"), true);
  assert.equal(looksLikeCommitment('I need to pay Mum back Friday'), true);
  assert.equal(looksLikeCommitment('I promise I will call him this week'), true);
  assert.equal(looksLikeCommitment("you'll have it by Friday — I will send it over"), true);
});

test('a hedge is not a commitment, however much it sounds like one', () => {
  // This is the whole conservatism rule. Every one of these is how people politely decline.
  assert.equal(looksLikeCommitment("I'll have a look"), false);
  assert.equal(looksLikeCommitment("I'll think about it"), false);
  assert.equal(looksLikeCommitment("I'll check and see"), false);
  assert.equal(looksLikeCommitment("I might send it later"), false);
  assert.equal(looksLikeCommitment("I'll try to get it done"), false);
  assert.equal(looksLikeCommitment("I'll send it if I can"), false);
});

test('someone else asking is not the user promising', () => {
  assert.equal(looksLikeCommitment('Can you send the case study by Tuesday?'), false);
  assert.equal(looksLikeCommitment('Please send the documents tomorrow'), false);
});

test('an undertaking with no concrete action is not tracked', () => {
  assert.equal(looksLikeCommitment("I'll be around"), false);
  assert.equal(looksLikeCommitment("I'm going to consider it"), false);
});

// ── Due dates ──────────────────────────────────────────────────────────────────────────
// Timezone pinned to UTC so these assert the LOGIC, not the tester's clock. A separate test
// below covers the timezone-awareness itself.
const day = (text, tz = 'UTC') => {
  const { dueAt } = extractDueDate(text, NOW, tz);
  return dueAt && new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(dueAt);
};

test('stated timing becomes a real date, and vague timing becomes none', () => {
  assert.equal(day('tomorrow'), '2026-08-10');
  assert.equal(day('today'), '2026-08-09');
  assert.equal(day('by Tuesday'), '2026-08-11');
  assert.equal(day('2026-09-01'), '2026-09-01');
  // No invented deadline. This is what stops a wrong "overdue" later.
  assert.equal(extractDueDate('soon', NOW, 'UTC').dueAt, null);
  assert.equal(extractDueDate('at some point', NOW, 'UTC').dueAt, null);
  assert.equal(extractDueDate('', NOW, 'UTC').dueAt, null);
});

test('"tonight" is an evening time, not the start of the day', () => {
  const tonight = extractDueDate('tonight', NOW, 'UTC');
  assert.equal(tonight.dueAt.getUTCHours(), 21);
  assert.equal(tonight.dateOnly, false);
});

test('"this week" means the end of the working week, not seven days out', () => {
  assert.equal(day('this week'), '2026-08-14');
});

test('day boundaries follow the user\'s timezone, not UTC', () => {
  // Real bug: "tomorrow" was computed as UTC midnight while "is it today?" was answered in
  // Europe/London, so late in the UTC evening a commitment for tomorrow read as due today.
  const lateEvening = new Date('2026-08-09T23:30:00.000Z'); // already 10 Aug in London
  const londonTomorrow = extractDueDate('tomorrow', lateEvening, 'Europe/London').dueAt;
  const asLondonDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(londonTomorrow);
  assert.equal(asLondonDay, '2026-08-11', 'tomorrow, from the user\'s point of view');
  assert.equal(isDueToday({ status: 'open', due_at: londonTomorrow.toISOString() }, lateEvening, 'Europe/London'), false);
});

// ── Overdue ────────────────────────────────────────────────────────────────────────────
test('a date-only commitment is not late until its day is over', () => {
  const tuesday = { status: 'open', due_at: '2026-08-11T00:00:00.000Z', due_is_date_only: true };
  assert.equal(isOverdue(tuesday, new Date('2026-08-11T00:01:00Z')), false, 'one minute past midnight is not late');
  assert.equal(isOverdue(tuesday, new Date('2026-08-11T18:00:00Z')), false);
  assert.equal(isOverdue(tuesday, new Date('2026-08-12T00:30:00Z')), true);
});

test('a timed commitment is late the moment it passes', () => {
  const tonight = { status: 'open', due_at: '2026-08-09T21:00:00.000Z', due_is_date_only: false };
  assert.equal(isOverdue(tonight, new Date('2026-08-09T20:00:00Z')), false);
  assert.equal(isOverdue(tonight, new Date('2026-08-09T22:00:00Z')), true);
});

test('a commitment with no date is never overdue, and a resolved one never is either', () => {
  assert.equal(isOverdue({ status: 'open', due_at: null }, NOW), false);
  assert.equal(isOverdue({ status: 'done', due_at: '2020-01-01T00:00:00Z' }, NOW), false);
});

// ── Resolution evidence ────────────────────────────────────────────────────────────────
const SEND_DOCS = {
  status: 'open', what: 'send the documents', person_name: 'Mia', thread_id: 'thr-1'
};

test('an outbound message that genuinely covers it is evidence', () => {
  assert.equal(matchesSentEvidence(SEND_DOCS, {
    threadId: 'thr-1', subject: 'Documents', body: 'Sending the documents over now, sorry for the delay.'
  }), true);
});

test('a vaguely-related reply on the same thread is NOT evidence', () => {
  // Silently closing something that was not done is the one failure this cannot afford.
  assert.equal(matchesSentEvidence(SEND_DOCS, {
    threadId: 'thr-1', subject: 'Re: Documents', body: 'Thanks, got it!'
  }), false);
  assert.equal(matchesSentEvidence(SEND_DOCS, {
    threadId: 'thr-1', subject: 'Re: Documents', body: 'I will send the documents tomorrow'
  }), true, 'the action and subject both appear — the model still decides, this only gates it');
});

test('a different promise on the same thread does not close the first one', () => {
  // Caught live: "I will send the revised slides today" closed "send the board pack today,
  // before end of play", because today/before/play were all treated as meaningful terms.
  const boardPack = { status: 'open', what: 'send the board pack today, before end of play', thread_id: 'thr-1', person_name: 'Mia' };
  assert.equal(matchesSentEvidence(boardPack, {
    threadId: 'thr-1', subject: 'Slides', body: 'Also — I will send the revised slides today, before end of play.'
  }), false, 'slides are not a board pack');
  assert.equal(matchesSentEvidence(boardPack, {
    threadId: 'thr-1', subject: 'Board pack', body: 'Sending the board pack across now.'
  }), true, 'the real thing still closes it');
});

test('two different promises to the SAME person are not conflated by one shared word', () => {
  // Caught live: a brand-new, unrelated email to the same recipient closed an old commitment
  // because "board" appears in both "the board pack" and "the board deck". No thread linkage
  // here — matching purely by recipient — so every word of the promise must show up, not one.
  const boardPack = { status: 'open', what: 'send the board pack', person_name: 'mia@example.com' };
  assert.equal(matchesSentEvidence(boardPack, {
    to: 'mia@example.com', threadId: 'unrelated-thread', subject: 'Board deck', body: 'Can you send me the board deck?'
  }), false, 'a deck is not a pack, even though both are "board" something');
  assert.equal(matchesSentEvidence(boardPack, {
    to: 'mia@example.com', threadId: 'unrelated-thread', subject: 'Board pack', body: 'Sending the board pack now.'
  }), true, 'the actual thing, even off-thread, still closes it');
});

test('on the RIGHT thread, one shared word is still enough — the thread already vouches for it', () => {
  const boardPack = { status: 'open', what: 'send the board pack', thread_id: 'thr-1', person_name: 'mia@example.com' };
  assert.equal(matchesSentEvidence(boardPack, {
    threadId: 'thr-1', subject: 'Re: Board pack', body: 'Sending the board version across now.'
  }), true);
});

test('a message to someone else does not close a commitment made to Mia', () => {
  assert.equal(matchesSentEvidence(SEND_DOCS, {
    threadId: 'other', to: 'ben@example.com', subject: 'Documents', body: 'Sending the documents.'
  }), false);
});

test('an already-resolved commitment cannot be re-resolved by evidence', () => {
  assert.equal(matchesSentEvidence({ ...SEND_DOCS, status: 'done' }, {
    threadId: 'thr-1', body: 'send the documents'
  }), false);
});

// ── Reconciling a real, sent email ─────────────────────────────────────────────────────
// looksLikeCommitment and matchesSentEvidence were correct and unit-tested for a while
// without being called from anywhere: nothing captured a promise from a message the user
// actually sent, and nothing ever closed one. This is that seam.
test('a reply the user approved and sent captures the promise it contains', () => {
  const { capture, resolves } = reconcileSentEmail({
    sent: {
      to: 'mia@example.com', subject: 'Re: Case study', threadId: 'thr-9', messageId: 'msg-1',
      body: 'Thanks for chasing. I will send the case study tomorrow, first thing.'
    },
    open: [],
    now: NOW
  });
  assert.equal(resolves.length, 0);
  assert.ok(capture, 'a promise in a sent message is a promise');
  // The undertaking is stripped: everything downstream already supplies the "you'd", so
  // storing "I will send…" reads back as "You told Mia you'd I will send…".
  assert.equal(capture.what, 'send the case study tomorrow, first thing.');
  assert.equal(capture.threadId, 'thr-9');
  assert.equal(capture.personEmail, 'mia@example.com');
  assert.equal(capture.source, 'sent_email');
  assert.equal(capture.sourceRef.messageId, 'msg-1');
  assert.equal(capture.dueIsDateOnly, true);
});

test('the commitment stored is the promise, not the whole email', () => {
  const { capture } = reconcileSentEmail({
    sent: {
      to: 'mia@example.com', threadId: 't', body:
        'Hi Mia, lovely to meet you last week and thanks again for the introduction. ' +
        'I will send the case study tomorrow. ' +
        'Hope the rest of your week goes well.'
    },
    open: [], now: NOW
  });
  assert.equal(capture.what, 'send the case study tomorrow.');
});

test('preamble before the promise is dropped along with the undertaking', () => {
  // Real capture from the live mailbox produced "One more thing — I will send the board pack
  // today", which the digest rendered as "You told Mia you'd One more thing — I will send…".
  const { capture } = reconcileSentEmail({
    sent: { to: 'mia@example.com', body: 'One more thing — I will send the board pack today, before end of play.' },
    open: [], now: NOW
  });
  assert.equal(capture.what, 'send the board pack today, before end of play.');
});

test('a hedge in a sent email is still not a commitment', () => {
  const { capture } = reconcileSentEmail({
    sent: { to: 'mia@example.com', body: "I'll try to get the case study over to you this week." },
    open: [], now: NOW
  });
  assert.equal(capture, null);
});

test('editing the draft and sending again does not create a second commitment', () => {
  const open = [{
    id: 'c1', status: 'open', thread_id: 'thr-9', what: 'I will send the case study tomorrow'
  }];
  const { capture } = reconcileSentEmail({
    sent: {
      to: 'mia@example.com', threadId: 'thr-9',
      // Reworded, same promise — a retry or an edited draft.
      body: 'Quick correction: I will send you the case study tomorrow morning.'
    },
    open, now: NOW
  });
  assert.equal(capture, null, 'the same promise on the same thread is one promise');
});

test('promising a DIFFERENT thing on the same thread is a second commitment', () => {
  // The trap in overlap matching: "tomorrow" and "will" are in every promise ever made, so
  // matching on them would swallow a genuinely new obligation.
  const open = [{ id: 'c1', status: 'open', thread_id: 'thr-9', what: 'I will send the invoice tomorrow' }];
  const { capture } = reconcileSentEmail({
    sent: { to: 'mia@example.com', threadId: 'thr-9', body: 'I will send the contract tomorrow.' },
    open, now: NOW
  });
  assert.ok(capture, 'a different document is a different promise');
  assert.match(capture.what, /contract/);
});

test('the same words to a DIFFERENT thread are a different promise', () => {
  const open = [{ id: 'c1', status: 'open', thread_id: 'thr-9', what: 'I will send the case study tomorrow' }];
  const { capture } = reconcileSentEmail({
    sent: { to: 'ben@example.com', threadId: 'thr-77', body: 'I will send the case study tomorrow.' },
    open, now: NOW
  });
  assert.ok(capture, 'promising the same thing to someone else is a second obligation');
});

test('actually sending the thing closes the commitment', () => {
  const open = [{
    id: 'c1', status: 'open', thread_id: 'thr-9', person_name: 'Mia',
    what: 'I will send the case study tomorrow'
  }];
  const { resolves } = reconcileSentEmail({
    sent: {
      to: 'mia@example.com', threadId: 'thr-9', messageId: 'msg-2',
      subject: 'Case study', body: 'Here it is — sending the case study across now as promised.'
    },
    open, now: NOW
  });
  assert.deepEqual(resolves.map(r => r.id), ['c1']);
});

test('the recipient saying thanks does not close anything', () => {
  // Not evidence the work happened. This is the failure the whole module is shaped to avoid.
  const open = [{ id: 'c1', status: 'open', thread_id: 'thr-9', person_name: 'Mia', what: 'I will send the case study tomorrow' }];
  const { resolves } = reconcileSentEmail({
    sent: { to: 'mia@example.com', threadId: 'thr-9', subject: 'Re: Case study', body: 'No problem at all, thanks!' },
    open, now: NOW
  });
  assert.equal(resolves.length, 0);
});

test('one email can close one promise and open another', () => {
  const open = [{ id: 'c1', status: 'open', thread_id: 'thr-9', person_name: 'Mia', what: 'I will send the case study tomorrow' }];
  const { capture, resolves } = reconcileSentEmail({
    sent: {
      to: 'mia@example.com', threadId: 'thr-9',
      subject: 'Case study',
      body: 'Sending the case study now. I will also share the deck on Friday.'
    },
    open, now: NOW
  });
  assert.deepEqual(resolves.map(r => r.id), ['c1']);
  assert.ok(capture);
  assert.match(capture.what, /share the deck on Friday/);
});

test('a promise made near midnight is due on the right local day', () => {
  // The UTC-vs-local boundary that previously made "tomorrow" read as "due today".
  const lateEvening = new Date('2026-08-09T23:30:00Z');
  const { capture } = reconcileSentEmail({
    sent: { to: 'mia@example.com', body: 'I will send the case study tomorrow.' },
    open: [], now: lateEvening, timeZone: 'Europe/London'
  });
  assert.equal(isDueToday(
    { status: 'open', due_at: capture.dueAt.toISOString() }, lateEvening, 'Europe/London'
  ), false, 'a promise for tomorrow is not already due today');
});

// ── Presentation ───────────────────────────────────────────────────────────────────────
test('due wording is human and honest about having no date', () => {
  assert.equal(describeDue({ status: 'open', due_at: null }, NOW), 'no date set');
  assert.match(describeDue({ status: 'open', due_at: '2026-08-07T00:00:00Z', due_is_date_only: true }, NOW), /overdue by 2 days/);
  assert.equal(describeDue({ status: 'open', due_at: '2026-08-09T15:00:00Z' }, NOW), 'due today');
  assert.equal(describeDue({ status: 'open', due_at: '2026-08-10T12:00:00Z' }, NOW), 'due tomorrow');
});

test('overdue sorts first, then today, then dated, then undated', () => {
  const sorted = sortCommitments([
    { what: 'undated', status: 'open', due_at: null },
    { what: 'next week', status: 'open', due_at: '2026-08-16T00:00:00Z', due_is_date_only: true },
    { what: 'overdue', status: 'open', due_at: '2026-08-05T00:00:00Z', due_is_date_only: true },
    { what: 'today', status: 'open', due_at: '2026-08-09T15:00:00Z' }
  ], NOW);
  assert.deepEqual(sorted.map(c => c.what), ['overdue', 'today', 'next week', 'undated']);
});

test('an empty list says so, including for a specific person', () => {
  assert.match(formatCommitmentList([], {}), /don't have anything outstanding/);
  assert.match(formatCommitmentList([], { person: 'Ben' }), /haven't promised Ben anything/);
});

test('the summary leads with how many are late', () => {
  const text = formatCommitmentList([
    { what: 'send the documents', person_name: 'Mia', status: 'open', due_at: '2026-08-07T00:00:00Z', due_is_date_only: true }
  ], { now: NOW });
  assert.match(text, /1 thing is overdue/);
  assert.match(text, /send the documents \(Mia\) — overdue by 2 days/);
});

// ── Digest integration ─────────────────────────────────────────────────────────────────
test('an overdue commitment is one of the highest things on the digest', () => {
  const item = normalizeCommitmentItem({
    id: 'c1', what: 'send the case study', person_name: 'Mia', status: 'open',
    due_at: '2026-08-07T00:00:00Z', due_is_date_only: true
  }, NOW);
  assert.equal(item.kind, 'commitment');
  assert.ok(item.priority >= 90);
  assert.match(item.detail, /You told Mia you'd send the case study — overdue by 2 days/);
  assert.equal(item.ref.commitmentId, 'c1');
});

test('a commitment due today is on the digest; one due next week is not', () => {
  const today = normalizeCommitmentItem({ id: 'c2', what: 'call the bank', status: 'open', due_at: '2026-08-09T16:00:00Z' }, NOW);
  const later = normalizeCommitmentItem({ id: 'c3', what: 'book the MOT', status: 'open', due_at: '2026-08-20T00:00:00Z', due_is_date_only: true }, NOW);
  const undated = normalizeCommitmentItem({ id: 'c4', what: 'tidy the garage', status: 'open', due_at: null }, NOW);
  assert.ok(today);
  assert.equal(later, null, 'not on TODAY\'s plate');
  assert.equal(undated, null);
});

test('a resolved commitment disappears from the digest', () => {
  assert.equal(normalizeCommitmentItem({ id: 'c5', what: 'send it', status: 'done', due_at: '2026-08-07T00:00:00Z' }, NOW), null);
});

test('an overdue commitment outranks a reply someone is waiting on', () => {
  const digest = buildDailyDigest({
    now: NOW,
    commitments: [{ id: 'c1', what: 'send the case study', person_name: 'Mia', status: 'open', due_at: '2026-08-07T00:00:00Z', due_is_date_only: true }],
    replyNeeded: [{ threadId: 't1', sender: 'Ben', whatTheyNeed: 'confirm a time', kind: 'reply', urgency: 'soon', waitingSince: '2026-08-08T10:00:00Z' }]
  });
  assert.equal(digest.items[0].kind, 'commitment');
});

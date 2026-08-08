// Regression tests built from a REAL Gmail mailbox, not from imagined email shapes.
//
// Every case below is a message that actually arrived in a live inbox, reproduced with its
// real structure — the HTML entity encoding, the exact sender domain, the exact wording of
// the total line — and with personal details reduced to what the classifier actually reads.
// Each one caught a bug that the previous mock-shaped fixtures did not, because the mocks
// were written the way a receipt "should" look rather than the way real senders send them.
//
// The bugs these lock in:
//   1. HTML-only receipts encode currency as `&pound;`, so no £ ever reached the extractor.
//   2. "The open invoice amount of € 1.44" is a real total phrasing that was not a label.
//   3. "invoice 089001095497" is a real reference with no separator at all.
//   4. A "Notice of Sums in Arrears" was classified archivable.
//   5. A no-reply sender whose text says it is waiting for the user was dropped pre-judgment.
//   6. Abandoned-cart marketing with a List-Unsubscribe header survived cleanup.
//   7. Automated job alerts — the largest junk class in a real inbox — were never archived.
//   8. Payment reminders/failures look exactly like receipts and were becoming "spending".

require('dotenv').config();

const assert = require('node:assert/strict');
const test = require('node:test');

const receipts = require('../../api/services/receipts');
const { isObviouslyNoReplyNeeded } = require('../../api/services/reply-needed');
const { classifyForCleanup } = require('../../api/services/gmail-cleanup');
const app = require('../../api/index');

function triage(email) {
  const signal = app.emailTriageSignals(email, '');
  return { signal, decision: classifyForCleanup(email, signal) };
}

// ── 1. HTML-only receipt with entity-encoded currency ──────────────────────────────────
// Travelzoo sends the total as `<b>&pound;1</b>` in a table cell next to `<b>Total</b>`,
// and there is no text/plain part at all.
const TRAVELZOO = {
  id: 'tz1', threadId: 'tz1',
  senderName: 'Travelzoo', senderAddress: 'membership_uk@travelzoo.com',
  subject: 'Your receipt from Travelzoo (Europe) Limited',
  date: 'Sun, 02 Aug 2026 04:41:32 +0000',
  // Exactly what the connector's stripHtml produces from the real message.
  body: 'Your purchase:\n Travelzoo 30-day trial for £1. Renews automatically for £30/year.\n £0.83\n VAT (20.00%)\n £0.17\n Total\n £1',
  listUnsubscribe: '<https://www.travelzoo.com/uk/myaccount/accountdetails/subscription>'
};

test('a real HTML receipt yields its TOTAL, not the subtotal and not the renewal price', () => {
  const extracted = receipts.extractReceipt(TRAVELZOO);
  assert.ok(extracted, 'a genuine receipt must not extract to nothing');
  assert.equal(extracted.totalAmount, 1);
  assert.equal(extracted.currency, 'GBP');
  assert.equal(extracted.rawTotalText, 'Total £1');
});

test('currency entities survive to the extractor even when nothing upstream decoded them', () => {
  // The same message before any stripping — this is what reaches paths that skip the
  // connector, and it used to produce no total at all.
  const raw = { ...TRAVELZOO, body: 'Total &pound;1 VAT (20.00%) &pound;0.17' };
  assert.equal(receipts.extractReceipt(raw).totalAmount, 1);
  const numeric = { ...TRAVELZOO, body: 'Order total: &#163;42.00' };
  assert.equal(receipts.extractReceipt(numeric).totalAmount, 42);
});

test('a receipt from a sender that also runs a mailing list is still not junk', () => {
  // Travelzoo's receipt carries a List-Unsubscribe header and an unsubscribe footer. The
  // list-mail signal must not be able to reclassify a receipt as promotional.
  const { decision } = triage(TRAVELZOO);
  assert.equal(decision.archive, false);
});

// ── 2/3. Real invoice phrasing and a separator-less reference ──────────────────────────
const HETZNER = {
  id: 'hz1', threadId: 'hz1',
  senderName: 'no-reply', senderAddress: 'noreply.billing@hetzner.com',
  subject: 'Hetzner Online GmbH - Invoice 089001095497 (K0394374026)',
  date: 'Mon, 03 Aug 2026 01:59:09 +0000',
  body: 'Dear Mr Onyewuchi,\n\nEnclosed you will find your current invoice 089001095497 in PDF format.\n\nThe open invoice amount of € 1.44 will soon be debited from your credit card.'
};

test('"the open invoice amount of € 1.44" is a real total, and the bare invoice number is a real reference', () => {
  const extracted = receipts.extractReceipt(HETZNER);
  assert.ok(extracted);
  assert.equal(extracted.totalAmount, 1.44);
  assert.equal(extracted.currency, 'EUR');
  assert.equal(extracted.orderId, '089001095497');
  assert.equal(extracted.merchant, 'Hetzner');
});

test('a separator-less reference still cannot swallow an ordinary following word', () => {
  assert.equal(receipts.extractOrderId('your order shipped yesterday'), null);
  assert.equal(receipts.extractOrderId('invoice attached for review'), null);
  assert.equal(receipts.extractOrderId('invoice 089001095497'), '089001095497');
});

// ── 4. Money owed is not money spent ───────────────────────────────────────────────────
const CLEARPAY_REMINDER = {
  id: 'cp1', threadId: 'cp1',
  senderName: 'Clearpay', senderAddress: 'donotreply@clearpay.co.uk',
  subject: 'Payment reminder', date: 'Sun, 02 Aug 2026 09:28:21 +0000',
  body: 'Hi Chizigam Just a friendly reminder that a payment of £12.50 is due in 4 days Payment reminder Due date Thu, 6 Aug 2026 Total amount due £12.50 Amount due: £12.50'
};

const CLEARPAY_FAILED = {
  id: 'cp2', threadId: 'cp2',
  senderName: 'Clearpay', senderAddress: 'donotreply@clearpay.co.uk',
  subject: 'Afterpay - Your payment failed to process 400492982909',
  date: 'Thu, 06 Aug 2026 05:09:11 +0000',
  body: 'We attempted to automatically charge the following amount for your order from Clearpay Gift Cards, but it was unsuccessful. Amount £12.50 Failed Payment method VISA **4464'
};

test('an instalment reminder and a failed charge are obligations, never spending', () => {
  // All three of these carry a labelled amount in receipt shape. Counting them would inflate
  // spending with money that was never taken — and count the same £12.50 three times over.
  assert.equal(receipts.extractReceipt(CLEARPAY_REMINDER), null);
  assert.equal(receipts.extractReceipt(CLEARPAY_FAILED), null);
  assert.equal(receipts.isPaymentRequest(CLEARPAY_REMINDER), true);
  assert.equal(receipts.isPaymentRequest(CLEARPAY_FAILED), true);
});

// ── 5. The worst one: an arrears notice was archivable ─────────────────────────────────
const CAPITAL_ONE_ARREARS = {
  id: 'co1', threadId: 'co1',
  senderName: 'Capital One', senderAddress: 'capitalone@notification.capitalone.co.uk',
  subject: 'Chizigam, this is a Notice of Sums in Arrears',
  date: 'Sat, 08 Aug 2026 03:38:34 +0000',
  body: "You've missed two or more credit card payments. Capital One Account Number ending 2073 You have missed payments Account ID: 00016679049"
};

test('a real arrears notice is never archived and reads as actionable', () => {
  // It scored -2 and came out as "bulk updates": none of the old urgency words appear in it,
  // while its sending domain (notification.capitalone.co.uk) collected the automated-sender
  // penalty. Inbox cleanup would have archived a debt notice.
  const { signal, decision } = triage(CAPITAL_ONE_ARREARS);
  assert.equal(decision.archive, false);
  assert.equal(signal.category, 'actionable messages');
  assert.ok(signal.signals.includes('money you owe'));
});

test('an arrears notice is also not mistaken for a purchase', () => {
  assert.equal(receipts.extractReceipt(CAPITAL_ONE_ARREARS), null);
});

// ── 6. "Waiting for your response" from a no-reply address ─────────────────────────────
const YC_INVITE = {
  id: 'yc1', threadId: 'yc1',
  senderName: 'Y Combinator', senderAddress: 'no-reply@ycombinator.com',
  subject: "Imaadu Tawiah's co-founder matching invite is still waiting for your response",
  date: 'Sat, 08 Aug 2026 10:46:20 +0000',
  body: "Hi Chizigam, Friendly reminder that you have an co-founder matching invitation from Imaadu Tawiah that's waiting for your response!"
};

test('a no-reply sender that says it is waiting on the user still reaches judgment', () => {
  assert.equal(isObviouslyNoReplyNeeded(YC_INVITE), false);
});

test('marketing that merely says "please confirm" is still filtered out', () => {
  // Temu sends "Please Confirm: Your £19.99 Offer!" constantly. Including "please confirm" in
  // the override pulled this straight back into the reply-needed candidate set.
  const temu = {
    id: 'tm1', threadId: 'tm1',
    senderName: 'Temu', senderAddress: 'temu@eu.temuemail.com',
    subject: 'Your payment will be available as Credit',
    date: 'Mon, 03 Aug 2026 20:53:06 +0000',
    body: "You've received Credit Back. Please confirm it ASAP> T&Cs apply. You haven't used your £0.16 credits. Please Confirm: Your £19.99 Offer!",
    listUnsubscribe: '<mailto:unsub@temuemail.com>'
  };
  assert.equal(isObviouslyNoReplyNeeded(temu), true);
  assert.equal(receipts.extractReceipt(temu), null, 'none of those amounts were ever charged');
  assert.equal(triage(temu).decision.archive, true);
});

// ── 7. Real promotional mail that uses transactional words ─────────────────────────────
test('an abandoned-cart nudge is archived even though it says "complete your order"', () => {
  const jumia = {
    id: 'jm1', threadId: 'jm1',
    senderName: 'Jumia', senderAddress: 'info@email.jumia.com.ng',
    subject: 'Last chance to complete your order, Chizigam!',
    date: 'Sat, 08 Aug 2026 10:34:08 +0000',
    body: 'Your cart is waiting... with a FREE voucher! Check out now before your items are gone.',
    listUnsubscribe: '<https://jumia.com.ng/unsub>'
  };
  // It contains no marketing vocabulary the content classifier knew, so it was "not clearly
  // junk" and survived every cleanup. The List-Unsubscribe header is what makes it list mail.
  const { decision } = triage(jumia);
  assert.equal(decision.archive, true);
  assert.equal(receipts.extractReceipt(jumia), null);
});

// ── 8. The dominant junk class ─────────────────────────────────────────────────────────
test('automated job alerts are archivable, not merely categorised', () => {
  const indeed = {
    id: 'in1', threadId: 'in1',
    senderName: 'Indeed', senderAddress: 'donotreply@jobalert.indeed.com',
    subject: 'Retail Sales Assistant at Travelex and 23 more new jobs',
    date: 'Sat, 08 Aug 2026 07:03:38 +0000',
    body: '£13.50 an hour. Apply now at Travelex, Shake Shack, and Eurochange',
    listUnsubscribe: '<https://indeed.com/unsub>'
  };
  const { signal, decision } = triage(indeed);
  assert.equal(signal.category, 'job alerts');
  assert.equal(decision.archive, true, 'dozens of these arrive daily and none were ever cleaned');
  assert.equal(decision.unsubscribeCandidate, true);
});

// ── Things that were already right, kept so they stay right ────────────────────────────
test('a genuine booking confirmation is a purchase and is preserved by cleanup', () => {
  const trainpal = {
    id: 'tp1', threadId: 'tp1',
    senderName: 'TrainPal', senderAddress: 'tp-accounts-noreply@trainpal.com',
    subject: 'TrainPal: Booking Confirmation: Birmingham International to Milton Keynes Central',
    date: 'Wed, 05 Aug 2026 05:57:38 +0000',
    body: 'Dear Passenger, Your tickets have been issued. Order No.: TP2608051234 Total: £24.60'
  };
  const extracted = receipts.extractReceipt(trainpal);
  assert.equal(extracted.totalAmount, 24.6);
  assert.equal(extracted.orderId, 'TP2608051234');
  assert.equal(triage(trainpal).decision.archive, false);
});

test('an application acknowledgement needs no reply and is not a purchase', () => {
  const ashby = {
    id: 'as1', threadId: 'as1',
    senderName: 'splose', senderAddress: 'no-reply@ashbyhq.com',
    subject: 'We have received your application',
    date: 'Sat, 08 Aug 2026 08:48:42 +0000',
    body: 'Thanks for applying to the Sales Development Representative (UK) role at splose! We have received your application and our team is currently reviewing it.'
  };
  assert.equal(isObviouslyNoReplyNeeded(ashby), true);
  assert.equal(receipts.extractReceipt(ashby), null);
  assert.equal(triage(ashby).decision.archive, false, 'not junk either — it is a real record');
});

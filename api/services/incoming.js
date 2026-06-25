//
// Heuristic parser: turn raw inbox emails into structured "Incoming" items
// (deliveries + reservations). ponytail: pure keyword/vendor heuristics, no LLM —
// upgrade to a model pass only if real-world coverage proves thin.

const DELIVERY_STAGES = [
  { stage: 3, re: /\b(delivered|was delivered|left at|handed to)\b/i, status: 'Delivered' },
  { stage: 2, re: /\b(out for delivery|arriving today|on the van|with your courier)\b/i, status: 'Out for delivery' },
  { stage: 1, re: /\b(shipped|dispatched|on its way|has been sent)\b/i, status: 'Shipped' },
  { stage: 0, re: /\b(order (confirmed|received|placed)|thanks for your order|we got your order)\b/i, status: 'Ordered' }
];

const RESERVATION_RE = /\b(reservation|booking|table for|booked|your booking)\b/i;
const RESERVATION_CONFIRMED_RE = /\b(confirmed|is confirmed)\b/i;

// Known senders → display vendor. Falls back to the email display name.
const VENDORS = [
  { re: /amazon/i, name: 'Amazon' },
  { re: /opentable/i, name: 'OpenTable' },
  { re: /resy/i, name: 'Resy' },
  { re: /(royalmail|royal mail)/i, name: 'Royal Mail' },
  { re: /(dpd|evri|hermes|ups|fedex|dhl)/i, name: 'Courier' }
];

function vendorOf(from) {
  for (const v of VENDORS) if (v.re.test(from)) return v.name;
  const name = String(from || '').split('<')[0].trim().replace(/"/g, '');
  return name || 'Unknown';
}

function normalize(s) { return String(s || '').trim(); }

function extractIncoming(emails = []) {
  const items = [];
  for (const email of emails) {
    const from = normalize(email.from);
    const subject = normalize(email.subject);
    const snippet = normalize(email.snippet);
    const hay = `${subject} ${snippet}`;

    const stageMatch = DELIVERY_STAGES.find(s => s.re.test(hay) || s.re.test(from));
    if (stageMatch) {
      items.push({
        kind: 'delivery',
        title: subject.replace(/^(re:|fwd:)\s*/i, '') || 'Package',
        vendor: vendorOf(from),
        status: stageMatch.status,
        eta: snippet.match(/\b(today|tomorrow)\b[^.]*?(by\s*\d{1,2}\s*(am|pm)?)?/i)?.[0] || null,
        stage: stageMatch.stage
      });
      continue;
    }

    if (RESERVATION_RE.test(hay)) {
      items.push({
        kind: 'reservation',
        title: subject.replace(/^(re:|fwd:)\s*/i, '') || 'Reservation',
        vendor: vendorOf(from),
        status: RESERVATION_CONFIRMED_RE.test(hay) ? 'Confirmed' : 'Pending',
        eta: snippet.match(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b[^.]*?(\d{1,2}(:\d{2})?\s*(am|pm)?)?/i)?.[0] || null,
        stage: null
      });
    }
  }
  return items;
}

module.exports = { extractIncoming };

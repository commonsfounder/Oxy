'use strict';

// Turning real emails into real purchase records — and refusing to when the evidence is not
// there.
//
// The governing rule: a total is only ever taken from a LABELLED total ("Order total: £84.99",
// "Amount paid $19", "You were charged €12.50"). Never from the largest number in the email,
// never from a bare price, never from a promotional "£20 off". A promotional email full of
// prices must produce nothing at all, because reporting "you spent £842.17 last month" from
// numbers that were never charged is worse than reporting a smaller, true figure.
//
// Receipt DETECTION deliberately reuses the same signal shape emailTriageSignals already uses
// for its 'receipt or confirmation' bucket (the one that stops inbox cleanup from archiving
// real receipts) rather than inventing a second, divergent idea of what a receipt is.

// Starts from the same transactional vocabulary emailTriageSignals scores as 'receipt or
// confirmation', plus the labelled-total wording that only ever appears in a real receipt
// ("order total", "amount paid") — a receipt whose subject is just "Your Amazon.co.uk order
// #205-…" is identified by its body, not its subject line.
const RECEIPT_SUBJECT_PATTERN = /\b(receipt|invoice|order confirm(?:ed|ation)?|order number|order\s*#\s*\d+|your order|order total|amount (?:paid|charged)|total charged|has shipped|been delivered|payment (?:receipt|confirmation|received)|refund|thanks? for your (?:order|purchase|payment)|purchase confirmation|booking confirm(?:ed|ation)?)\b/i;
// Marketing language that must veto a receipt reading even when prices are present.
const PROMOTIONAL_PATTERN = /\b(\d+% off|sale (?:ends|now)|shop now|limited time|deal of the|don'?t miss|new arrivals|save up to|black friday|clearance|discount code|voucher code|browse (?:our|the)|recommended for you|just for you|flash sale)\b/i;
const REFUND_PATTERN = /\b(refund(?:ed)?|money back|return (?:processed|received|accepted)|credit(?:ed)? (?:back )?to your)\b/i;

const CURRENCY_SYMBOLS = { '£': 'GBP', '$': 'USD', '€': 'EUR', '¥': 'JPY' };
const CURRENCY_CODES = ['GBP', 'USD', 'EUR', 'JPY', 'CAD', 'AUD', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN'];

// Only these labels license reading a number as "what was charged".
const TOTAL_LABEL = '(?:order\\s+total|grand\\s+total|total\\s+(?:paid|charged|cost|price|amount)|total|amount\\s+(?:paid|charged|due)|you\\s+(?:paid|were\\s+charged)|payment\\s+(?:total|amount)|charged|paid)';
const AMOUNT = '([£$€¥]\\s?\\d[\\d,]*(?:\\.\\d{2})?|\\d[\\d,]*(?:\\.\\d{2})?\\s?(?:GBP|USD|EUR|JPY|CAD|AUD))';
const TOTAL_PATTERN = new RegExp(`${TOTAL_LABEL}\\s*(?:\\(inc[^)]*\\))?\\s*[:\\-–]?\\s*${AMOUNT}`, 'i');
const REFUND_AMOUNT_PATTERN = new RegExp(`(?:refund(?:ed)?(?:\\s+(?:amount|total|of))?|credited)\\s*[:\\-–]?\\s*${AMOUNT}`, 'i');

// The separator is required, not optional: without it, "your order confirmation" reads
// "confirmation" as the order id. Global, because the first syntactic match is often not the
// first VALID one and giving up after it loses the real reference further down the email.
const ORDER_ID_PATTERN = /\b(?:order|reference|confirmation|invoice|booking)\s*(?:(?:number|no\.?|id|ref(?:erence)?\.?|#)\s*[:#]?\s*|[:#]\s*)([A-Z0-9][A-Z0-9\-_/]{4,24})\b/gi;

// Recurring/subscription language — reported as a signal, never as a separate guessed total.
const SUBSCRIPTION_PATTERN = /\b(subscription|monthly plan|annual plan|auto-?renew(?:al|s|ed)?|recurring (?:payment|charge)|membership (?:fee|renewal)|your plan renews|next billing date)\b/i;

function clean(value, max = 400) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function parseAmount(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const symbol = Object.keys(CURRENCY_SYMBOLS).find(s => text.includes(s));
  const code = CURRENCY_CODES.find(c => new RegExp(`\\b${c}\\b`, 'i').test(text));
  const numeric = Number(text.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const currency = symbol ? CURRENCY_SYMBOLS[symbol] : (code ? code.toUpperCase() : null);
  if (!currency) return null;
  return { amount: Number(numeric.toFixed(2)), currency, raw: text };
}

// Second-level suffixes where "last two labels" is the WRONG registrable domain — without
// these, amazon.co.uk collapses to "co.uk" and every UK merchant is named "Co".
const COMPOUND_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'co.jp', 'co.in', 'com.br', 'com.mx', 'com.sg'
]);

// mail.notifications.nike.com -> nike.com; then Nike as a display name.
function merchantFromSender({ senderAddress = '', senderName = '', from = '' } = {}) {
  const address = String(senderAddress || from || '').toLowerCase();
  const domainMatch = address.match(/@([^\s>]+)/);
  const rawDomain = domainMatch ? domainMatch[1] : '';
  const parts = rawDomain.split('.').filter(Boolean);
  const lastTwo = parts.slice(-2).join('.');
  const keep = COMPOUND_SUFFIXES.has(lastTwo) ? 3 : 2;
  const domain = parts.length > keep ? parts.slice(-keep).join('.') : rawDomain;
  const name = clean(senderName, 80).replace(/\s*\(.*\)$/, '');
  // A sender name like "Nike" or "Amazon.co.uk" is a better merchant label than the domain,
  // but "no-reply" and friends are not names at all.
  const usableName = name && !/^(no-?reply|noreply|donotreply|orders?|receipts?|billing|support|info|notifications?)$/i.test(name);
  const fallback = domain ? domain.split('.')[0] : '';
  const label = usableName ? name : fallback;
  return {
    merchant: label ? label.charAt(0).toUpperCase() + label.slice(1) : 'Unknown merchant',
    domain: domain || null
  };
}

// A receipt is transactional content, not a sender shape: order confirmations routinely come
// from no-reply@ addresses, and marketing routinely comes from a friendly name.
function isReceiptLike(email = {}) {
  const subject = clean(email.subject, 300);
  const body = clean(email.body || email.snippet, 4000);
  const haystack = `${subject} ${body}`;
  if (!RECEIPT_SUBJECT_PATTERN.test(haystack)) return false;
  // Promotional mail that merely mentions "your order" (e.g. "rate your order — 20% off your
  // next one") must not be mined for a total. A labelled total in the same email overrides
  // this only when the promotional wording is absent from the SUBJECT.
  if (PROMOTIONAL_PATTERN.test(subject)) return false;
  return true;
}

function extractItems(body = '') {
  const items = [];
  const lines = String(body || '').split(/\r?\n/);
  for (const line of lines) {
    // Only an unambiguous "2 x Thing …price" shape counts as an item; anything looser starts
    // inventing line items out of prose.
    const match = line.match(/^\s*(\d{1,3})\s*(?:x|×)\s+(.{2,80}?)\s+[£$€]\s?\d/i);
    if (match) items.push({ quantity: Number(match[1]), name: clean(match[2], 80) });
    if (items.length >= 10) break;
  }
  return items;
}

function extractOrderId(text = '') {
  for (const match of String(text).matchAll(ORDER_ID_PATTERN)) {
    const id = match[1].toUpperCase();
    // Reject things that are obviously not identifiers: a bare year, a word with no digits.
    if (/^\d{4}$/.test(id)) continue;
    if (!/\d/.test(id)) continue;
    return id;
  }
  return null;
}

// The whole point of this module. Returns null — not a guess — whenever the evidence for a
// purchase is not actually in the email.
function extractReceipt(email = {}) {
  if (!isReceiptLike(email)) return null;

  const subject = clean(email.subject, 300);
  const body = String(email.body || email.snippet || '');
  const haystack = `${subject}\n${body}`;

  const totalMatch = haystack.match(TOTAL_PATTERN);
  const total = totalMatch ? parseAmount(totalMatch[1]) : null;
  const orderId = extractOrderId(haystack);
  const isRefund = REFUND_PATTERN.test(subject) || REFUND_PATTERN.test(body.slice(0, 800));
  const refundMatch = isRefund ? haystack.match(REFUND_AMOUNT_PATTERN) : null;
  const refund = refundMatch ? parseAmount(refundMatch[1]) : null;

  // Nothing identifying AND nothing charged: this is not a usable record, so it is not one.
  if (!total && !refund && !orderId) return null;

  const { merchant, domain } = merchantFromSender(email);
  const purchasedAt = email.date && !Number.isNaN(Date.parse(email.date))
    ? new Date(email.date).toISOString()
    : new Date().toISOString();

  const trackingMatch = body.match(/https?:\/\/[^\s"'<>]*(?:track|tracking|parcel|delivery)[^\s"'<>]*/i);

  return {
    source: 'email_receipt',
    merchant,
    merchantDomain: domain,
    purchasedAt,
    totalAmount: total ? total.amount : null,
    currency: total ? total.currency : (refund ? refund.currency : null),
    orderId,
    description: subject || null,
    items: extractItems(body),
    status: isRefund ? 'refunded' : 'confirmed',
    refundAmount: refund ? refund.amount : null,
    trackingUrl: trackingMatch ? trackingMatch[0].slice(0, 500) : null,
    sourceRef: email.id || null,
    sourceThreadId: email.threadId || null,
    rawTotalText: totalMatch ? clean(totalMatch[0], 120) : (refundMatch ? clean(refundMatch[0], 120) : null),
    // High only when the amount came from a labelled total AND the document identifies itself
    // with an order reference. Everything else is medium, and callers say so.
    extractionConfidence: (total && orderId) ? 'high' : 'medium',
    recurring: SUBSCRIPTION_PATTERN.test(haystack)
  };
}

// ── Persistence ────────────────────────────────────────────────────────────────────────

// Explicit read-then-write rather than an upsert. Both dedupe indexes on `purchases` are
// PARTIAL (`where source_ref is not null`, `where order_id is not null`), and Postgres will
// not accept a partial index as an ON CONFLICT target from a plain column list — the upsert
// fails outright, which silently loses the record. Called by both the mailbox scan and the
// browser-order recorder so "the same order arriving twice" behaves identically in each.
async function upsertPurchase(supabase, userId, row) {
  const merchant = String(row.merchant || '').trim();
  const findExisting = async () => {
    if (row.source_ref) {
      const { data } = await supabase.from('purchases').select('*')
        .eq('user_id', userId).eq('source_ref', row.source_ref).maybeSingle();
      if (data) return data;
    }
    if (row.order_id && merchant) {
      const { data } = await supabase.from('purchases').select('*')
        .eq('user_id', userId).eq('order_id', row.order_id).ilike('merchant', merchant).maybeSingle();
      if (data) return data;
    }
    return null;
  };

  const existing = await findExisting();
  if (!existing) {
    const { data, error } = await supabase.from('purchases')
      .insert({ ...row, user_id: userId }).select('id').single();
    return error ? { id: null, created: false, error: error.message } : { id: data.id, created: true };
  }

  // A second document about an order already on file (a shipping note, a refund) updates
  // status and fills gaps — it never overwrites a total that was already read from a real
  // labelled line with one from a later, less authoritative email.
  const patch = { updated_at: new Date().toISOString() };
  if (row.status && row.status !== existing.status) patch.status = row.status;
  if (row.refund_amount != null) patch.refund_amount = row.refund_amount;
  if (row.tracking_url && !existing.tracking_url) patch.tracking_url = row.tracking_url;
  if (existing.total_amount == null && row.total_amount != null) {
    patch.total_amount = row.total_amount;
    patch.currency = row.currency;
    patch.raw_total_text = row.raw_total_text;
  }
  if (!existing.order_id && row.order_id) patch.order_id = row.order_id;
  const { error } = await supabase.from('purchases').update(patch).eq('id', existing.id);
  return { id: existing.id, created: false, error: error?.message };
}

// ── Aggregation ────────────────────────────────────────────────────────────────────────

// Currencies are never converted. Mixing them into one number would be exactly the kind of
// invented precision this feature is supposed to avoid.
function summarizeSpend(purchases = []) {
  const byCurrency = new Map();
  let unpriced = 0;
  let refunded = 0;

  for (const purchase of purchases) {
    if (purchase.status === 'refunded') refunded += 1;
    const amount = Number(purchase.total_amount ?? purchase.totalAmount);
    const currency = purchase.currency;
    if (!Number.isFinite(amount) || !currency) { unpriced += 1; continue; }
    // A refunded order should not inflate what was actually spent.
    const net = purchase.status === 'refunded'
      ? Math.max(0, amount - Number(purchase.refund_amount ?? purchase.refundAmount ?? amount))
      : amount;
    const entry = byCurrency.get(currency) || { currency, total: 0, count: 0 };
    entry.total = Number((entry.total + net).toFixed(2));
    entry.count += 1;
    byCurrency.set(currency, entry);
  }

  return {
    totals: [...byCurrency.values()].sort((a, b) => b.total - a.total),
    counted: purchases.length - unpriced,
    unpriced,
    refunded
  };
}

function formatMoney(amount, currency) {
  const symbol = Object.entries(CURRENCY_SYMBOLS).find(([, code]) => code === currency)?.[0];
  const value = Number(amount).toFixed(2);
  return symbol ? `${symbol}${value}` : `${value} ${currency}`;
}

// A handful of merchants map to a category with real confidence. Everything else is honestly
// unknown — a category question about an unmapped merchant says so rather than guessing.
const MERCHANT_CATEGORIES = {
  clothes: ['asos', 'zara', 'uniqlo', 'nike', 'adidas', 'h&m', 'next', 'primark', 'shein', 'jd sports', 'sports direct'],
  groceries: ['tesco', 'sainsbury', 'asda', 'aldi', 'lidl', 'waitrose', 'ocado', 'morrisons', 'co-op'],
  tech: ['apple', 'currys', 'dell', 'samsung', 'lenovo', 'logitech', 'anker'],
  food: ['deliveroo', 'uber eats', 'just eat', 'domino', 'mcdonald'],
  travel: ['ryanair', 'easyjet', 'british airways', 'trainline', 'booking.com', 'airbnb', 'expedia'],
  subscriptions: ['netflix', 'spotify', 'openai', 'anthropic', 'adobe', 'github', 'dropbox', 'icloud']
};

function classifyCategory(merchant = '', description = '') {
  const haystack = `${merchant} ${description}`.toLowerCase();
  for (const [category, needles] of Object.entries(MERCHANT_CATEGORIES)) {
    if (needles.some(needle => haystack.includes(needle))) return { category, confident: true };
  }
  return { category: null, confident: false };
}

// The honest sentence. Names the sources actually searched, and always states what a
// receipts-and-Millie-orders view cannot see.
function formatSpendSummary(purchases = [], {
  since = '', merchant = '', sources = ['email_receipt', 'millie_browser'],
  emailSearched = true, emailError = '', unclassified = 0, categoryQuery = ''
} = {}) {
  const summary = summarizeSpend(purchases);
  const scope = merchant ? ` at ${merchant}` : '';
  const window = since ? ` since ${since}` : '';

  if (!purchases.length) {
    const why = !emailSearched
      ? ` I could not search your email${emailError ? ` (${emailError})` : ''}, so this only covers orders placed through me.`
      : '';
    return `I found no receipts or orders${scope}${window}.${why}`;
  }

  const amounts = summary.totals.map(t => formatMoney(t.total, t.currency)).join(' + ');
  const parts = [`${amounts || 'no priced records'} across ${purchases.length} record${purchases.length === 1 ? '' : 's'}${scope}${window}`];

  const millieCount = purchases.filter(p => p.source === 'millie_browser').length;
  const emailCount = purchases.length - millieCount;
  const sourceBits = [];
  if (emailCount) sourceBits.push(`${emailCount} from receipts in your connected email`);
  if (millieCount) sourceBits.push(`${millieCount} ordered through me`);
  if (sourceBits.length) parts.push(sourceBits.join(', '));

  if (summary.unpriced) parts.push(`${summary.unpriced} record${summary.unpriced === 1 ? ' had' : 's had'} no reliably-stated total, so ${summary.unpriced === 1 ? 'it is' : 'they are'} not in that figure`);
  if (summary.refunded) parts.push(`${summary.refunded} refunded, netted off`);
  if (summary.totals.length > 1) parts.push('different currencies are kept separate — I have not converted them');
  if (categoryQuery && unclassified) parts.push(`${unclassified} could not be confidently classified as ${categoryQuery}, so ${unclassified === 1 ? 'it is' : 'they are'} excluded`);

  // The caveat that keeps the whole number honest. Which one applies depends on what was
  // actually in the answer, not on what was asked for: records extracted from email are
  // still email records even when the mailbox could not be re-read on this call, and saying
  // "this covers only orders placed through me" about them would be false.
  const caveat = !emailCount
    ? ' This covers only orders placed through me, not your wider spending.'
    : ' This only covers purchases with an emailed receipt and orders placed through me — there is no bank or card feed connected, so card and cash spending without a receipt email is not included.';
  const staleness = emailCount && !emailSearched
    ? ` I could not re-check your mailbox just now${emailError ? ` (${emailError})` : ''}, so any receipt that arrived since the last scan is missing.`
    : '';

  return `${parts.join('; ')}.${caveat}${staleness}`;
}

function formatPurchaseLine(purchase = {}) {
  const amount = purchase.total_amount ?? purchase.totalAmount;
  const currency = purchase.currency;
  const money = (Number.isFinite(Number(amount)) && currency) ? formatMoney(amount, currency) : 'amount not stated';
  const when = purchase.purchased_at || purchase.purchasedAt;
  const date = when ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(when)) : '';
  const order = purchase.order_id || purchase.orderId;
  const bits = [purchase.merchant, money, date].filter(Boolean);
  if (order) bits.push(`order ${order}`);
  if ((purchase.status || 'confirmed') === 'refunded') bits.push('refunded');
  return bits.join(' — ');
}

module.exports = {
  RECEIPT_SUBJECT_PATTERN,
  isReceiptLike,
  extractReceipt,
  extractOrderId,
  extractItems,
  merchantFromSender,
  parseAmount,
  upsertPurchase,
  summarizeSpend,
  classifyCategory,
  formatMoney,
  formatSpendSummary,
  formatPurchaseLine
};

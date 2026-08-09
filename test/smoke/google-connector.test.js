const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function mockGoogleConnectorDeps(request, parent, isMain) {
  if (request === 'axios') {
    return { get: async () => ({ data: {} }), post: async () => ({ data: {} }) };
  }
  if (request === '../runtime') {
    return {
      createSupabaseServiceClient: () => ({
        from: () => ({
          select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) }),
          upsert: async () => ({ error: null })
        })
      }),
      logMissingRuntimeEnvOnce: () => {}
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const google = require('../../connectors/google');
Module._load = originalLoad;

const {
  decodeBase64Url,
  stripHtml,
  extractMessageBody,
  messageToEmail,
  normalizeLabelFilter,
  calendarWindow,
  calendarTime,
  oneHourLater,
  formatThreadText,
  buildMime
} = google._private;

// ── An absolute instant is not a wall-clock time ───────────────────────────────────────
// Found live: schedule_block computes a real instant and passes start.toISOString(), and the
// connector deleted the trailing Z and relabelled the remaining digits as Europe/London. So
// "book 14:00 tomorrow" wrote 13:00 to the real calendar while the confirmation still said
// 14:00. Correct in winter, an hour out for the whole of BST.
test('a time carrying an offset keeps it and is never relabelled as local', () => {
  // The offset survives, so the INSTANT is whatever the caller meant. timeZone rides along
  // as the event's display zone — without it Google labels the event UTC and the invitation
  // email reads "5pm UTC" to a London guest.
  assert.deepEqual(calendarTime('2026-08-10T13:00:00.000Z', 'Europe/London'),
    { dateTime: '2026-08-10T13:00:00.000Z', timeZone: 'Europe/London' });
  assert.deepEqual(calendarTime('2026-08-10T14:00:00+01:00', 'Europe/London'),
    { dateTime: '2026-08-10T14:00:00+01:00', timeZone: 'Europe/London' });
});

test('a bare wall-clock time is paired with the timezone that explains it', () => {
  assert.deepEqual(calendarTime('2026-08-10T14:00:00', 'Europe/London'),
    { dateTime: '2026-08-10T14:00:00', timeZone: 'Europe/London' });
});

test('a defaulted end hour follows the form the start arrived in', () => {
  // Absolute in, absolute out — an hour after 13:00Z is 14:00Z whatever the zone is doing.
  assert.equal(oneHourLater('2026-08-10T13:00:00.000Z', 'Europe/London').dateTime,
    '2026-08-10T14:00:00.000Z');

  // Wall clock in, wall clock out — "an hour later" on a local clock is the digits plus one.
  const local = oneHourLater('2026-08-10T14:00:00', 'Europe/London');
  assert.equal(local.dateTime, '2026-08-10T15:00:00');
  assert.equal(local.timeZone, 'Europe/London');
});

test('the round trip an hour before a DST-relevant instant does not drift', () => {
  // The whole bug was a silent offset shift, so assert the instant itself, not the string.
  const absolute = calendarTime('2026-08-10T13:00:00.000Z', 'Europe/London');
  assert.equal(new Date(absolute.dateTime).toISOString(), '2026-08-10T13:00:00.000Z');
});

function b64url(text) {
  return Buffer.from(text).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

test('Gmail parser extracts nested text/plain bodies before HTML', () => {
  const body = extractMessageBody({
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/html', body: { data: b64url('<p>Hello <b>html</b></p>') } },
          { mimeType: 'text/plain', body: { data: b64url('Hello plain') } }
        ]
      }
    ]
  });
  assert.equal(body, 'Hello plain');
});

test('Gmail parser strips HTML when no plain body exists', () => {
  assert.equal(stripHtml('<div>Hello&nbsp;<strong>there</strong><br>Next</div>'), 'Hello there\nNext');
  const body = extractMessageBody({
    parts: [{ mimeType: 'text/html', body: { data: b64url('<p>Hello <b>there</b></p>') } }]
  });
  assert.equal(body, 'Hello there');
});

test('Gmail message normalization includes sender, thread and full body', () => {
  const email = messageToEmail({
    id: 'm1',
    threadId: 't1',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'snippet',
    payload: {
      headers: [
        { name: 'From', value: 'Josh Example <josh@example.com>' },
        { name: 'Subject', value: 'Plan' },
        { name: 'Date', value: 'Thu, 28 May 2026 10:00:00 +0100' },
        { name: 'Message-ID', value: '<abc@example.com>' }
      ],
      parts: [{ mimeType: 'text/plain', body: { data: b64url('Full body here') } }]
    }
  });
  assert.equal(email.threadId, 't1');
  assert.equal(email.senderName, 'Josh Example');
  assert.equal(email.senderAddress, 'josh@example.com');
  assert.equal(email.body, 'Full body here');
  assert.deepEqual(email.labelIds, ['INBOX', 'UNREAD']);
});

test('Gmail label filters default to INBOX and accept label arrays', () => {
  assert.deepEqual(normalizeLabelFilter({}), ['INBOX']);
  assert.deepEqual(normalizeLabelFilter({ label: 'unread' }), ['UNREAD']);
  assert.deepEqual(normalizeLabelFilter({ labels: ['inbox', 'important'] }), ['INBOX', 'IMPORTANT']);
});

test('Calendar tomorrow queries are bounded at the API request boundary', () => {
  const window = calendarWindow({ when: 'tomorrow' });
  assert.match(window.timeMin, /^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
  assert.match(window.timeMax, /^\d{4}-\d{2}-\d{2}T23:59:59Z$/);
  assert.ok(window.ymd);
  assert.notEqual(window.timeMin.slice(0, 10), window.ymd);
});

test('Gmail replies include threading headers in raw MIME', () => {
  const raw = buildMime('josh@example.com', 'Re: Plan', 'Sounds good.', {
    inReplyTo: '<abc@example.com>',
    references: '<abc@example.com>'
  });
  const decoded = decodeBase64Url(raw);
  assert.match(decoded, /In-Reply-To: <abc@example.com>/);
  assert.match(decoded, /References: <abc@example.com>/);
  assert.match(decoded, /Sounds good\./);
});

test('Gmail thread context includes every message body', () => {
  const text = formatThreadText([
    { from: 'A <a@example.com>', subject: 'One', date: 'today', body: 'First body' },
    { from: 'B <b@example.com>', subject: 'One', date: 'later', body: 'Second body' }
  ]);
  assert.match(text, /First body/);
  assert.match(text, /Second body/);
});

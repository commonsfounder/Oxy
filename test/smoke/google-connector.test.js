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
  formatThreadText,
  buildMime
} = google._private;

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

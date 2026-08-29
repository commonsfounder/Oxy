// The Gmail mutation primitives for inbox cleanup, tested against a fake mailbox that implements
// real API semantics — batchModify changes labelIds, a re-fetch reflects it, one-click POSTs go
// to the configured URL — so this proves the mutation and verification logic, not just that a
// call was made.
//
// A fake is only as good as its fidelity: it rejects unknown label ids the way Gmail does, since
// Gmail only accepts opaque ids (Label_1) for user labels and a lenient fake passes a name that
// fails every time live.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function b64url(text) {
  return Buffer.from(text).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Fake mailbox: id -> Gmail message resource shape ───────────────────────────────────────
let mailbox;
let sentEmails;
let oneClickLog;
let failChunksContaining; // Set of ids — any batchModify chunk containing one of these throws
let userLabels;          // The account's own labels, as Gmail reports them: opaque ids + display names

function resetFakeMailbox() {
  mailbox = new Map();
  sentEmails = [];
  oneClickLog = [];
  failChunksContaining = new Set();
  userLabels = [{ id: 'Label_1', name: 'Receipts' }];
}

function seedMessage(id, { labelIds = ['INBOX'], headers = [], snippet = '', threadId = null } = {}) {
  mailbox.set(id, {
    id,
    threadId: threadId || `thread-${id}`,
    labelIds: [...labelIds],
    snippet,
    payload: { headers, parts: [] }
  });
}

const mockAxios = {
  async get(url, config) {
    if (url.endsWith('/users/me/labels')) return { data: { labels: userLabels } };
    const match = url.match(/\/messages\/([^/?]+)$/);
    if (match) {
      const msg = mailbox.get(match[1]);
      if (!msg) {
        const err = new Error('Not Found');
        err.response = { status: 404, data: { error: { message: 'Requested entity was not found.' } } };
        throw err;
      }
      // Real Gmail returns a fresh copy each time — deep-enough clone so callers can't
      // mutate the fake mailbox by mutating the returned object.
      return { data: { ...msg, labelIds: [...msg.labelIds], payload: { ...msg.payload, headers: [...msg.payload.headers] } } };
    }
    throw new Error(`mockAxios.get: unhandled URL ${url}`);
  },
  async post(url, body, config) {
    if (url.endsWith('/users/me/labels')) {
      const created = { id: `Label_${userLabels.length + 1}`, name: body.name };
      userLabels.push(created);
      return { data: created };
    }
    if (url.endsWith('/messages/batchModify')) {
      const { ids = [], addLabelIds = [], removeLabelIds = [] } = body;
      // Real Gmail rejects the whole call if any labelId does not exist — which is exactly
      // what a display name like "RECEIPTS" is. Without this the fake would happily accept
      // names and the bug under test would be invisible.
      const known = new Set([...userLabels.map(l => l.id),
        'INBOX', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT',
        'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS']);
      const bad = [...addLabelIds, ...removeLabelIds].find(l => !known.has(l));
      if (bad) {
        const err = new Error('Invalid label');
        err.response = { status: 400, data: { error: { message: `Invalid label: ${bad}` } } };
        throw err;
      }
      if (ids.some(id => failChunksContaining.has(id))) {
        const err = new Error('Simulated batchModify failure');
        err.response = { status: 500, data: { error: { message: 'Simulated failure' } } };
        throw err;
      }
      for (const id of ids) {
        const msg = mailbox.get(id);
        if (!msg) continue;
        const set = new Set(msg.labelIds);
        for (const l of removeLabelIds) set.delete(l);
        for (const l of addLabelIds) set.add(l);
        msg.labelIds = [...set];
      }
      return { status: 204, data: '' };
    }
    if (url.endsWith('/messages/send')) {
      sentEmails.push({ url, raw: body.raw });
      return { data: { id: `sent-${sentEmails.length}` } };
    }
    // One-click unsubscribe: an arbitrary provider URL, not a gmail.googleapis.com path.
    oneClickLog.push({ url, body, contentType: config?.headers?.['Content-Type'] });
    if (url.includes('/one-click-fails')) {
      return { status: 500, data: 'error' };
    }
    return { status: 200, data: 'ok' };
  }
};

const originalLoad = Module._load;
Module._load = function mockGoogleConnectorDeps(request, parent, isMain) {
  if (request === 'axios') return mockAxios;
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

// getAccessToken -> getTokens falls back to env vars when the DB has nothing (mocked to
// empty above). Set the minimal env so execute() reaches the switch statement in every test.
process.env.GMAIL_REFRESH_TOKEN = 'test-refresh-token';
process.env.GMAIL_CLIENT_ID = 'test-client-id';
process.env.GMAIL_CLIENT_SECRET = 'test-client-secret';
// getAccessToken also always tries a real refresh POST first (no cached access_token) —
// route it through the same mock, which returns {status:200,data:'ok'} for unrecognised
// POSTs. That lacks access_token/expires_in, so patch getAccessToken's refresh response
// shape by special-casing the oauth2 URL.
const realPost = mockAxios.post;
mockAxios.post = async (url, body, config) => {
  if (url === 'https://oauth2.googleapis.com/token') {
    return { data: { access_token: 'fake-access-token', expires_in: 3600 } };
  }
  return realPost(url, body, config);
};

test.beforeEach(() => resetFakeMailbox());

// ── archive_emails ──────────────────────────────────────────────────────────────────────
test('archive_emails removes INBOX from real messages and verifies the state actually changed', async () => {
  seedMessage('m1', { labelIds: ['INBOX', 'UNREAD'] });
  seedMessage('m2', { labelIds: ['INBOX'] });
  const result = await google.execute('user-1', 'archive_emails', { message_ids: ['m1', 'm2'] });
  assert.equal(result.success, true);
  assert.equal(result.modified, 2);
  assert.equal(result.verified.checked, 2);
  assert.equal(result.verified.confirmed, 2, 'the re-fetch after archiving must show INBOX actually gone');
  // Ground truth: the fake mailbox itself, not just the tool's own report.
  assert.ok(!mailbox.get('m1').labelIds.includes('INBOX'));
  assert.ok(!mailbox.get('m2').labelIds.includes('INBOX'));
});

test('archive_emails reports a real partial failure instead of claiming full success', async () => {
  seedMessage('good1', { labelIds: ['INBOX'] });
  seedMessage('bad1', { labelIds: ['INBOX'] });
  // Force the chunk containing 'bad1' to fail. Both ids are in the same (only) chunk here,
  // so this proves per-chunk failure is reported honestly, not silently swallowed.
  failChunksContaining.add('bad1');
  const result = await google.execute('user-1', 'archive_emails', { message_ids: ['good1', 'bad1'] });
  assert.equal(result.modified, 0, 'the whole chunk containing the bad id must not be reported as modified');
  assert.deepEqual(result.failed, ['good1', 'bad1']);
  assert.ok(mailbox.get('good1').labelIds.includes('INBOX'), 'ground truth: nothing actually changed in the failed chunk');
});

test('archive_emails chunks large batches under the per-call cap and still verifies real state', async () => {
  const ids = Array.from({ length: 260 }, (_, i) => `bulk-${i}`);
  for (const id of ids) seedMessage(id, { labelIds: ['INBOX'] });
  const result = await google.execute('user-1', 'archive_emails', { message_ids: ids });
  assert.equal(result.modified, 260, 'must span more than one 250-sized chunk and still report the true total');
  assert.equal(ids.every(id => !mailbox.get(id).labelIds.includes('INBOX')), true, 'ground truth: every real message actually lost INBOX, not just the sampled ones');
});

test('archive_emails requires message_ids', async () => {
  const result = await google.execute('user-1', 'archive_emails', {});
  assert.equal(result.success, false);
  assert.match(result.error, /message_ids/);
});

// ── label_emails (also mark read/unread) ───────────────────────────────────────────────
test('label_emails marks a message read by removing UNREAD, verified against real state', async () => {
  seedMessage('m1', { labelIds: ['INBOX', 'UNREAD'] });
  const result = await google.execute('user-1', 'label_emails', { message_ids: ['m1'], remove_labels: ['UNREAD'] });
  assert.equal(result.success, true);
  assert.equal(result.verified.confirmed, 1);
  assert.ok(!mailbox.get('m1').labelIds.includes('UNREAD'));
  assert.ok(mailbox.get('m1').labelIds.includes('INBOX'), 'marking read must not also archive it');
});

// Gmail's own labels are their own ids; every label the USER made is an opaque id like
// Label_1, and the display name is rejected wherever a labelId is expected. This was found
// against the real account: "label this Adam Test" failed 100% of the time while INBOX
// worked, because every name was simply uppercased and passed through as an id.
test('label_emails resolves a custom label name to its real Gmail id', async () => {
  seedMessage('m1', { labelIds: ['INBOX'] });
  const result = await google.execute('user-1', 'label_emails', { message_ids: ['m1'], add_labels: ['Receipts'] });
  assert.equal(result.success, true);
  assert.deepEqual(new Set(mailbox.get('m1').labelIds), new Set(['INBOX', 'Label_1']));
  assert.deepEqual(result.created, [], 'a label that already exists is not recreated');
});

test('label_emails matches an existing label regardless of the casing asked for', async () => {
  seedMessage('m1', { labelIds: ['INBOX'] });
  const result = await google.execute('user-1', 'label_emails', { message_ids: ['m1'], add_labels: ['receipts'] });
  assert.equal(result.success, true);
  assert.ok(mailbox.get('m1').labelIds.includes('Label_1'));
  assert.equal(userLabels.length, 1, 'a casing difference must not manufacture a second label');
});

test('filing mail under a label that does not exist yet creates it', async () => {
  seedMessage('m1', { labelIds: ['INBOX'] });
  const result = await google.execute('user-1', 'label_emails', { message_ids: ['m1'], add_labels: ['Travel'] });
  assert.equal(result.success, true);
  assert.deepEqual(result.created, ['Travel']);
  const made = userLabels.find(l => l.name === 'Travel');
  assert.ok(made && mailbox.get('m1').labelIds.includes(made.id));
});

test('REMOVING a label that does not exist is refused, not quietly created', async () => {
  // The asymmetry is deliberate: "file this under Travel" means make Travel if needed;
  // "take Travel off this" cannot sensibly mean "first create Travel".
  seedMessage('m1', { labelIds: ['INBOX'] });
  const result = await google.execute('user-1', 'label_emails', { message_ids: ['m1'], remove_labels: ['Nonexistent'] });
  assert.equal(result.success, false);
  assert.match(result.error, /No such label: Nonexistent/);
  assert.equal(userLabels.some(l => l.name === 'Nonexistent'), false);
});

test('system labels still pass straight through', async () => {
  seedMessage('m1', { labelIds: ['INBOX', 'UNREAD'] });
  const result = await google.execute('user-1', 'label_emails', { message_ids: ['m1'], remove_labels: ['unread'] });
  assert.equal(result.success, true);
  assert.equal(mailbox.get('m1').labelIds.includes('UNREAD'), false);
});

test('SENT and DRAFT are refused rather than sent to Gmail to be rejected', async () => {
  seedMessage('m1', { labelIds: ['INBOX'] });
  const result = await google.execute('user-1', 'label_emails', { message_ids: ['m1'], add_labels: ['SENT'] });
  assert.equal(result.success, false);
  assert.match(result.error, /where the message came from/);
});

test('a label that could not be resolved is named in the result, not swallowed', async () => {
  seedMessage('m1', { labelIds: ['INBOX'] });
  const result = await google.execute('user-1', 'label_emails', {
    message_ids: ['m1'], add_labels: ['Receipts'], remove_labels: ['Nonexistent']
  });
  assert.equal(result.success, true, 'the part that could be done was done');
  assert.deepEqual(result.skippedLabels, ['Nonexistent']);
  assert.match(result.text, /Could not apply: Nonexistent/);
});

// ── unsubscribe_email: tiered, verified terminal state ─────────────────────────────────
test('unsubscribe_email uses real RFC 8058 one-click when the provider declares support, and confirms via the actual HTTP response', async () => {
  seedMessage('promo1', {
    headers: [
      { name: 'From', value: 'Temu <deals@temu.com>' },
      { name: 'List-Unsubscribe', value: '<https://temu.com/unsub?u=abc>' },
      { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' }
    ]
  });
  const result = await google.execute('user-1', 'unsubscribe_email', { message_id: 'promo1' });
  assert.equal(result.success, true);
  assert.equal(result.method, 'one-click');
  assert.equal(oneClickLog.length, 1);
  assert.equal(oneClickLog[0].url, 'https://temu.com/unsub?u=abc');
  assert.equal(oneClickLog[0].body, 'List-Unsubscribe=One-Click', 'must send the exact RFC 8058 body, not just hit the URL');
});

test('unsubscribe_email reports the real failure when the provider endpoint itself errors — never claims success for a failed call', async () => {
  seedMessage('promo2', {
    headers: [
      { name: 'From', value: 'Newsletter <news@example.com>' },
      { name: 'List-Unsubscribe', value: '<https://example.com/one-click-fails>' },
      { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' }
    ]
  });
  const result = await google.execute('user-1', 'unsubscribe_email', { message_id: 'promo2' });
  assert.equal(result.success, false);
  assert.match(result.error, /500/);
});

test('unsubscribe_email sends a real email for a mailto: List-Unsubscribe with no one-click support', async () => {
  seedMessage('promo3', {
    headers: [
      { name: 'From', value: 'Digest <digest@example.com>' },
      { name: 'List-Unsubscribe', value: '<mailto:unsub@example.com?subject=unsubscribe>' }
    ]
  });
  const result = await google.execute('user-1', 'unsubscribe_email', { message_id: 'promo3' });
  assert.equal(result.success, true);
  assert.equal(result.method, 'mailto');
  assert.equal(sentEmails.length, 1, 'a real send_email-shaped Gmail API call must have happened');
});

test('unsubscribe_email defers to run_browser_task (needsBrowser) rather than faking success for a plain link with no one-click support', async () => {
  seedMessage('promo4', {
    headers: [
      { name: 'From', value: 'Retailer <sale@example.com>' },
      { name: 'List-Unsubscribe', value: '<https://example.com/manage-preferences>' }
      // no List-Unsubscribe-Post: One-Click declared
    ]
  });
  const result = await google.execute('user-1', 'unsubscribe_email', { message_id: 'promo4' });
  assert.equal(result.success, false);
  assert.equal(result.needsBrowser, true);
  assert.equal(result.url, 'https://example.com/manage-preferences');
  assert.equal(oneClickLog.length, 0, 'must not have attempted a POST to a link with no declared one-click support');
});

test('unsubscribe_email falls back to a body-embedded link when there is no List-Unsubscribe header at all', async () => {
  seedMessage('promo5', {
    headers: [{ name: 'From', value: 'Old School <mail@example.com>' }]
  });
  // extractLinksFromHtml reads raw HTML parts — add one with an unsubscribe-labeled link.
  const html = '<html><body><p>Hi</p><a href="https://example.com/u/xyz">Unsubscribe here</a></body></html>';
  mailbox.get('promo5').payload.parts = [{ mimeType: 'text/html', body: { data: b64url(html) } }];
  const result = await google.execute('user-1', 'unsubscribe_email', { message_id: 'promo5' });
  assert.equal(result.success, false);
  assert.equal(result.needsBrowser, true);
  assert.equal(result.url, 'https://example.com/u/xyz');
});

test('unsubscribe_email is honest when there is truly no unsubscribe mechanism anywhere', async () => {
  seedMessage('personal1', {
    headers: [{ name: 'From', value: 'Sam <sam@example.com>' }]
  });
  const result = await google.execute('user-1', 'unsubscribe_email', { message_id: 'personal1' });
  assert.equal(result.success, false);
  assert.equal(result.needsBrowser, undefined);
  assert.match(result.error, /No unsubscribe mechanism found/);
});

test('unsubscribe_email requires message_id', async () => {
  const result = await google.execute('user-1', 'unsubscribe_email', {});
  assert.equal(result.success, false);
  assert.match(result.error, /message_id/);
});

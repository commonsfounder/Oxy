const assert = require('node:assert/strict');
const test = require('node:test');

process.env.OXY_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);

const { storeDocument } = require('../../api/services/documents');
const {
  resolveAttachmentsForSend, ingestEmailAttachments, attachmentBytes, MAX_ATTACHMENTS_PER_SEND
} = require('../../api/services/document-attachments');

function fakeSupabase() {
  const state = { documents: [], document_representations: [], blobs: new Map() };
  let idSeq = 0;
  function table(name) {
    const q = { _filters: [], _limit: null };
    q.select = () => q;
    q.eq = (f, v) => { q._filters.push([f, v]); return q; };
    q.order = () => q;
    q.limit = (n) => { q._limit = n; return q; };
    const rows = () => {
      const out = state[name].filter(r => q._filters.every(([f, v]) => r[f] === v));
      return q._limit ? out.slice(0, q._limit) : out;
    };
    q.single = async () => ({ data: rows()[0] || null, error: null });
    q.insert = (row) => {
      const withId = { id: `doc-${++idSeq}`, version: 1, created_at: new Date().toISOString(), ...row };
      state[name].push(withId);
      return { select: () => ({ single: async () => ({ data: withId, error: null }) }) };
    };
    q.update = () => ({ eq: () => ({ then: (res) => res({ data: [], error: null }) }) });
    q.then = (res) => res({ data: rows(), error: null });
    return q;
  }
  const storage = {
    from: (bucket) => ({
      upload: async (path, body) => { state.blobs.set(`${bucket}/${path}`, Buffer.from(body)); return { data: { path }, error: null }; },
      download: async (path) => {
        const buf = state.blobs.get(`${bucket}/${path}`);
        return buf ? { data: { arrayBuffer: async () => buf }, error: null } : { data: null, error: { message: 'not found' } };
      },
      remove: async () => ({ data: null, error: null })
    })
  };
  return { from: table, storage, _state: state };
}

const CV = Buffer.from('cv bytes');
const PASSPORT = Buffer.from('passport bytes');

async function seed(supabase, overrides = {}) {
  const { document } = await storeDocument(supabase, 'chizi', {
    filename: 'cv.pdf', mimeType: 'application/pdf', bytes: CV, source: 'upload', ...overrides
  });
  return document;
}

test('resolveAttachmentsForSend turns explicit ids into base64 attachments', async () => {
  const supabase = fakeSupabase();
  const cv = await seed(supabase);
  const { attachments, documents } = await resolveAttachmentsForSend(supabase, 'chizi', { documentIds: [cv.id] });
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].filename, 'cv.pdf');
  assert.equal(Buffer.from(attachments[0].content, 'base64').toString(), 'cv bytes');
  assert.equal(documents[0].id, cv.id);
});

test('there is no filename-matching path at all — attachments are ids only', () => {
  // The passport bug is prevented structurally, not by a check that could be bypassed:
  // this module exposes no way to ask for a document by name.
  const api = require('../../api/services/document-attachments');
  const names = Object.keys(api).join(' ').toLowerCase();
  assert.ok(!/byname|byfilename|search|match|find/.test(names),
    'exposing any name-based lookup here would reintroduce the wrong-document risk');
});

test('a document bound to another workflow is refused, naming the file', async () => {
  const supabase = fakeSupabase();
  const passport = await storeDocument(supabase, 'chizi', {
    filename: 'passport.pdf', mimeType: 'application/pdf', bytes: PASSPORT,
    source: 'upload', agentTaskId: 'task-visa'
  });

  await assert.rejects(
    () => resolveAttachmentsForSend(supabase, 'chizi', {
      documentIds: [passport.document.id], requestTaskId: 'task-insurance'
    }),
    /passport\.pdf.*different piece of work/is
  );
});

test('cross-workflow attachment is possible, but only when asked for explicitly', async () => {
  const supabase = fakeSupabase();
  const passport = await storeDocument(supabase, 'chizi', {
    filename: 'passport.pdf', mimeType: 'application/pdf', bytes: PASSPORT,
    source: 'upload', agentTaskId: 'task-visa'
  });
  const { attachments } = await resolveAttachmentsForSend(supabase, 'chizi', {
    documentIds: [passport.document.id], requestTaskId: 'task-insurance', allowCrossWorkflow: true
  });
  assert.equal(attachments.length, 1);
});

test('an unattached document rides along on any workflow without complaint', async () => {
  const supabase = fakeSupabase();
  const cv = await seed(supabase); // no agent_task_id
  const { attachments } = await resolveAttachmentsForSend(supabase, 'chizi', {
    documentIds: [cv.id], requestTaskId: 'task-anything'
  });
  assert.equal(attachments.length, 1);
});

test('another user\'s document cannot be attached', async () => {
  const supabase = fakeSupabase();
  const cv = await seed(supabase);
  await assert.rejects(
    () => resolveAttachmentsForSend(supabase, 'someone-else', { documentIds: [cv.id] }),
    /not found/i
  );
});

test('no ids means no attachments, not an error', async () => {
  const supabase = fakeSupabase();
  const { attachments } = await resolveAttachmentsForSend(supabase, 'chizi', { documentIds: [] });
  assert.deepEqual(attachments, []);
});

test('duplicate ids in one request attach the file once', async () => {
  const supabase = fakeSupabase();
  const cv = await seed(supabase);
  const { attachments } = await resolveAttachmentsForSend(supabase, 'chizi', { documentIds: [cv.id, cv.id, cv.id] });
  assert.equal(attachments.length, 1);
});

test('too many attachments is refused before any bytes are read', async () => {
  const supabase = fakeSupabase();
  const ids = Array.from({ length: MAX_ATTACHMENTS_PER_SEND + 1 }, (_, i) => `doc-${i}`);
  await assert.rejects(() => resolveAttachmentsForSend(supabase, 'chizi', { documentIds: ids }), /separate messages/i);
});

// ── Inbound ────────────────────────────────────────────────────────────────────────────

test('ingestEmailAttachments stores each file with where it came from', async () => {
  const supabase = fakeSupabase();
  const stored = await ingestEmailAttachments(supabase, 'chizi', [
    { filename: 'policy.pdf', contentType: 'application/pdf', content: Buffer.from('policy').toString('base64') }
  ], { conversationId: 'conv-1', participantId: 'p-1', providerMessageId: 'msg-9' });

  assert.equal(stored.length, 1);
  assert.equal(stored[0].document.source, 'email_attachment');
  assert.equal(stored[0].document.source_ref, 'msg-9');
  assert.equal(stored[0].document.conversation_id, 'conv-1');
  assert.equal(stored[0].document.participant_id, 'p-1');
});

test('the same attachment quoted across a thread becomes one document, not five', async () => {
  const supabase = fakeSupabase();
  const same = { filename: 'policy.pdf', contentType: 'application/pdf', content: Buffer.from('policy').toString('base64') };
  await ingestEmailAttachments(supabase, 'chizi', [same], { providerMessageId: 'msg-1' });
  const second = await ingestEmailAttachments(supabase, 'chizi', [same], { providerMessageId: 'msg-2' });

  assert.equal(second[0].deduped, true);
  assert.equal(supabase._state.documents.length, 1);
});

test('one bad attachment does not lose the others', async () => {
  const supabase = fakeSupabase();
  const stored = await ingestEmailAttachments(supabase, 'chizi', [
    { filename: 'empty.pdf', content: '' },
    { filename: 'good.pdf', contentType: 'application/pdf', content: Buffer.from('good').toString('base64') }
  ], {});
  assert.equal(stored.length, 1);
  assert.equal(stored[0].document.filename, 'good.pdf');
});

test('attachmentBytes accepts the shapes a provider may actually send', () => {
  assert.equal(attachmentBytes({ content: Buffer.from('a') }).toString(), 'a');
  assert.equal(attachmentBytes({ content: Buffer.from('b').toString('base64') }).toString(), 'b');
  assert.equal(attachmentBytes({ contentBase64: Buffer.from('c').toString('base64') }).toString(), 'c');
  assert.equal(attachmentBytes({ content: { data: [100, 101] } }).toString(), 'de');
  assert.equal(attachmentBytes({}), null);
});

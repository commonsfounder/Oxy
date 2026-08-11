const assert = require('node:assert/strict');
const test = require('node:test');

process.env.OXY_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);

const { storeDocument } = require('../../api/services/documents');
const {
  captureDownload, uploadDocument, resolveDocumentForUpload, safeSuggestedFilename, guessMimeType
} = require('../../api/services/browser-documents');

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

// A page double that fires a download only when the trigger actually runs — so a test that
// forgets to click gets a timeout, exactly as the real one would.
function fakePage({ suggestedFilename = 'application-form.pdf', bytes = Buffer.from('%PDF form'), failure = null, fires = true } = {}) {
  let resolveDownload;
  const armed = [];
  return {
    url: () => 'https://jobs.example/apply',
    waitForEvent: (event) => {
      assert.equal(event, 'download');
      armed.push(Date.now());
      return new Promise((resolve, reject) => {
        resolveDownload = resolve;
        if (!fires) setTimeout(() => reject(new Error('timeout')), 5);
      });
    },
    _fire: () => resolveDownload?.({
      suggestedFilename: () => suggestedFilename,
      failure: async () => failure,
      createReadStream: async () => (async function* () { yield bytes; })()
    }),
    _armedCount: () => armed.length
  };
}

test('captureDownload arms the listener before the click, then stores the file with its origin', async () => {
  const supabase = fakeSupabase();
  const page = fakePage();
  let armedWhenClicked = null;

  const result = await captureDownload(page, async () => {
    // If the listener were armed after the click, a fast server would already have
    // finished and the event would be missed entirely.
    armedWhenClicked = page._armedCount();
    page._fire();
  }, { supabase, userId: 'chizi', agentTaskId: 'task-apply', workflowId: 'wf-apply', label: 'Application form' });

  assert.equal(armedWhenClicked, 1, 'the download listener must be armed before the trigger runs');
  assert.equal(result.ok, true);
  assert.equal(result.document.filename, 'application-form.pdf');
  assert.equal(result.document.mime_type, 'application/pdf');
  assert.equal(result.document.source, 'browser_download');
  // Provenance: months later we can still say which page produced this.
  assert.equal(result.document.source_ref, 'https://jobs.example/apply');
  // And it belongs to the application, not a general pile. This is the gap the pre-Pass-2
  // audit found: before workflows existed every browser download landed unattached, which
  // left the cross-workflow upload guard with nothing to guard on.
  assert.equal(result.document.agent_task_id, 'task-apply');
  assert.equal(result.document.workflow_id, 'wf-apply');
});

test('a click that starts no download is a soft outcome, not a thrown error', async () => {
  const supabase = fakeSupabase();
  const page = fakePage({ fires: false });
  const result = await captureDownload(page, async () => {}, { supabase, userId: 'chizi', timeoutMs: 10 });
  assert.equal(result.ok, false);
  assert.match(result.notes, /no file download/i);
  assert.equal(supabase._state.documents.length, 0);
});

test('a failed or empty download stores nothing', async () => {
  const supabase = fakeSupabase();
  const failed = await captureDownload(fakePage({ failure: 'net::ERR_ABORTED' }), async function () { this?.(); }, { supabase, userId: 'chizi' })
    .catch(() => ({ ok: false }));
  assert.equal(failed.ok, false);

  const emptyPage = fakePage({ bytes: Buffer.alloc(0) });
  const empty = await captureDownload(emptyPage, async () => emptyPage._fire(), { supabase, userId: 'chizi' });
  assert.equal(empty.ok, false);
  assert.match(empty.notes, /empty/i);
  assert.equal(supabase._state.documents.length, 0);
});

test('a server-suggested filename cannot escape its directory or smuggle newlines', () => {
  assert.equal(safeSuggestedFilename('../../etc/passwd'), 'passwd');
  assert.equal(safeSuggestedFilename('bad\nname.pdf'), 'badname.pdf');
  assert.equal(safeSuggestedFilename(''), 'download');
  assert.equal(safeSuggestedFilename('x'.repeat(500)).length, 200);
});

test('guessMimeType covers the formats that actually turn up in paperwork', () => {
  assert.equal(guessMimeType('form.pdf'), 'application/pdf');
  assert.equal(guessMimeType('cv.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(guessMimeType('scan.JPG'), 'image/jpeg');
  assert.equal(guessMimeType('mystery.qqq'), 'application/octet-stream');
});

// ── Upload ─────────────────────────────────────────────────────────────────────────────

function fakeFileInput() {
  const calls = [];
  return { calls, setInputFiles: async (spec) => { calls.push(spec); } };
}

test('uploadDocument puts the stored bytes straight into the file input, with no temp file', async () => {
  const supabase = fakeSupabase();
  const { document } = await storeDocument(supabase, 'chizi', {
    filename: 'cv.pdf', mimeType: 'application/pdf', bytes: Buffer.from('cv bytes'), source: 'upload'
  });
  const input = fakeFileInput();

  const result = await uploadDocument(input, supabase, 'chizi', { documentId: document.id });

  assert.equal(result.ok, true);
  assert.equal(input.calls.length, 1);
  assert.equal(input.calls[0].name, 'cv.pdf');
  assert.equal(input.calls[0].mimeType, 'application/pdf');
  // A buffer, not a path — a temp file would be one more place a passport scan exists.
  assert.ok(Buffer.isBuffer(input.calls[0].buffer));
  assert.equal(input.calls[0].buffer.toString(), 'cv bytes');
});

test('uploading a document from a different workflow is refused by name', async () => {
  const supabase = fakeSupabase();
  const { document } = await storeDocument(supabase, 'chizi', {
    filename: 'passport.pdf', mimeType: 'application/pdf', bytes: Buffer.from('p'),
    source: 'upload', agentTaskId: 'task-visa'
  });
  await assert.rejects(
    () => uploadDocument(fakeFileInput(), supabase, 'chizi', { documentId: document.id, agentTaskId: 'task-job' }),
    /passport\.pdf.*different piece of work/is
  );
});

test('uploads must name a document id — there is no filename path', async () => {
  const supabase = fakeSupabase();
  await assert.rejects(
    () => resolveDocumentForUpload(supabase, 'chizi', { documentId: null }),
    /by id, not by name/i
  );
});

test('another user\'s document cannot be uploaded', async () => {
  const supabase = fakeSupabase();
  const { document } = await storeDocument(supabase, 'chizi', {
    filename: 'cv.pdf', mimeType: 'application/pdf', bytes: Buffer.from('cv'), source: 'upload'
  });
  await assert.rejects(
    () => uploadDocument(fakeFileInput(), supabase, 'someone-else', { documentId: document.id }),
    /not found/i
  );
});

test('a document from one responsibility cannot be uploaded into another', async () => {
  const supabase = fakeSupabase();
  const { document } = await storeDocument(supabase, 'chizi', {
    filename: 'claim-receipt.pdf', mimeType: 'application/pdf', bytes: Buffer.from('r'),
    source: 'browser_download', workflowId: 'wf-claim'
  });
  await assert.rejects(
    () => uploadDocument(fakeFileInput(), supabase, 'chizi', { documentId: document.id, workflowId: 'wf-job' }),
    /different piece of work/i
  );

  // ...and into its own, it goes through without complaint.
  const ok = await uploadDocument(fakeFileInput(), supabase, 'chizi', { documentId: document.id, workflowId: 'wf-claim' });
  assert.equal(ok.ok, true);
});

test('an unattached personal file is usable by any responsibility', async () => {
  const supabase = fakeSupabase();
  const { document } = await storeDocument(supabase, 'chizi', {
    filename: 'passport.pdf', mimeType: 'application/pdf', bytes: Buffer.from('p'), source: 'upload'
  });
  // A passport uploaded once and reused forever is exactly the case workflow_id is nullable
  // for — it must not be trapped inside whichever workflow happened to be running.
  const result = await uploadDocument(fakeFileInput(), supabase, 'chizi', { documentId: document.id, workflowId: 'wf-anything' });
  assert.equal(result.ok, true);
});

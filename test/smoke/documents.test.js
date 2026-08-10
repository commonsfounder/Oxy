const assert = require('node:assert/strict');
const test = require('node:test');

const {
  storeDocument,
  getDocumentBytes,
  findDocuments,
  attachDocumentToTask,
  setExtraction,
  readExtraction,
  deleteDocument,
  checksumOf,
  DOCUMENTS_BUCKET
} = require('../../api/services/documents');

const KEY = 'a'.repeat(64); // 32-byte hex, for token-crypto

function withKey(fn) {
  const old = process.env.OXY_TOKEN_ENCRYPTION_KEY;
  process.env.OXY_TOKEN_ENCRYPTION_KEY = KEY;
  const done = () => {
    if (old === undefined) delete process.env.OXY_TOKEN_ENCRYPTION_KEY;
    else process.env.OXY_TOKEN_ENCRYPTION_KEY = old;
  };
  const result = fn();
  return result && typeof result.then === 'function' ? result.finally(done) : (done(), result);
}

// Fake Supabase with just enough of the query builder + a Storage double.
function fakeSupabase() {
  const state = { documents: [], blobs: new Map() };
  let idSeq = 0;

  function table(name) {
    const q = { _filters: [], _order: null, _limit: null };
    q.select = () => q;
    q.eq = (f, v) => { q._filters.push(['eq', f, v]); return q; };
    q.is = (f, v) => { q._filters.push(['eq', f, v]); return q; };
    q.ilike = (f, v) => { q._filters.push(['ilike', f, String(v).replace(/%/g, '')]); return q; };
    q.order = () => q;
    q.limit = (n) => { q._limit = n; return q; };
    const rows = () => {
      let out = state[name].filter(row => q._filters.every(([kind, f, v]) => (
        kind === 'eq' ? row[f] === v : String(row[f] || '').toLowerCase().includes(String(v).toLowerCase())
      )));
      if (q._limit) out = out.slice(0, q._limit);
      return out;
    };
    q.maybeSingle = async () => ({ data: rows()[0] || null, error: null });
    q.single = async () => ({ data: rows()[0] || null, error: null });
    q.insert = (row) => {
      const withId = { id: `doc-${++idSeq}`, created_at: new Date().toISOString(), last_used_at: new Date().toISOString(), ...row };
      state[name].push(withId);
      return { select: () => ({ single: async () => ({ data: withId, error: null }) }) };
    };
    q.update = (patch) => {
      const target = { ...q, _filters: [...q._filters] };
      return {
        eq: (f, v) => {
          target._filters.push(['eq', f, v]);
          const matched = state[name].filter(row => target._filters.every(([, ff, vv]) => row[ff] === vv));
          matched.forEach(row => Object.assign(row, patch));
          // Resolve with a PLAIN object, never with `chain` itself — `chain` is a thenable,
          // and resolving a thenable with itself makes the promise machinery re-enter
          // `then` forever. That hangs the whole test file with no output.
          const chain = { select: () => ({ single: async () => ({ data: matched[0] || null, error: null }) }) };
          chain.then = (res) => res({ data: matched, error: null });
          return chain;
        }
      };
    };
    q.delete = () => {
      const target = { _filters: [...q._filters] };
      return {
        eq: (f, v) => {
          target._filters.push([f, v]);
          const before = state[name].length;
          state[name] = state[name].filter(row => !target._filters.every(([ff, vv]) => row[ff] === vv));
          const count = before - state[name].length;
          return { then: (res) => res({ error: null, count }) };
        }
      };
    };
    q.then = (res) => res({ data: rows(), error: null });
    return q;
  }

  const storage = {
    from: (bucket) => ({
      upload: async (path, body) => {
        state.blobs.set(`${bucket}/${path}`, Buffer.from(body));
        return { data: { path }, error: null };
      },
      download: async (path) => {
        const buf = state.blobs.get(`${bucket}/${path}`);
        if (!buf) return { data: null, error: { message: 'not found' } };
        return { data: { arrayBuffer: async () => buf }, error: null };
      },
      remove: async (paths) => {
        paths.forEach(p => state.blobs.delete(`${bucket}/${p}`));
        return { data: null, error: null };
      }
    })
  };

  return { from: table, storage, _state: state };
}

const PDF = Buffer.from('%PDF-1.4 fake policy schedule');

test('storeDocument writes the bytes to storage and indexes them with provenance', async () => {
  const supabase = fakeSupabase();
  const { document, deduped } = await withKey(() => storeDocument(supabase, 'chizi', {
    filename: 'policy.pdf',
    mimeType: 'application/pdf',
    bytes: PDF,
    source: 'email_attachment',
    sourceRef: 'resend-msg-1',
    label: '2026 policy schedule'
  }));

  assert.equal(deduped, false);
  assert.equal(document.user_id, 'chizi');
  assert.equal(document.filename, 'policy.pdf');
  assert.equal(document.byte_size, PDF.length);
  assert.equal(document.source, 'email_attachment');
  assert.equal(document.source_ref, 'resend-msg-1');
  assert.equal(document.extraction_status, 'pending');
  // The blob really landed, under the user's own prefix.
  assert.ok(supabase._state.blobs.has(`${DOCUMENTS_BUCKET}/${document.storage_path}`));
  assert.ok(document.storage_path.startsWith('chizi/'));
  // The filename must not be in the object path — the path is not a place to leak names.
  assert.ok(!document.storage_path.includes('policy.pdf'));
});

test('storing identical bytes twice for the same user reuses the existing document', async () => {
  const supabase = fakeSupabase();
  const first = await withKey(() => storeDocument(supabase, 'chizi', {
    filename: 'cv.pdf', mimeType: 'application/pdf', bytes: PDF, source: 'upload'
  }));
  const second = await withKey(() => storeDocument(supabase, 'chizi', {
    filename: 'cv-final-v2.pdf', mimeType: 'application/pdf', bytes: PDF, source: 'upload'
  }));

  assert.equal(second.deduped, true);
  assert.equal(second.document.id, first.document.id);
  assert.equal(supabase._state.documents.length, 1);
});

test('the same bytes belonging to a different user are a different document', async () => {
  const supabase = fakeSupabase();
  await withKey(() => storeDocument(supabase, 'chizi', {
    filename: 'cv.pdf', mimeType: 'application/pdf', bytes: PDF, source: 'upload'
  }));
  const other = await withKey(() => storeDocument(supabase, 'someone-else', {
    filename: 'cv.pdf', mimeType: 'application/pdf', bytes: PDF, source: 'upload'
  }));
  assert.equal(other.deduped, false);
  assert.equal(supabase._state.documents.length, 2);
});

test('getDocumentBytes returns the original bytes and refuses another user\'s document', async () => {
  const supabase = fakeSupabase();
  const { document } = await withKey(() => storeDocument(supabase, 'chizi', {
    filename: 'policy.pdf', mimeType: 'application/pdf', bytes: PDF, source: 'upload'
  }));

  const got = await getDocumentBytes(supabase, 'chizi', document.id);
  assert.ok(PDF.equals(got.bytes));
  assert.equal(got.document.filename, 'policy.pdf');

  await assert.rejects(() => getDocumentBytes(supabase, 'someone-else', document.id), /not found/i);
});

test('findDocuments matches on label and filename without decrypting anything', async () => {
  const supabase = fakeSupabase();
  await withKey(() => storeDocument(supabase, 'chizi', {
    filename: 'chizi-cv-2026.pdf', mimeType: 'application/pdf', bytes: Buffer.from('cv'), source: 'upload', label: 'CV'
  }));
  await withKey(() => storeDocument(supabase, 'chizi', {
    filename: 'policy.pdf', mimeType: 'application/pdf', bytes: PDF, source: 'email_attachment', label: '2026 policy schedule'
  }));

  const byLabel = await findDocuments(supabase, 'chizi', { query: 'cv' });
  assert.equal(byLabel.length, 1);
  assert.equal(byLabel[0].filename, 'chizi-cv-2026.pdf');

  const bySource = await findDocuments(supabase, 'chizi', { source: 'email_attachment' });
  assert.equal(bySource.length, 1);
  assert.equal(bySource[0].label, '2026 policy schedule');
});

test('a document can be attached to the work it belongs to after the fact', async () => {
  const supabase = fakeSupabase();
  const { document } = await withKey(() => storeDocument(supabase, 'chizi', {
    filename: 'cv.pdf', mimeType: 'application/pdf', bytes: Buffer.from('cv'), source: 'upload'
  }));
  assert.equal(document.agent_task_id, null);

  const attached = await attachDocumentToTask(supabase, 'chizi', document.id, 'task-1');
  assert.equal(attached.agent_task_id, 'task-1');

  const forTask = await findDocuments(supabase, 'chizi', { agentTaskId: 'task-1' });
  assert.equal(forTask.length, 1);
});

test('extracted text is encrypted at rest and round-trips through readExtraction', async () => {
  const supabase = fakeSupabase();
  await withKey(async () => {
    const { document } = await storeDocument(supabase, 'chizi', {
      filename: 'payslip.pdf', mimeType: 'application/pdf', bytes: PDF, source: 'upload'
    });
    await setExtraction(supabase, document.id, {
      text: 'Gross pay 4,200.00',
      fields: { grossPay: '4200.00' },
      status: 'done'
    });

    const row = supabase._state.documents.find(d => d.id === document.id);
    assert.equal(row.extraction_status, 'done');
    // The sensitive part must not be sitting in the clear.
    assert.ok(!JSON.stringify(row.extracted_encrypted).includes('4,200.00'));

    const extraction = await readExtraction(supabase, 'chizi', document.id);
    assert.equal(extraction.text, 'Gross pay 4,200.00');
    assert.equal(extraction.fields.grossPay, '4200.00');
  });
});

test('a document with no extraction yet reads back as pending rather than throwing', async () => {
  const supabase = fakeSupabase();
  const extraction = await withKey(async () => {
    const { document } = await storeDocument(supabase, 'chizi', {
      filename: 'scan.png', mimeType: 'image/png', bytes: Buffer.from('png'), source: 'upload'
    });
    return readExtraction(supabase, 'chizi', document.id);
  });
  assert.equal(extraction.status, 'pending');
  assert.equal(extraction.text, '');
});

test('deleteDocument removes the row and the underlying blob together', async () => {
  const supabase = fakeSupabase();
  const { document } = await withKey(() => storeDocument(supabase, 'chizi', {
    filename: 'policy.pdf', mimeType: 'application/pdf', bytes: PDF, source: 'upload'
  }));
  const path = `${DOCUMENTS_BUCKET}/${document.storage_path}`;
  assert.ok(supabase._state.blobs.has(path));

  await deleteDocument(supabase, 'chizi', document.id);

  assert.equal(supabase._state.documents.length, 0);
  // An orphaned blob is a privacy bug, not just wasted space.
  assert.equal(supabase._state.blobs.has(path), false);
});

test('deleteDocument will not delete another user\'s document', async () => {
  const supabase = fakeSupabase();
  const { document } = await withKey(() => storeDocument(supabase, 'chizi', {
    filename: 'policy.pdf', mimeType: 'application/pdf', bytes: PDF, source: 'upload'
  }));
  await assert.rejects(() => deleteDocument(supabase, 'someone-else', document.id), /not found/i);
  assert.equal(supabase._state.documents.length, 1);
});

test('extraction refuses to store in the clear when the encryption key is missing', async () => {
  // token-crypto degrades to plaintext without OXY_TOKEN_ENCRYPTION_KEY outside production —
  // a deliberate convenience for connector tokens. Document extractions are passports and
  // payslips, so silently writing them in the clear is the wrong trade, in dev too. Caught
  // by the live run against the real database, which unit tests could not see because they
  // set the key themselves.
  const supabase = fakeSupabase();
  const { document } = await withKey(() => storeDocument(supabase, 'chizi', {
    filename: 'passport.pdf', mimeType: 'application/pdf', bytes: PDF, source: 'upload'
  }));

  const old = process.env.OXY_TOKEN_ENCRYPTION_KEY;
  delete process.env.OXY_TOKEN_ENCRYPTION_KEY;
  try {
    await assert.rejects(
      () => setExtraction(supabase, document.id, { text: 'passport number 12345', status: 'done' }),
      /OXY_TOKEN_ENCRYPTION_KEY/
    );
    const row = supabase._state.documents.find(d => d.id === document.id);
    assert.equal(row.extracted_encrypted, undefined, 'nothing may be written when it cannot be encrypted');
    assert.equal(row.extraction_status, 'pending', 'and the status must not claim success');
  } finally {
    if (old === undefined) delete process.env.OXY_TOKEN_ENCRYPTION_KEY;
    else process.env.OXY_TOKEN_ENCRYPTION_KEY = old;
  }
});

test('checksumOf is stable for identical bytes and differs for different bytes', () => {
  assert.equal(checksumOf(Buffer.from('abc')), checksumOf(Buffer.from('abc')));
  assert.notEqual(checksumOf(Buffer.from('abc')), checksumOf(Buffer.from('abd')));
});

test('storeDocument rejects a file with no bytes rather than indexing an empty document', async () => {
  const supabase = fakeSupabase();
  await assert.rejects(
    () => withKey(() => storeDocument(supabase, 'chizi', {
      filename: 'empty.pdf', mimeType: 'application/pdf', bytes: Buffer.alloc(0), source: 'upload'
    })),
    /empty/i
  );
});

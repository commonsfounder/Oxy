'use strict';
/*
 * Live end-to-end check of the documents primitive against the real Supabase project and
 * the real `documents` Storage bucket. Unit tests use a fake client; this proves the parts
 * a fake cannot — that the bucket exists, that the FK to users(user_id) actually accepts a
 * text id, that RLS-with-no-policies does not lock out the service-role client, and that a
 * blob genuinely round-trips.
 *
 * Run: node test/dev/documents-live.js [userId]
 * Cleans up after itself; leaves no rows or objects behind.
 */
require('dotenv').config();
const assert = require('node:assert/strict');
const { createSupabaseServiceClient } = require('../../runtime');
const {
  storeDocument, getDocumentBytes, findDocuments, setExtraction,
  readExtraction, deleteDocument, DOCUMENTS_BUCKET
} = require('../../api/services/documents');

const USER_ID = process.argv[2] || 'demo-test-user';
const MARK = `live-doc-${Date.now()}`;
const BYTES = Buffer.from(`%PDF-1.4 ${MARK} pretend policy schedule\n`);

(async () => {
  const supabase = createSupabaseServiceClient();
  let documentId = null;

  try {
    console.log(`[1] storing a ${BYTES.length}-byte file for ${USER_ID}...`);
    const { document, deduped } = await storeDocument(supabase, USER_ID, {
      filename: `${MARK}.pdf`,
      mimeType: 'application/pdf',
      bytes: BYTES,
      source: 'upload',
      label: MARK
    });
    documentId = document.id;
    assert.equal(deduped, false);
    console.log(`    ok — id=${document.id} path=${document.storage_path} bucket=${DOCUMENTS_BUCKET}`);

    console.log('[2] reading the bytes back out of storage...');
    const { bytes } = await getDocumentBytes(supabase, USER_ID, documentId);
    assert.ok(BYTES.equals(bytes), 'bytes came back different from what went in');
    console.log(`    ok — ${bytes.length} bytes, byte-identical`);

    console.log('[3] dedupe: storing the identical bytes again...');
    const again = await storeDocument(supabase, USER_ID, {
      filename: `${MARK}-copy.pdf`, mimeType: 'application/pdf', bytes: BYTES, source: 'upload'
    });
    assert.equal(again.deduped, true);
    assert.equal(again.document.id, documentId);
    console.log('    ok — reused the existing document, no second row');

    console.log('[4] finding it by label...');
    const found = await findDocuments(supabase, USER_ID, { query: MARK });
    assert.equal(found.length, 1);
    console.log(`    ok — found "${found[0].filename}"`);

    console.log('[5] encrypted extraction round-trip...');
    await setExtraction(supabase, documentId, { text: `${MARK} extracted body`, fields: { marker: MARK }, status: 'done' });
    const extraction = await readExtraction(supabase, USER_ID, documentId);
    assert.equal(extraction.text, `${MARK} extracted body`);
    assert.equal(extraction.status, 'done');
    const { data: raw } = await supabase.from('documents').select('extracted_encrypted').eq('id', documentId).single();
    assert.ok(!JSON.stringify(raw.extracted_encrypted).includes('extracted body'), 'extraction was stored in the clear');
    console.log('    ok — decrypts correctly, and is genuinely ciphertext at rest');

    console.log('[6] cross-user access is refused...');
    await assert.rejects(() => getDocumentBytes(supabase, 'definitely-not-this-user', documentId), /not found/i);
    console.log('    ok — refused');

    console.log('[7] deleting document + blob...');
    await deleteDocument(supabase, USER_ID, documentId);
    documentId = null;
    const { data: gone } = await supabase.from('documents').select('id').eq('label', MARK);
    assert.equal((gone || []).length, 0);
    console.log('    ok — row gone');

    console.log('\nPASS — documents primitive verified live.');
  } catch (err) {
    console.error('\nFAIL —', err.message);
    process.exitCode = 1;
  } finally {
    if (documentId) {
      await deleteDocument(supabase, USER_ID, documentId).catch(() => {});
      console.log('(cleaned up leftover document)');
    }
  }
})();

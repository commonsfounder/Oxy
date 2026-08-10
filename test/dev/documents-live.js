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
  storeDocument, getDocumentBytes, findDocuments, extractDocument, getDocumentText,
  getDocumentFields, addRepresentation, createDerivedDocument, getDocumentVersions,
  deleteDocument, DOCUMENTS_BUCKET
} = require('../../api/services/documents');
const { zipSync, strToU8 } = require('fflate');

const USER_ID = process.argv[2] || 'demo-test-user';
const MARK = `live-doc-${Date.now()}`;
// A real DOCX, so extraction has something genuine to read.
const BYTES = Buffer.from(zipSync({
  'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>${MARK} Chizi Monyewuchi</w:t></w:r></w:p><w:p><w:r><w:t>Senior Engineer</w:t></w:r></w:p></w:body></w:document>`)
}));
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

(async () => {
  const supabase = createSupabaseServiceClient();
  let documentId = null;
  let derivedId = null;

  try {
    console.log(`[1] storing a ${BYTES.length}-byte file for ${USER_ID}...`);
    const { document, deduped } = await storeDocument(supabase, USER_ID, {
      filename: `${MARK}.docx`,
      mimeType: DOCX_MIME,
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
      filename: `${MARK}-copy.docx`, mimeType: DOCX_MIME, bytes: BYTES, source: 'upload'
    });
    assert.equal(again.deduped, true);
    assert.equal(again.document.id, documentId);
    console.log('    ok — reused the existing document, no second row');

    console.log('[4] finding it by label...');
    const found = await findDocuments(supabase, USER_ID, { query: MARK });
    assert.equal(found.length, 1);
    console.log(`    ok — found "${found[0].filename}"`);

    console.log('[5] extraction: real DOCX read, stored as a representation...');
    const extraction = await extractDocument(supabase, USER_ID, documentId);
    assert.equal(extraction.status, 'done', `expected extraction to succeed, got ${extraction.status}: ${extraction.notes || ''}`);
    const { text, producer } = await getDocumentText(supabase, USER_ID, documentId);
    assert.match(text, new RegExp(MARK));
    assert.match(text, /Senior Engineer/);
    console.log(`    ok — producer=${producer}, ${text.length} chars`);

    console.log('[6] the original is byte-identical after extraction...');
    const after = await getDocumentBytes(supabase, USER_ID, documentId);
    assert.ok(BYTES.equals(after.bytes), 'extraction modified the stored original');
    console.log('    ok — original untouched');

    console.log('[7] representation content is ciphertext at rest...');
    const { data: repRows } = await supabase.from('document_representations').select('content_encrypted').eq('document_id', documentId);
    assert.ok(repRows.length >= 1);
    assert.ok(!JSON.stringify(repRows).includes('Senior Engineer'), 'representation was stored in the clear');
    console.log('    ok — genuinely encrypted');

    console.log('[8] low-confidence fields are withheld...');
    await addRepresentation(supabase, documentId, {
      kind: 'fields', producer: 'vision-ocr', confidence: 0.6,
      content: { fields: { total: { value: '42.00', confidence: 0.95 }, account: { value: '80080O', confidence: 0.4 } } }
    });
    const { fields, withheld } = await getDocumentFields(supabase, USER_ID, documentId);
    assert.equal(fields.total.value, '42.00');
    assert.equal(fields.account, undefined, 'a 0.4-confidence OCR read must not become a fact');
    assert.equal(withheld.account.value, '80080O');
    console.log('    ok — 1 accepted, 1 withheld');

    console.log('[9] derived version: original survives...');
    const derived = await createDerivedDocument(supabase, USER_ID, documentId, {
      bytes: Buffer.from(`${MARK} tailored version`), filename: `${MARK}-tailored.docx`, label: `${MARK} tailored`
    });
    derivedId = derived.id;
    assert.equal(derived.version, 2);
    assert.equal(derived.root_document_id, documentId);
    const versions = await getDocumentVersions(supabase, USER_ID, documentId);
    assert.deepEqual(versions.map(v => v.version), [1, 2]);
    console.log(`    ok — v1 + v2 under one root`);

    console.log('[10] cross-user access is refused...');
    await assert.rejects(() => getDocumentBytes(supabase, 'definitely-not-this-user', documentId), /not found/i);
    console.log('    ok — refused');

    console.log('[11] deleting documents + blobs...');
    if (derivedId) { await deleteDocument(supabase, USER_ID, derivedId); derivedId = null; }
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
    for (const leftover of [documentId, derivedId].filter(Boolean)) {
      await deleteDocument(supabase, USER_ID, leftover).catch(() => {});
      console.log('(cleaned up leftover document)');
    }
  }
})();

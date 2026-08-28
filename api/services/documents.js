'use strict';
const crypto = require('crypto');
const { encryptTokens, decryptTokens, isEncryptedTokenEnvelope } = require('./token-crypto');
const { extractorFor } = require('./document-extraction');

// The index over the bytes in the private `documents` bucket. Two rules shape it:
//   1. Storing a file never depends on understanding it. Extraction is a separate best-effort
//      pass, and a document is fully usable at extraction_status 'pending'.
//   2. Every read is scoped by user_id, not just document id — these are passports and payslips,
//      so the scoping lives here rather than in each call site.
// Encryption is split: blobs rely on the private bucket and at-rest encryption, while extracted
// text gets token-crypto's envelope, being the part that reaches prompts and query results.

const DOCUMENTS_BUCKET = 'documents';

// Big enough for a scanned passport or a multi-page policy PDF, small enough that a
// runaway download can't exhaust the container's memory — the whole file is buffered.
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

const VALID_SOURCES = new Set(['upload', 'email_attachment', 'browser_download', 'generated']);

function checksumOf(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sanitizeFilename(value) {
  const name = String(value || '').trim().replace(/[\r\n]/g, '').split(/[\\/]/).pop();
  return (name || 'file').slice(0, 200);
}

// The object path deliberately carries no filename — only the owner and an opaque id.
// Storage paths turn up in logs and error messages, and "chizi/passport-scan.pdf" leaks
// the interesting part before anyone has opened anything.
function buildStoragePath(userId, checksum) {
  const safeUser = String(userId).replace(/[^a-zA-Z0-9._-]+/g, '') || 'unknown';
  return `${safeUser}/${checksum}`;
}

async function findByChecksum(supabase, userId, checksum) {
  const { data } = await supabase
    .from('documents')
    .select('*')
    .eq('user_id', userId)
    .eq('checksum', checksum)
    .limit(1);
  return data?.[0] || null;
}

async function storeDocument(supabase, userId, {
  filename, mimeType, bytes, source, sourceRef = null, label = null,
  agentTaskId = null, participantId = null, conversationId = null, workflowId = null
} = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!buffer.length) throw new Error('Refusing to store an empty file.');
  if (buffer.length > MAX_DOCUMENT_BYTES) {
    throw new Error(`That file is too big to handle (${Math.round(buffer.length / 1024 / 1024)}MB, limit ${MAX_DOCUMENT_BYTES / 1024 / 1024}MB).`);
  }
  if (!VALID_SOURCES.has(source)) throw new Error(`Unknown document source "${source}".`);

  const checksum = checksumOf(buffer);

  // Same bytes, same user: reuse. "Re-upload my CV" should find the CV already here rather
  // than accumulating near-identical rows that later have to be disambiguated.
  const existing = await findByChecksum(supabase, userId, checksum);
  if (existing) {
    await touchDocument(supabase, existing.id);
    return { document: existing, deduped: true };
  }

  const storagePath = buildStoragePath(userId, checksum);
  const { error: uploadError } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(storagePath, buffer, { contentType: mimeType || 'application/octet-stream', upsert: true });
  if (uploadError) throw new Error(`Couldn't save that file: ${uploadError.message}`);

  const { data, error } = await supabase.from('documents').insert({
    user_id: userId,
    agent_task_id: agentTaskId,
    participant_id: participantId,
    conversation_id: conversationId,
    // The responsibility this file belongs to. Nullable ONLY for genuinely personal files
    // that exist outside any piece of work (a passport uploaded once, reused forever) —
    // anything created, downloaded or uploaded DURING work carries it.
    workflow_id: workflowId,
    filename: sanitizeFilename(filename),
    mime_type: mimeType || 'application/octet-stream',
    byte_size: buffer.length,
    checksum,
    storage_path: storagePath,
    source,
    source_ref: sourceRef,
    label,
    extraction_status: 'pending'
  }).select().single();

  if (error) {
    // Don't leave the blob behind if the index write failed — an unreferenced object is
    // data we're holding and can no longer account for.
    await supabase.storage.from(DOCUMENTS_BUCKET).remove([storagePath]).catch(() => {});
    throw new Error(`Couldn't record that file: ${error.message}`);
  }
  return { document: data, deduped: false };
}

async function getDocument(supabase, userId, documentId) {
  const { data } = await supabase
    .from('documents')
    .select('*')
    .eq('id', documentId)
    .eq('user_id', userId)
    .limit(1);
  const document = data?.[0] || null;
  if (!document) throw new Error('That document was not found.');
  return document;
}

async function getDocumentBytes(supabase, userId, documentId) {
  const document = await getDocument(supabase, userId, documentId);
  const { data, error } = await supabase.storage.from(DOCUMENTS_BUCKET).download(document.storage_path);
  if (error || !data) throw new Error(`Couldn't read that file back: ${error?.message || 'missing from storage'}`);
  const arrayBuffer = await data.arrayBuffer();
  await touchDocument(supabase, documentId);
  return { document, bytes: Buffer.from(arrayBuffer) };
}

// Metadata-only search: label, filename, source, owning task. Deliberately does not touch
// extracted_encrypted — finding "the CV" should not require decrypting every document the
// user has.
async function findDocuments(supabase, userId, { query = '', source = null, agentTaskId = null, workflowId = null, limit = 20 } = {}) {
  let q = supabase.from('documents').select('*').eq('user_id', userId);
  if (source) q = q.eq('source', source);
  if (agentTaskId) q = q.eq('agent_task_id', agentTaskId);
  if (workflowId) q = q.eq('workflow_id', workflowId);
  const { data } = await q.order('created_at', { ascending: false }).limit(200);
  const rows = data || [];
  const needle = String(query || '').trim().toLowerCase();
  const matched = needle
    ? rows.filter(r => `${r.label || ''} ${r.filename || ''}`.toLowerCase().includes(needle))
    : rows;
  return matched.slice(0, limit);
}

async function attachDocumentToTask(supabase, userId, documentId, agentTaskId) {
  await getDocument(supabase, userId, documentId); // scope check before any write
  const { data, error } = await supabase.from('documents')
    .update({ agent_task_id: agentTaskId })
    .eq('id', documentId)
    .select()
    .single();
  if (error) throw new Error(`Couldn't attach that document: ${error.message}`);
  return data;
}

// --- Representations -----------------------------------------------------------------
// A document is the original file; everything we work out about it is an attributed
// representation alongside it. Extraction never touches the stored bytes, and re-reading a
// document with a better extractor adds a reading rather than destroying the old one.

async function addRepresentation(supabase, documentId, {
  kind, producer, producerVersion = '1', confidence = null, content, notes = null
} = {}) {
  const envelope = encryptTokens(content);
  // encryptTokens returns its input UNCHANGED when OXY_TOKEN_ENCRYPTION_KEY is missing
  // outside production — a reasonable convenience for connector tokens, and the wrong trade
  // here. A representation holds passport numbers and payslip figures, so refuse rather
  // than quietly write plaintext. Better no reading than a plaintext one.
  if (!isEncryptedTokenEnvelope(envelope)) {
    throw new Error('Refusing to store a document representation unencrypted — set OXY_TOKEN_ENCRYPTION_KEY (32-byte hex).');
  }
  const row = {
    document_id: documentId,
    kind,
    producer,
    producer_version: producerVersion,
    confidence,
    content_encrypted: envelope,
    notes
  };
  // Re-running the same producer replaces its own previous reading; a different producer
  // coexists with it. The unique index (document_id, kind, producer) is what makes that true.
  const { data, error } = await supabase.from('document_representations')
    .upsert(row, { onConflict: 'document_id,kind,producer' })
    .select()
    .single();
  if (error) throw new Error(`Couldn't store that reading: ${error.message}`);
  return data;
}

async function getRepresentations(supabase, userId, documentId, kind = null) {
  await getDocument(supabase, userId, documentId); // scope check before reading contents
  let q = supabase.from('document_representations').select('*').eq('document_id', documentId);
  if (kind) q = q.eq('kind', kind);
  const { data } = await q;
  return (data || []).map(row => ({ ...row, content: decryptTokens(row.content_encrypted) }));
}

// The best available linear reading: highest confidence wins, so a real text layer beats an
// OCR guess of the same document without the caller having to know which producers exist.
async function getDocumentText(supabase, userId, documentId) {
  const reps = await getRepresentations(supabase, userId, documentId, 'text');
  if (!reps.length) return { text: '', confidence: 0, producer: null };
  const best = reps.sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))[0];
  return { text: best.content?.text || '', confidence: Number(best.confidence || 0), producer: best.producer, notes: best.notes };
}

// Low-confidence values must not become facts. The default floor is deliberately high: a
// caller that wants to see uncertain readings has to ask for them explicitly, and gets them
// with their confidence attached so it can still tell the difference.
async function getDocumentFields(supabase, userId, documentId, { minConfidence = 0.9 } = {}) {
  const reps = await getRepresentations(supabase, userId, documentId, 'fields');
  const accepted = {};
  const withheld = {};
  for (const rep of reps) {
    for (const [name, entry] of Object.entries(rep.content?.fields || {})) {
      const confidence = Number(entry?.confidence ?? 0);
      const record = { value: entry?.value, confidence, producer: rep.producer };
      if (confidence >= minConfidence) accepted[name] = record;
      else withheld[name] = record;
    }
  }
  return { fields: accepted, withheld };
}

// Runs the right extractor for the file and records what it found. Deliberately does not
// throw on a failed read: an unreadable scan is still a file the user can send to an
// insurer, so the document stays usable and only its extraction_status reflects the failure.
async function extractDocument(supabase, userId, documentId, { visionExtract = null } = {}) {
  const { document, bytes } = await getDocumentBytes(supabase, userId, documentId);
  const extractor = extractorFor(document.mime_type);

  if (!extractor) {
    await supabase.from('documents').update({ extraction_status: 'unsupported' }).eq('id', documentId);
    return { status: 'unsupported', notes: `No extractor for ${document.mime_type}.` };
  }

  const result = extractor.kind === 'image'
    ? await extractor.run(bytes, document.mime_type, visionExtract)
    : await extractor.run(bytes);

  if (!result.ok) {
    await supabase.from('documents').update({ extraction_status: 'failed' }).eq('id', documentId);
    return { status: 'failed', notes: result.notes, producer: result.producer };
  }

  if (result.text) {
    await addRepresentation(supabase, documentId, {
      kind: 'text', producer: result.producer, producerVersion: result.producerVersion,
      confidence: result.confidence, content: { text: result.text }, notes: result.notes
    });
  }
  if (result.fields) {
    await addRepresentation(supabase, documentId, {
      kind: 'fields', producer: result.producer, producerVersion: result.producerVersion,
      confidence: result.confidence, content: { fields: result.fields }, notes: result.notes
    });
  }

  await supabase.from('documents').update({ extraction_status: 'done' }).eq('id', documentId);
  return { status: 'done', producer: result.producer, confidence: result.confidence, notes: result.notes };
}

// A tailored CV is a NEW document derived from the original, never an edit of it. The
// original's bytes, representations and provenance all survive untouched, and both versions
// stay findable together through root_document_id.
async function createDerivedDocument(supabase, userId, sourceDocumentId, {
  bytes, filename, mimeType = null, label = null, source = 'generated', sourceRef = null
} = {}) {
  const source_doc = await getDocument(supabase, userId, sourceDocumentId);
  const rootId = source_doc.root_document_id || source_doc.id;

  const { data: siblings } = await supabase.from('documents').select('version').eq('root_document_id', rootId);
  const nextVersion = Math.max(source_doc.version || 1, ...(siblings || []).map(s => s.version || 1)) + 1;

  const { document } = await storeDocument(supabase, userId, {
    filename: filename || source_doc.filename,
    mimeType: mimeType || source_doc.mime_type,
    bytes,
    source,
    sourceRef,
    label: label || source_doc.label,
    agentTaskId: source_doc.agent_task_id,
    participantId: source_doc.participant_id,
    conversationId: source_doc.conversation_id,
    workflowId: source_doc.workflow_id
  });

  const { data, error } = await supabase.from('documents')
    .update({ version: nextVersion, root_document_id: rootId, derived_from_document_id: source_doc.id })
    .eq('id', document.id)
    .select()
    .single();
  if (error) throw new Error(`Couldn't record that new version: ${error.message}`);
  return data;
}

async function getDocumentVersions(supabase, userId, documentId) {
  const document = await getDocument(supabase, userId, documentId);
  const rootId = document.root_document_id || document.id;
  const { data } = await supabase.from('documents').select('*').eq('user_id', userId).eq('root_document_id', rootId);
  const all = [document, ...(data || [])];
  const unique = [...new Map(all.map(d => [d.id, d])).values()];
  return unique.sort((a, b) => (a.version || 1) - (b.version || 1));
}

async function touchDocument(supabase, documentId) {
  await supabase.from('documents').update({ last_used_at: new Date().toISOString() }).eq('id', documentId);
}

async function deleteDocument(supabase, userId, documentId) {
  const document = await getDocument(supabase, userId, documentId);
  // Blob first: if the row goes and the object survives, we are holding user data we can
  // no longer see, which is worse than the reverse.
  await supabase.storage.from(DOCUMENTS_BUCKET).remove([document.storage_path]);
  const { error } = await supabase.from('documents').delete().eq('id', documentId);
  if (error) throw new Error(`Couldn't delete that document: ${error.message}`);
  return { deleted: true };
}

module.exports = {
  DOCUMENTS_BUCKET,
  MAX_DOCUMENT_BYTES,
  checksumOf,
  storeDocument,
  getDocument,
  getDocumentBytes,
  findDocuments,
  attachDocumentToTask,
  addRepresentation,
  getRepresentations,
  getDocumentText,
  getDocumentFields,
  extractDocument,
  createDerivedDocument,
  getDocumentVersions,
  touchDocument,
  deleteDocument
};

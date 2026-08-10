'use strict';
const crypto = require('crypto');
const { encryptTokens, decryptTokens, isEncryptedTokenEnvelope } = require('./token-crypto');

// Files, as a first-class thing Millie can hold.
//
// Bytes go to the private `documents` Storage bucket; this module is the index over them.
// Two rules shape the whole file:
//
//   1. Storing a file must never depend on understanding it. Extraction is a separate,
//      best-effort pass (setExtraction) that fills in later. A document is valid and
//      usable at extraction_status 'pending' — otherwise a scanned PDF we can't parse
//      becomes a file we refuse to keep, which is exactly backwards.
//
//   2. Every read is scoped by user_id, not just by document id. These are passports and
//      payslips; a missing .eq('user_id') here is a cross-user data leak, so the scoping
//      lives inside this module rather than being left to each call site to remember.
//
// Encryption is split on purpose: blobs rely on the private bucket plus Supabase's at-rest
// encryption, while extracted text gets token-crypto's envelope, because that is the part
// that gets read into prompts and query results. See the migration for the full reasoning.

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
  agentTaskId = null, participantId = null, conversationId = null
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
async function findDocuments(supabase, userId, { query = '', source = null, agentTaskId = null, limit = 20 } = {}) {
  let q = supabase.from('documents').select('*').eq('user_id', userId);
  if (source) q = q.eq('source', source);
  if (agentTaskId) q = q.eq('agent_task_id', agentTaskId);
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

async function setExtraction(supabase, documentId, { text = '', fields = null, status = 'done' } = {}) {
  const envelope = encryptTokens({ text, fields });
  // encryptTokens returns the object UNCHANGED when OXY_TOKEN_ENCRYPTION_KEY is missing
  // outside production — a deliberate convenience for connector tokens, and the wrong trade
  // here. A document extraction is a passport number or a payslip, so refuse rather than
  // quietly write it in the clear. Better to have no extraction than a plaintext one.
  if (!isEncryptedTokenEnvelope(envelope)) {
    throw new Error('Refusing to store document extraction unencrypted — set OXY_TOKEN_ENCRYPTION_KEY (32-byte hex).');
  }
  const { error } = await supabase.from('documents')
    .update({ extracted_encrypted: envelope, extraction_status: status })
    .eq('id', documentId);
  if (error) throw new Error(`Couldn't record extraction: ${error.message}`);
}

async function readExtraction(supabase, userId, documentId) {
  const document = await getDocument(supabase, userId, documentId);
  if (!document.extracted_encrypted) {
    return { status: document.extraction_status, text: '', fields: null };
  }
  const decrypted = decryptTokens(document.extracted_encrypted);
  return { status: document.extraction_status, text: decrypted.text || '', fields: decrypted.fields || null };
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
  setExtraction,
  readExtraction,
  touchDocument,
  deleteDocument
};

'use strict';
const { storeDocument, getDocument, getDocumentBytes } = require('./documents');

// The two directions that turn the browser from a thing that reads pages into a thing that
// can do paperwork: files off a website into the document store, and files out of the store
// into a website's upload field.
//
// This lives outside browser-task.js on purpose. That file is 6,000 lines of order loop, and
// these operations have nothing to do with ordering — they are equally the machinery of
// applying for a job, downloading a policy, or claiming a refund. Keeping them here also
// means they can be tested without launching a browser.
//
// The discipline from email attachments carries over unchanged: uploads are resolved by
// DOCUMENT ID, never by filename, and a document belonging to another workflow is refused.

// Downloads are usually a click away, not an instant response; a slow gov.uk PDF render can
// take a while, but waiting forever would hang the whole task.
const DOWNLOAD_TIMEOUT_MS = 45_000;

// Browsers hand back a suggested filename that comes from the remote server. It is untrusted
// input: it can contain path separators, newlines or absurd length. storeDocument sanitizes
// too, but not letting it through in the first place keeps logs and prompts clean.
function safeSuggestedFilename(value, fallback = 'download') {
  const name = String(value || '').replace(/[\r\n]/g, '').split(/[\\/]/).pop().trim();
  return name.slice(0, 200) || fallback;
}

function guessMimeType(filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  const map = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    csv: 'text/csv', txt: 'text/plain', json: 'application/json',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip'
  };
  return map[ext] || 'application/octet-stream';
}

// Runs `triggerAction` (a click, usually) while watching for a download, and files whatever
// arrives into the document store — tagged with the page it came from and the work it
// belongs to, so a form fetched during an application is attached to that application rather
// than landing in a general pile.
async function captureDownload(page, triggerAction, {
  supabase, userId, agentTaskId = null, workflowId = null, sourceUrl = null, label = null,
  timeoutMs = DOWNLOAD_TIMEOUT_MS, readDownload = defaultReadDownload
} = {}) {
  if (!supabase || !userId) throw new Error('captureDownload needs a supabase client and a userId.');

  // The listener must be armed BEFORE the click: a fast server can finish the download
  // before an after-the-fact waitForEvent is attached, and the event would be missed.
  const downloadPromise = page.waitForEvent('download', { timeout: timeoutMs });
  await triggerAction();

  let download;
  try {
    download = await downloadPromise;
  } catch {
    // Not every click that looks like a download is one. Returning a value rather than
    // throwing lets the loop treat it as "that didn't produce a file" and carry on.
    return { ok: false, notes: 'No file download started from that click.' };
  }

  const failure = await download.failure?.();
  if (failure) return { ok: false, notes: `Download failed: ${failure}` };

  const filename = safeSuggestedFilename(download.suggestedFilename?.());
  const bytes = await readDownload(download);
  if (!bytes?.length) return { ok: false, notes: 'The download arrived empty.' };

  const { document, deduped } = await storeDocument(supabase, userId, {
    filename,
    mimeType: guessMimeType(filename),
    bytes,
    source: 'browser_download',
    // Provenance is the whole point of storing this rather than a temp file: months later
    // we can still say which page produced it.
    sourceRef: sourceUrl || (typeof page.url === 'function' ? page.url() : null),
    label,
    agentTaskId,
    // Files fetched during work belong to that work. Before this, every browser download
    // landed unattached and the cross-workflow guard had nothing to guard on.
    workflowId
  });

  return { ok: true, document, deduped, filename, byteSize: bytes.length };
}

async function defaultReadDownload(download) {
  // Playwright exposes downloads as a stream; buffering is fine at our size cap and avoids
  // needing a writable temp directory inside the container.
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Resolves which stored document to upload. Id only — the same rule as email attachments,
// for the same reason: matching "cv" against filenames is how a passport ends up on a job
// application.
async function resolveDocumentForUpload(supabase, userId, { documentId, agentTaskId = null, workflowId = null, allowCrossWorkflow = false } = {}) {
  if (!documentId) throw new Error('Which document should be uploaded? It has to be chosen by id, not by name.');
  const document = await getDocument(supabase, userId, documentId);
  if (allowCrossWorkflow) return document;

  // Workflow is the real boundary now that browser work has one; agent_task_id remains
  // checked so documents attached before workflows existed still behave.
  const conflictsOnWorkflow = document.workflow_id && workflowId && document.workflow_id !== workflowId;
  const conflictsOnTask = document.agent_task_id && agentTaskId && document.agent_task_id !== agentTaskId;
  if (conflictsOnWorkflow || conflictsOnTask) {
    throw new Error(`"${document.filename}" belongs to a different piece of work — not uploading it here without you saying so.`);
  }
  return document;
}

// Puts a stored document into a page's file input.
async function uploadDocument(fileInput, supabase, userId, {
  documentId, agentTaskId = null, workflowId = null, allowCrossWorkflow = false
} = {}) {
  const document = await resolveDocumentForUpload(supabase, userId, { documentId, agentTaskId, workflowId, allowCrossWorkflow });
  const { bytes } = await getDocumentBytes(supabase, userId, document.id);

  // setInputFiles with an in-memory buffer, rather than writing to disk first: the bytes are
  // already here, and a temp file would be one more place a passport scan exists.
  await fileInput.setInputFiles({
    name: document.filename,
    mimeType: document.mime_type,
    buffer: bytes
  });

  return { ok: true, document, byteSize: bytes.length };
}

module.exports = {
  DOWNLOAD_TIMEOUT_MS,
  safeSuggestedFilename,
  guessMimeType,
  captureDownload,
  resolveDocumentForUpload,
  uploadDocument
};

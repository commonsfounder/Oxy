'use strict';
const { storeDocument, getDocument, getDocumentBytes } = require('./documents');

// Documents crossing the boundary between Millie's mailbox and her document store.
//
// The dangerous direction is outbound. "Attach my CV" must never be resolved by matching a
// filename, because `passport-scan.pdf` and `passport-photo-cv.pdf` are one fuzzy match away
// from each other and the failure mode is emailing someone's passport to a stranger. So:
//
//   * Attachments are chosen by DOCUMENT ID only. There is deliberately no name-matching
//     path in this module — picking which document is meant is the agent's job, done against
//     findDocuments, in the open, before this point.
//   * A document already bound to a different workflow is refused. If the CV is attached to
//     the Acme application, it does not silently ride along on an unrelated insurance email.
//   * Nothing here sends anything. Every caller is behind the existing review gate, so a
//     human sees the filenames before they leave.

const MAX_ATTACHMENTS_PER_SEND = 10;
// Resend's documented per-message ceiling is 40MB total; stay well under it, and under the
// per-document cap besides.
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

// Resolves explicit document ids into sendable attachments, refusing anything that does not
// belong to this user or this piece of work.
async function resolveAttachmentsForSend(supabase, userId, {
  documentIds = [], requestTaskId = null, allowCrossWorkflow = false
} = {}) {
  const ids = [...new Set((documentIds || []).map(String).filter(Boolean))];
  if (!ids.length) return { attachments: [], documents: [] };
  if (ids.length > MAX_ATTACHMENTS_PER_SEND) {
    throw new Error(`That's more than ${MAX_ATTACHMENTS_PER_SEND} attachments — send them in separate messages.`);
  }

  const attachments = [];
  const documents = [];
  let totalBytes = 0;

  for (const id of ids) {
    // getDocument scopes by user_id, so another user's id simply does not resolve.
    const document = await getDocument(supabase, userId, id);

    // The workflow guard. A document pinned to one task must not drift onto another's
    // outbound mail just because it was named in the wrong turn.
    if (!allowCrossWorkflow && document.agent_task_id && requestTaskId && document.agent_task_id !== requestTaskId) {
      throw new Error(`"${document.filename}" belongs to a different piece of work — attach it there, or say explicitly that you want it on this one.`);
    }

    const { bytes } = await getDocumentBytes(supabase, userId, id);
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(`Those attachments come to more than ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024}MB together — too big to email.`);
    }

    attachments.push({ filename: document.filename, content: bytes.toString('base64') });
    documents.push(document);
  }

  return { attachments, documents };
}

// Inbound: an email arrived with files on it. Each becomes a document carrying where it came
// from, so "the policy schedule they sent me" is answerable later.
//
// Deduping is inherited from storeDocument's checksum reuse rather than reimplemented here,
// which is what makes a thread of five replies quoting the same attachment produce one
// document instead of five.
async function ingestEmailAttachments(supabase, userId, parsedAttachments = [], {
  conversationId = null, participantId = null, providerMessageId = null, agentTaskId = null
} = {}) {
  const stored = [];
  for (const attachment of parsedAttachments || []) {
    const bytes = attachmentBytes(attachment);
    if (!bytes?.length) continue;
    try {
      const { document, deduped } = await storeDocument(supabase, userId, {
        filename: attachment.filename || attachment.name || 'attachment',
        mimeType: attachment.contentType || attachment.content_type || attachment.type || 'application/octet-stream',
        bytes,
        source: 'email_attachment',
        sourceRef: providerMessageId,
        conversationId,
        participantId,
        agentTaskId
      });
      stored.push({ document, deduped });
    } catch (err) {
      // One unreadable attachment must not lose the rest of the email, nor the message
      // itself — the inbound webhook's job is to record what arrived.
      console.warn('[document-attachments] skipped an attachment:', err.message);
    }
  }
  return stored;
}

// Providers differ on how they hand over bytes; accept the shapes we may actually see rather
// than assuming one. Verified against a real inbound payload before this is relied on.
function attachmentBytes(attachment) {
  if (!attachment) return null;
  if (Buffer.isBuffer(attachment.content)) return attachment.content;
  if (typeof attachment.content === 'string') return Buffer.from(attachment.content, 'base64');
  if (typeof attachment.contentBase64 === 'string') return Buffer.from(attachment.contentBase64, 'base64');
  if (attachment.content?.data && Array.isArray(attachment.content.data)) return Buffer.from(attachment.content.data);
  return null;
}

module.exports = {
  MAX_ATTACHMENTS_PER_SEND,
  MAX_TOTAL_ATTACHMENT_BYTES,
  resolveAttachmentsForSend,
  ingestEmailAttachments,
  attachmentBytes
};

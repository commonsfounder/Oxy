'use strict';
const axios = require('axios');
const crypto = require('crypto');

// Millie's own outbound/inbound email, sent through the same Resend account this
// platform already uses for transactional mail (api/services/email.js) — a
// sibling integration, not a new vendor relationship. Inbound requires Resend's
// inbound-receiving feature to be configured on MILLIE_EMAIL_DOMAIN with a webhook
// pointed at POST /webhooks/millie-email — verify current availability/pricing on
// the Resend plan in use before relying on this in production.

const MILLIE_EMAIL_SIGNATURE_LINE = "— sent by Millie, an assistant, on behalf of the person who asked";

function extractAddress(value) {
  const match = String(value || '').match(/<([^>]+)>/);
  return (match ? match[1] : String(value || '')).trim().toLowerCase();
}

async function sendMillieEmail({ from, to, subject, body, inReplyTo, references, attachments = [] }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not configured — Millie cannot send email yet.');
  const text = `${body}\n\n${MILLIE_EMAIL_SIGNATURE_LINE}`;
  const headers = {};
  if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
  if (references) headers['References'] = references;
  const response = await axios.post('https://api.resend.com/emails', {
    from,
    to,
    subject,
    text,
    // Resend takes attachments as { filename, content } with content base64-encoded.
    // Resolution and the workflow guard happen upstream in document-attachments.js — by
    // the time bytes reach here the decision about WHICH file has already been made and
    // reviewed.
    ...(attachments.length ? { attachments } : {}),
    ...(Object.keys(headers).length ? { headers } : {})
  }, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    timeout: 15000
  });
  return { providerMessageId: response.data?.id || null };
}

function parseInboundPayload(payload) {
  const data = payload?.data || payload || {};
  const fromAddress = extractAddress(data.from);
  if (!fromAddress) return null;
  const toRaw = Array.isArray(data.to) ? data.to[0] : data.to;
  return {
    fromAddress,
    toAddress: extractAddress(toRaw),
    subject: String(data.subject || ''),
    body: String(data.text || data.html || ''),
    providerMessageId: data.email_id || data.id || null,
    inReplyTo: data.headers?.['in-reply-to'] || data.headers?.['In-Reply-To'] || null,
    references: data.headers?.references || data.headers?.References || null,
    // Left as the provider's own shape; document-attachments.js normalizes the byte
    // encoding, since providers disagree on whether content arrives base64, as a Buffer,
    // or as a byte array.
    attachments: Array.isArray(data.attachments) ? data.attachments : []
  };
}

// Resend delivers inbound webhooks via Svix. The signing scheme is fixed by Svix, not by
// Resend: secret is "whsec_<base64>"; the signed content is "<svix-id>.<svix-timestamp>.<raw
// body>", HMAC-SHA256'd with the decoded secret and base64-encoded; the svix-signature header
// carries one or more space-separated "v1,<sig>" entries (key rotation sends more than one).
// `rawBody` MUST be the exact bytes Resend sent — parsing and re-serializing JSON before this
// check would change whitespace/key order and silently break every signature.
const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

function verifyResendWebhookSignature(rawBody, headers = {}, secret) {
  if (!secret) return false;
  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signatureHeader = headers['svix-signature'];
  if (!id || !timestamp || !signatureHeader) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds);
  if (ageSeconds > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) return false;

  let secretBytes;
  try {
    secretBytes = Buffer.from(String(secret).split('_')[1] || '', 'base64');
  } catch {
    return false;
  }
  if (!secretBytes.length) return false;

  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  const expectedBuf = Buffer.from(expected, 'base64');

  return String(signatureHeader).split(' ').some(entry => {
    const provided = entry.startsWith('v1,') ? entry.slice(3) : entry;
    let providedBuf;
    try {
      providedBuf = Buffer.from(provided, 'base64');
    } catch {
      return false;
    }
    return providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
  });
}

module.exports = { sendMillieEmail, parseInboundPayload, verifyResendWebhookSignature, MILLIE_EMAIL_SIGNATURE_LINE };

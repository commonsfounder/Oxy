'use strict';
const axios = require('axios');

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

async function sendMillieEmail({ from, to, subject, body, inReplyTo, references }) {
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
    references: data.headers?.references || data.headers?.References || null
  };
}

module.exports = { sendMillieEmail, parseInboundPayload, MILLIE_EMAIL_SIGNATURE_LINE };

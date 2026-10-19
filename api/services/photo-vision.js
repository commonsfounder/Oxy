'use strict';

// Turns one of the user's own photos into a short note so it can be found later. The picture is
// looked at once and never stored; only the note is kept (see photo-notes.js).

const PROMPT = `You are helping a personal assistant remember what is in a photo from the user's own camera roll, so it can be found later when they ask about it.
In one or two plain sentences say what the photo shows: the main things, clothing or products (with colours and brands if visible), the setting, and how many people (never who they are). Include readable text that matters, such as names, dates, amounts and product names. If it is a document, receipt or screenshot, say what kind and the key facts.
Do not guess identities. If the photo is private or sensitive (nudity, ID documents, bank cards, passwords, medical records), reply with exactly SKIP.`;

const MAX_BYTES = 700 * 1024;

function buildPrompt({ date, place, text } = {}) {
  const hints = [
    date ? `Taken: ${String(date).slice(0, 10)}.` : '',
    place ? `Near: ${String(place).slice(0, 60)}.` : '',
    text ? `Text the phone could already read in it: "${String(text).slice(0, 300)}".` : ''
  ].filter(Boolean).join(' ');
  return hints ? `${PROMPT}\n\n${hints}` : PROMPT;
}

async function describePhoto({ generate, image, mimeType = 'image/jpeg', context = {} }) {
  if (!image || !image.length) return { skipped: true, reason: 'empty' };
  if (image.length > MAX_BYTES) return { skipped: true, reason: 'too_large' };
  const res = await generate({
    contents: [{ role: 'user', parts: [{ text: buildPrompt(context) }, { inlineData: { mimeType, data: Buffer.from(image).toString('base64') } }] }],
    config: { maxOutputTokens: 400, reasoningEffort: 'low' }
  });
  const text = String(res?.text || '').replace(/\s+/g, ' ').trim();
  if (!text || /^skip\b/i.test(text)) return { skipped: true, reason: 'sensitive_or_empty' };
  return { note: text, date: context.date || null };
}

module.exports = { describePhoto, buildPrompt, MAX_BYTES };
